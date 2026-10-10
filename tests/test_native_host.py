import base64
import hashlib
import io
import json
import os
import queue
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native import native_host


def request(pcm=b"\x00\x00" * 16000):
    words = [
        {"wordId": "w1", "phraseId": "p1", "laneId": "lead", "text": "hello"},
        {"wordId": "w2", "phraseId": "p1", "laneId": "lead", "text": "world"},
    ]
    return {
        "version": native_host.PROTOCOL,
        "type": "analyze",
        "requestId": "request-1",
        "sessionId": "session-1",
        "source": {"tabId": 12, "mediaKey": "media-1", "lyricsHash": "a" * 64, "expectedRevision": 4, "captureEpoch": 2},
        "audio": {"encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1, "durationMs": 1000,
                  "audioStartMs": 5000, "playbackRate": 1, "pcmBase64": base64.b64encode(pcm).decode("ascii"),
                  "sha256": hashlib.sha256(pcm).hexdigest()},
        "expectedWords": words,
    }


class NativeHostProtocolTests(unittest.TestCase):
    def test_frames_roundtrip_utf8_json(self):
        encoded = io.BytesIO()
        native_host.write_frame(encoded, {"text": "héllo"})
        encoded.seek(0)
        self.assertEqual(native_host.read_frame(encoded), {"text": "héllo"})
        self.assertIsNone(native_host.read_frame(encoded))

    def test_frames_reject_oversize_and_truncated_payloads(self):
        with self.assertRaises(native_host.ProtocolError):
            native_host.read_frame(io.BytesIO(struct.pack("<I", 5) + b"{}"))
        with self.assertRaises(native_host.ProtocolError):
            native_host.read_frame(io.BytesIO(struct.pack("<I", 11)), max_bytes=10)

    def test_analysis_validates_source_pcm_digest_and_maps_only_supplied_word_ids(self):
        context, pcm, transcript = native_host.validate_analysis(request())
        self.assertEqual(len(pcm), 32000)
        self.assertEqual(transcript, "hello world")
        result = native_host.format_result(context, {
            "alignmentKind": "supplied-text-ctc", "adapter": "adapter", "model": "model", "modelRevision": "sha256:abc",
            "words": [{"wordIndex": 1, "startMs": 300, "endMs": 700}, {"wordIndex": 100, "startMs": 701, "endMs": 900}],
            "warnings": ["review only"],
        })
        self.assertEqual(result["accepted"], False)
        self.assertEqual(result["automaticAdmissionEnabled"], False)
        self.assertEqual(result["words"], [{"wordId": "w2", "startMs": 300, "endMs": 700}])
        self.assertEqual(result["source"], context["source"])
        self.assertEqual(result["audio"]["audioStartMs"], 5000)

    def test_result_preserves_bounded_greedy_diagnostics_separately_from_word_timing(self):
        context, _, _ = native_host.validate_analysis(request())
        aligned = {
            "alignmentKind": "supplied-text-ctc", "adapter": "adapter", "model": "model", "modelRevision": "sha256:abc",
            "words": [{"wordIndex": 1, "startMs": 300, "endMs": 700}],
            "warnings": [
                "No CTC frames were assigned to supplied word 'world'; that region is unsupported.",
                "The English model is speech-trained; singing, backing vocals, and overlapping voices are unvalidated.",
            ],
            "diagnostics": {"greedyConsistency": {
                "method": "same-model-greedy-vs-forced-ctc", "calibrated": False,
                "wordCount": 2, "greedyWordCount": 3, "matchedWordFraction": 0.5,
                "words": [
                    {"wordIndex": 1, "forcedFrameCount": 20, "greedyTop1FrameFraction": 0.75, "meanForcedLogProb": -2.25},
                    {"wordIndex": 0, "forcedFrameCount": 0, "greedyTop1FrameFraction": None, "meanForcedLogProb": None},
                ],
                "greedyTranscript": "must not be copied",
            }},
        }
        result = native_host.format_result(context, aligned)
        self.assertEqual(result["words"], [{"wordId": "w2", "startMs": 300, "endMs": 700}])
        self.assertEqual(result["diagnostics"]["greedyConsistency"], {
            "method": "same-model-greedy-vs-forced-ctc", "calibrated": False,
            "wordCount": 2, "greedyWordCount": 3, "matchedWordFraction": 0.5,
            "words": [
                {"wordId": "w2", "forcedFrameCount": 20, "greedyTop1FrameFraction": 0.75, "meanForcedLogProb": -2.25},
                {"wordId": "w1", "forcedFrameCount": 0, "greedyTop1FrameFraction": None, "meanForcedLogProb": None},
            ],
        })
        self.assertNotIn("greedyTranscript", json.dumps(result))
        self.assertNotIn("world", json.dumps(result))
        self.assertEqual(result["warnings"], [
            "One or more supplied words had no assigned CTC frames; those regions are unsupported.",
            "The English model is speech-trained; singing, backing vocals, and overlapping voices are unvalidated.",
        ])
        self.assertFalse(result["accepted"])
        self.assertFalse(result["automaticAdmissionEnabled"])

    def test_result_preserves_only_known_silent_audio_reason_and_exact_static_warnings(self):
        context, _, _ = native_host.validate_analysis(request())
        aligned = {
            "alignmentKind": "supplied-text-ctc", "adapter": "adapter", "model": "model", "modelRevision": "sha256:abc",
            "words": [], "reasonCode": "SILENT_AUDIO",
            "warnings": [
                "SILENT_AUDIO: every input sample is exactly zero, so no word intervals were emitted.",
                "This exact-zero gate does not classify near-silence or other low-energy audio.",
            ],
        }
        result = native_host.format_result(context, aligned)
        self.assertEqual(result["reasonCode"], "SILENT_AUDIO")
        self.assertEqual(result["words"], [])
        self.assertEqual(result["warnings"], aligned["warnings"])

        aligned["reasonCode"] = "UNTRUSTED: hello world"
        aligned["warnings"].append("UNTRUSTED: hello world")
        result = native_host.format_result(context, aligned)
        self.assertNotIn("reasonCode", result)
        self.assertEqual(result["warnings"], [
            "SILENT_AUDIO: every input sample is exactly zero, so no word intervals were emitted.",
            "This exact-zero gate does not classify near-silence or other low-energy audio.",
        ])
        self.assertNotIn("UNTRUSTED", json.dumps(result))

    def test_malformed_greedy_sidecar_is_dropped_without_changing_proposals(self):
        context, _, _ = native_host.validate_analysis(request())
        aligned = {
            "alignmentKind": "supplied-text-ctc", "adapter": "adapter", "model": "model", "modelRevision": "sha256:abc",
            "words": [{"wordIndex": 0, "startMs": 100, "endMs": 250}], "warnings": [],
            "diagnostics": {"greedyConsistency": {
                "method": "same-model-greedy-vs-forced-ctc", "calibrated": False,
                "wordCount": 2, "greedyWordCount": 2, "matchedWordFraction": float("nan"),
                "words": [{"wordIndex": 0, "forcedFrameCount": 20, "greedyTop1FrameFraction": 1.5, "meanForcedLogProb": -2}],
            }},
        }
        result = native_host.format_result(context, aligned)
        self.assertEqual(result["words"], [{"wordId": "w1", "startMs": 100, "endMs": 250}])
        self.assertNotIn("diagnostics", result)

    def test_analysis_rejects_checksum_duration_and_duplicate_id_mismatch(self):
        bad = request()
        bad["audio"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(native_host.ProtocolError, "checksum"):
            native_host.validate_analysis(bad)
        bad = request()
        bad["audio"]["durationMs"] = 2000
        with self.assertRaisesRegex(native_host.ProtocolError, "sample count"):
            native_host.validate_analysis(bad)
        bad = request()
        bad["expectedWords"][1]["wordId"] = "w1"
        with self.assertRaisesRegex(native_host.ProtocolError, "unique IDs"):
            native_host.validate_analysis(bad)

    def test_curly_apostrophe_is_normalized_for_aligner_but_preserved_in_binding(self):
        body = request()
        body["expectedWords"][0]["text"] = "can’t"
        context, _, transcript = native_host.validate_analysis(body)
        self.assertEqual(transcript, "can't world")
        self.assertEqual(context["expectedWords"][0]["text"], "can’t")
        body["expectedWords"][0]["text"] = "can''t"
        with self.assertRaisesRegex(native_host.ProtocolError, "at most one interior apostrophe"):
            native_host.validate_analysis(body)

    def test_pcm_limit_is_enforced_before_worker_dispatch(self):
        bad = request(b"\x00\x00" * (native_host.MAX_PCM_BYTES // 2 + 1))
        bad["audio"]["durationMs"] = native_host.MAX_AUDIO_MS + 1
        with self.assertRaisesRegex(native_host.ProtocolError, "protocol limits"):
            native_host.validate_analysis(bad)

    def test_host_sends_greeting_then_answers_extension_hello(self):
        incoming = io.BytesIO()
        native_host.write_frame(incoming, {"version": native_host.PROTOCOL, "type": "hello"})
        incoming.seek(0)
        outgoing = io.BytesIO()
        origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
        with patch.object(native_host, "_registered_origin", return_value=origin), patch.object(native_host, "_readiness", return_value=(True, "ready")):
            self.assertEqual(native_host.run_host(incoming, outgoing, ["host", origin]), 0)
        outgoing.seek(0)
        first = native_host.read_frame(outgoing)
        second = native_host.read_frame(outgoing)
        self.assertEqual(first["type"], "hello")
        self.assertEqual(second["type"], "hello")

    def test_installed_manifest_binds_one_exact_extension_origin(self):
        with tempfile.TemporaryDirectory() as temp:
            manifest_dir = Path(temp) / "LyricVibe" / "NativeMessaging"
            manifest_dir.mkdir(parents=True)
            manifest_path = manifest_dir / f"{native_host.HOST_NAME}.json"
            origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
            manifest_path.write_text(json.dumps({"name": native_host.HOST_NAME, "type": "stdio", "allowed_origins": [origin]}), encoding="utf-8")
            with patch.dict(os.environ, {"LOCALAPPDATA": temp}):
                self.assertEqual(native_host._registered_origin(), origin)
                self.assertTrue(native_host._caller_is_allowed(["host", origin], origin))
                self.assertFalse(native_host._caller_is_allowed(["host", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], origin))
                manifest_path.write_text(json.dumps({"name": native_host.HOST_NAME, "type": "stdio", "allowed_origins": ["chrome-extension://*/"]}), encoding="utf-8")
                self.assertIsNone(native_host._registered_origin())

    def test_worker_output_is_drained_with_a_hard_cap(self):
        class FakeProcess:
            def __init__(self):
                self.stdout = io.BytesIO(b"x" * (native_host.MAX_FRAME_BYTES + 100))
                self.returncode = None
                self.terminated = False

            def poll(self):
                return self.returncode

            def terminate(self):
                self.terminated = True
                self.returncode = -15

            def wait(self, timeout=None):
                return self.returncode

        process = FakeProcess()
        done = queue.Queue(maxsize=1)
        thread = threading.Thread(target=native_host._drain_worker_output, args=(process, done))
        thread.start()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        finished, output, return_code = done.get_nowait()
        self.assertIs(finished, process)
        self.assertEqual(len(output), native_host.MAX_FRAME_BYTES + 1)
        self.assertTrue(process.terminated)
        self.assertEqual(return_code, -15)

    def test_worker_main_emits_valid_json_and_exits_zero_after_alignment(self):
        pcm = b"\x01\x00" * 16000
        payload = json.dumps({"pcmBase64": base64.b64encode(pcm).decode("ascii"), "text": "hello"}) + "\n"
        input_stream = io.TextIOWrapper(io.BytesIO(payload.encode("utf-8")))
        output_buffer = io.BytesIO()
        output_stream = io.TextIOWrapper(output_buffer, encoding="utf-8")
        aligned = {"alignmentKind": "supplied-text-ctc", "words": [{"wordIndex": 0, "startMs": 1, "endMs": 400}]}
        fake_alignment = SimpleNamespace(align_samples=lambda received_pcm, text, sample_rate_hz, language: aligned)
        with patch.object(native_host.sys, "stdin", input_stream), patch.object(native_host.sys, "stdout", output_stream), \
                patch.dict(sys.modules, {"alignment": fake_alignment}):
            exit_code = native_host._worker_main()
        self.assertEqual(exit_code, 0)
        output_stream.flush()
        self.assertEqual(json.loads(output_buffer.getvalue().decode("utf-8")), aligned)


if __name__ == "__main__":
    unittest.main()
