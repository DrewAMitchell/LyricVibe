import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import native.mfa_adapter as adapter
from native.mfa_adapter import MFAError, parse_alignment_json


def fixture(words=None, phones=None):
    tiers = {"words": {"type": "interval", "entries": words or [[0.1, 0.4, "Take"], [0.4, 0.9, "WHAT!"]]}}
    if phones is not None:
        tiers["phones"] = {"type": "interval", "entries": phones}
    return json.dumps({"start": 0, "end": 1, "tiers": tiers})


class MFAJsonParserTests(unittest.TestCase):
    def test_maps_complete_word_tier_by_supplied_ordinal_and_discards_phone_labels(self):
        result = parse_alignment_json(
            fixture(phones=[[0.1, 0.2, "T"], [0.2, 0.4, "EY1"]]), "take what", 1.0
        )
        self.assertEqual(result["words"], [
            {"wordIndex": 0, "startMs": 100, "endMs": 400},
            {"wordIndex": 1, "startMs": 400, "endMs": 900},
        ])
        self.assertEqual(result["phones"], [{"startMs": 100, "endMs": 200}, {"startMs": 200, "endMs": 400}])
        self.assertNotIn("Take", repr(result))

    def test_accepts_single_speaker_prefixed_mfa_tier_names(self):
        body = json.loads(fixture())
        body["tiers"] = {"speaker - words": body["tiers"]["words"]}
        result = parse_alignment_json(json.dumps(body), "take what", 1.0)
        self.assertEqual(len(result["words"]), 2)

    def test_rejects_missing_split_or_reordered_words(self):
        for words in (
            [[0.1, 0.4, "Take"]],
            [[0.1, 0.4, "Take"], [0.4, 0.9, "What"], [0.9, 0.99, "Extra"]],
            [[0.1, 0.4, "What"], [0.4, 0.9, "Take"]],
        ):
            with self.subTest(words=words), self.assertRaises(MFAError) as caught:
                parse_alignment_json(fixture(words=words), "take what", 1.0)
            self.assertEqual(caught.exception.code, "MFA_TOKEN_MISMATCH")

    def test_drops_only_valid_silence_entries_when_complete_word_sequence_matches(self):
        words = [[0.1, 0.4, "Take"], [0.4, 0.45, "<eps>"], [0.5, 0.9, "WHAT!"]]
        result = parse_alignment_json(fixture(words=words), "take what", 1.0)
        self.assertEqual(result["ignoredSilenceWordCount"], 1)
        self.assertEqual([item["wordIndex"] for item in result["words"]], [0, 1])
        self.assertNotIn("eps", repr(result))

    def test_rejects_non_silence_noise_tokens_as_extra_words(self):
        words = [[0.1, 0.4, "Take"], [0.4, 0.45, "spn"], [0.5, 0.9, "WHAT!"]]
        with self.assertRaises(MFAError) as caught:
            parse_alignment_json(fixture(words=words), "take what", 1.0)
        self.assertEqual(caught.exception.code, "MFA_TOKEN_MISMATCH")

    def test_rejects_bad_json_bounds_and_nonfinite_times(self):
        with self.assertRaises(MFAError):
            parse_alignment_json(b"{}", "take what", 1.0)
        for words in (
            [[0.5, 0.4, "Take"], [0.5, 0.9, "What"]],
            [[0.1, 0.4, "Take"], [0.3, 0.9, "What"]],
            [[0.1, float("nan"), "Take"], [0.4, 0.9, "What"]],
            [[0.1, 0.4, "Take"], [0.4, 1.2, "What"]],
        ):
            with self.subTest(words=words), self.assertRaises(MFAError):
                parse_alignment_json(fixture(words=words), "take what", 1.0)

    def test_rejects_oversized_payload(self):
        with self.assertRaises(MFAError) as caught:
            parse_alignment_json(b" " * (2_000_001), "take", 1.0)
        self.assertEqual(caught.exception.code, "MFA_INVALID_OUTPUT")


class MFARuntimeContractTests(unittest.TestCase):
    def test_align_uses_explicit_paths_and_records_bounded_lifecycle(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            audio = root / "clip.wav"
            with wave.open(str(audio), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16_000)
                wav.writeframes(b"\0\0" * 16_000)
            environment = root / "env"
            environment.mkdir()
            executable = environment / "Scripts" / "mfa.exe"
            executable.parent.mkdir()
            dictionary = root / "english.dict"
            acoustic = root / "english.zip"
            runtime = root / "mfa-root"
            micromamba = root / "micromamba.exe"
            mamba_root = root / "mamba-root"
            mamba_root.mkdir()
            for path in (executable, dictionary, acoustic, micromamba):
                path.write_bytes(b"fixture")
            runtime.mkdir()
            captured = {}
            events = []

            class FakeFunction:
                def __init__(self, result=1):
                    self.result = result
                def __call__(self, *args):
                    return self.result

            class FakeProcess:
                pid = 321
                _handle = 1
                _thread = 2
                def __init__(self, argv, **kwargs):
                    captured["argv"] = argv
                    captured["env"] = kwargs["env"]
                    Path(argv[10]).write_text(
                        fixture(), encoding="utf-8"
                    )
                def wait(self, timeout=None):
                    return 0
                def poll(self):
                    return 0
                def kill(self):
                    pass

            class FakeJob:
                def __init__(self):
                    type(self).last_instance = self
                    self.handle = 1
                    self.kernel32 = type("Kernel", (), {
                        "AssignProcessToJobObject": FakeFunction(),
                    })()
                def creation_time_filetime(self, process):
                    return 123456789
                def resume_primary_thread(self, pid):
                    self.resumed_pid = pid
                def close(self):
                    pass

            with patch.object(adapter.os, "name", "nt"), \
                 patch.object(adapter, "_WindowsJob", FakeJob), \
                 patch.object(adapter.subprocess, "Popen", FakeProcess):
                result = adapter.align(
                    audio, "take what", executable=executable,
                    micromamba_executable=micromamba,
                    environment_prefix=environment,
                    dictionary_path=dictionary, acoustic_model_path=acoustic,
                    mfa_root_dir=runtime, mamba_root_prefix=mamba_root,
                    on_lifecycle=events.append,
                )
            self.assertEqual([event["event"] for event in events], ["started", "closed"])
            self.assertEqual(events[0]["pid"], 321)
            self.assertEqual(events[1]["creationTimeFiletime"], 123456789)
            self.assertEqual(events[0]["leaseId"], events[1]["leaseId"])
            self.assertEqual(FakeJob.last_instance.resumed_pid, 321)
            self.assertEqual(captured["env"]["MFA_ROOT_DIR"], str(runtime))
            self.assertEqual(captured["env"]["MAMBA_ROOT_PREFIX"], str(mamba_root))
            self.assertEqual(captured["argv"][1:6], ["run", "-p", str(environment), str(executable), "align_one"])
            self.assertIn("--output_format", captured["argv"])
            self.assertEqual(result["words"][1]["wordIndex"], 1)
            self.assertNotIn("take what", repr(events))


if __name__ == "__main__":
    unittest.main()
