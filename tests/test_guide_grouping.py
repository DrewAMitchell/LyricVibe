import copy
import unittest

from native.guide_grouping import (
    GuideGroupingError,
    apply_operation,
    load_review,
    preview,
)


HASH = "a" * 64


def phrase_words():
    return [
        {"id": "word-go", "text": "go", "startMs": 1000, "endMs": 1800, "locked": False, "syllables": []},
        {
            "id": "word-hello", "text": "hello", "startMs": 1800, "endMs": 2800, "locked": False,
            "syllables": [
                {"id": "hello-syl-1", "text": "hel", "startMs": 1800, "endMs": 2300, "locked": False},
                {"id": "hello-syl-2", "text": "lo", "startMs": 2300, "endMs": 2800, "locked": False},
            ],
        },
        {"id": "word-crumble", "text": "crumble", "startMs": 2800, "endMs": 3400, "locked": False, "syllables": []},
        {"id": "word-unknown", "text": "blorfq", "startMs": 3400, "endMs": 4000, "locked": False, "syllables": []},
        {"id": "word-locked", "text": "yes", "startMs": 4000, "endMs": 4600, "locked": True, "syllables": []},
    ]


def package_fixture():
    return {
        "version": "lyricvibe.review.v1",
        "score": {
            "version": "lyricvibe.score.v1", "revision": 7, "offsetMs": 0,
            "source": {"platform": "youtube", "videoId": "video-1", "durationMs": 10_000},
            "lanes": [{"id": "lead", "role": "lead"}],
            "phrases": [{"id": "phrase-1", "laneId": "lead", "startMs": 900, "endMs": 4200, "words": phrase_words()}],
        },
        "receipt": {"expectedRevision": 7, "mediaKey": "youtube:video-1", "lyricsHash": "b" * 64},
        "audio": {"name": "fixture.mp4", "durationMs": 10_000, "sizeBytes": 10, "sha256": HASH},
        "waveform": {"sampleRate": 8000, "bucketMs": 100, "peaks": [0.0]},
    }


def session_fixture():
    taps = [
        {"ordinal": 1, "guideTimeMs": 150, "approximateSourceMs": 1100, "kind": "manual-syllable-change", "unitId": None, "withinTapOrdinal": None, "calibrated": False},
        {"ordinal": 2, "guideTimeMs": 300, "approximateSourceMs": 1250, "kind": "manual-note-change", "unitId": None, "withinTapOrdinal": 1, "calibrated": False},
        {"ordinal": 3, "guideTimeMs": 500, "approximateSourceMs": 1450, "kind": "manual-syllable-onset", "unitId": None, "withinTapOrdinal": None, "calibrated": False},
        {"ordinal": 4, "guideTimeMs": 700, "approximateSourceMs": 1650, "kind": "manual-note-change", "unitId": None, "withinTapOrdinal": 3, "calibrated": False},
    ]
    return {
        "version": "lyricvibe.guide-session.v1",
        "source": {"platform": "youtube", "videoId": "video-1", "durationMs": 10_000},
        "sourceSha256": HASH,
        "scoreRevision": 7,
        "phraseId": "phrase-1",
        "clipStartMs": 1000,
        "guideDelayMs": 50,
        "captureStatus": {"durationMs": 1000},
        "taps": taps,
        "events": [],
    }


def load_fixture():
    return load_review(package_fixture(), session_fixture())


def op(state, kind, tap_ordinal, **fields):
    return apply_operation(state, state["reviewRevision"], {"type": kind, "tapOrdinal": tap_ordinal, **fields})


class GuideGroupingTests(unittest.TestCase):
    def test_load_binds_video_audio_revision_phrase_and_unassigned_taps(self):
        state = load_fixture()
        self.assertEqual(state["source"], {"videoId": "video-1", "audioSha256": HASH, "scoreRevision": 7, "phraseId": "phrase-1"})
        self.assertEqual([tap["assignmentStatus"] for tap in state["taps"]], ["unreviewed"] * 4)
        self.assertEqual(state["taps"][0]["unitId"], None)
        self.assertEqual(state["taps"][0]["sourceTimeEstimateMs"], 1100)

    def test_source_revision_phrase_and_estimated_clock_mismatches_fail_closed(self):
        for mutate, code in (
            (lambda p, s: s["source"].update(videoId="other"), "SOURCE_MISMATCH"),
            (lambda p, s: p["audio"].update(sha256="c" * 64), "SOURCE_MISMATCH"),
            (lambda p, s: s.update(scoreRevision=8), "REVISION_MISMATCH"),
            (lambda p, s: s.update(phraseId="missing"), "PHRASE_MISMATCH"),
            (lambda p, s: s["taps"][0].update(approximateSourceMs=1099), "INVALID_SESSION_CLOCK"),
        ):
            package, session = package_fixture(), session_fixture()
            mutate(package, session)
            with self.subTest(code=code), self.assertRaises(GuideGroupingError) as raised:
                load_review(package, session)
            self.assertEqual(raised.exception.code, code)

    def test_rejects_audio_payloads_preassigned_and_unrecognized_taps(self):
        session = session_fixture()
        session["pcmBase64"] = "AA=="
        with self.assertRaises(GuideGroupingError) as raised:
            load_review(package_fixture(), session)
        self.assertEqual(raised.exception.code, "AUDIO_PAYLOAD_FORBIDDEN")

        session = session_fixture()
        session["taps"][0]["unitId"] = "word-go"
        with self.assertRaises(GuideGroupingError) as raised:
            load_review(package_fixture(), session)
        self.assertEqual(raised.exception.code, "PREASSIGNED_TAP")

        session = session_fixture()
        session["taps"][0]["kind"] = "automatic-syllable"
        with self.assertRaises(GuideGroupingError) as raised:
            load_review(package_fixture(), session)
        self.assertEqual(raised.exception.code, "INVALID_TAPS")

    def test_units_use_existing_syllables_or_unambiguous_monosyllables_only(self):
        state = load_fixture()
        units = state["units"]
        self.assertEqual([(u["unitId"], u["kind"], u["status"]) for u in units], [
            ("word-go", "whole-word", "available"),
            ("hello-syl-1", "syllable", "available"),
            ("hello-syl-2", "syllable", "available"),
            (None, "unavailable", "unavailable"),
            (None, "unavailable", "unavailable"),
            ("word-locked", "whole-word", "blocked"),
        ])
        self.assertEqual(units[3]["reason"], "syllable-segmentation-required")
        self.assertEqual(units[4]["reason"], "ambiguous-or-unknown-pronunciation")
        self.assertEqual(units[5]["reason"], "word-locked")
        self.assertNotIn("text", repr(state).casefold())

    def test_multisyllable_word_requires_explicit_word_scope_and_extra_taps_stay_unassigned(self):
        state = load_fixture()
        word_unit = next(item for item in state["wordUnits"] if item["parentWordId"] == "word-crumble")
        self.assertEqual(word_unit["kind"], "word")
        self.assertEqual(word_unit["status"], "available")
        self.assertFalse(any(item.get("unitId") == "word-crumble" for item in state["units"]))

        state = op(state, "assignWordEntrance", 1, wordId="word-crumble")
        result = preview(state)
        self.assertEqual(result["groups"][0]["unitKind"], "word")
        self.assertEqual(result["groups"][0]["parentWordId"], "word-crumble")
        self.assertIsNone(result["groups"][0]["syllableId"])
        self.assertEqual(result["taps"][1]["assignmentStatus"], "unreviewed")
        self.assertEqual(result["taps"][2]["assignmentStatus"], "unreviewed")

        state = op(state, "assignNote", 2)
        result = preview(state)
        self.assertEqual(result["taps"][1]["assignmentStatus"], "note")
        self.assertEqual(result["taps"][1]["parentTapOrdinal"], 1)
        self.assertEqual(result["taps"][2]["assignmentStatus"], "unreviewed")

    def test_virtual_word_key_collision_with_any_score_unit_is_rejected(self):
        package = package_fixture()
        package["score"]["phrases"].append({
            "id": "phrase-2", "laneId": "lead", "startMs": 5000, "endMs": 6000,
            "words": [{
                "id": "another-word", "text": "go", "startMs": 5000, "endMs": 6000,
                "syllables": [{
                    "id": "@word:word-go", "text": "go", "startMs": 5000, "endMs": 6000,
                }],
            }],
        })
        with self.assertRaises(GuideGroupingError) as raised:
            load_review(package, session_fixture())
        self.assertEqual(raised.exception.code, "RESERVED_UNIT_COLLISION")

    def test_virtual_word_key_allows_distinct_string_ids_with_reserved_prefix(self):
        package = package_fixture()
        package["score"]["phrases"][0]["words"][0]["id"] = "@word:another-word"
        state = load_review(package, session_fixture())
        self.assertEqual(state["wordUnits"][0]["unitId"], "@word:@word:another-word")
        self.assertEqual(state["wordUnits"][0]["parentWordId"], "@word:another-word")

    def test_explicit_entrance_assignments_drive_groups_and_note_taps_do_not_advance(self):
        state = load_fixture()
        original = copy.deepcopy(state)
        state = op(state, "assignWordEntrance", 1, wordId="word-go")
        state = op(state, "assignNote", 2)
        state = op(state, "assignEntrance", 3, unitId="hello-syl-1")
        result = preview(state)

        self.assertEqual(original["reviewRevision"], 0)
        self.assertEqual([group["tapOrdinal"] for group in result["groups"]], [1, 3])
        self.assertEqual(result["groups"][0]["endMs"], 1450)
        self.assertEqual(result["groups"][0]["endSource"], "next-confirmed-entrance")
        self.assertEqual(result["groups"][0]["noteTapOrdinals"], [2])
        self.assertTrue(result["groups"][0]["provisional"])
        self.assertEqual(result["resolvedUnitIds"], ["@word:word-go", "hello-syl-1"])
        self.assertTrue(result["groups"][1]["requiresRelease"])
        self.assertEqual(result["groups"][1]["endMs"], None)
        self.assertEqual(result["nextUnitId"], "hello-syl-2")
        self.assertEqual(result["closedUnits"], [{"wordId": "word-go", "syllableId": None, "unitId": "@word:word-go", "unitKind": "word", "startMs": 1100, "endMs": 1450}])
        self.assertNotIn("text", repr(result).casefold())

    def test_note_parent_can_be_explicit_or_nearest_preceding_and_never_crosses_entrance(self):
        state = load_fixture()
        state = op(state, "assignWordEntrance", 1, wordId="word-go")
        state = op(state, "assignEntrance", 3, unitId="hello-syl-1")
        with self.assertRaises(GuideGroupingError) as crossed:
            op(state, "assignNote", 4, parentTapOrdinal=1)
        self.assertEqual(crossed.exception.code, "NOTE_OUTSIDE_GROUP")

        # Tap 2 carries the explicit parent from the session; it remains in the first group.
        state = op(state, "assignNote", 2)
        self.assertEqual(preview(state)["taps"][1]["parentTapOrdinal"], 1)

    def test_inserting_entrance_cannot_split_an_already_assigned_note_group(self):
        session = session_fixture()
        session["taps"][1]["kind"] = "manual-syllable-onset"
        session["taps"][1]["withinTapOrdinal"] = None
        session["taps"][2]["kind"] = "manual-note-change"
        session["taps"][2]["withinTapOrdinal"] = 1
        state = load_review(package_fixture(), session)
        state = op(state, "assignWordEntrance", 1, wordId="word-go")
        state = op(state, "assignNote", 3, parentTapOrdinal=1)
        with self.assertRaises(GuideGroupingError) as crossed:
            op(state, "assignEntrance", 2, unitId="hello-syl-1")
        self.assertEqual(crossed.exception.code, "NOTE_SCOPE_CONFLICT")

        # A malformed imported state remains visibly blocked and cannot produce a closed interval.
        corrupted = copy.deepcopy(state)
        tap_two = next(tap for tap in corrupted["taps"] if tap["ordinal"] == 2)
        tap_two.update({"assignmentStatus": "entrance", "unitId": "hello-syl-1", "unitKind": "syllable"})
        result = preview(corrupted)
        self.assertIn("note-outside-group", result["groups"][0]["blockers"])
        self.assertEqual(result["closedUnits"], [])

        # A legacy note with no saved parent uses only the nearest preceding confirmed entrance.
        session = session_fixture()
        session["taps"][1]["kind"] = "manual-syllable-change"
        session["taps"][1]["withinTapOrdinal"] = None
        state = load_review(package_fixture(), session)
        state = op(state, "assignWordEntrance", 1, wordId="word-go")
        state = op(state, "assignNote", 2)
        self.assertEqual(preview(state)["taps"][1]["parentTapOrdinal"], 1)

    def test_revision_conflict_clear_ignore_and_repeat_unit_rejections(self):
        state = load_fixture()
        with self.assertRaises(GuideGroupingError) as stale:
            apply_operation(state, 1, {"type": "ignore", "tapOrdinal": 1})
        self.assertEqual(stale.exception.code, "REVISION_CONFLICT")
        state = op(state, "assignWordEntrance", 1, wordId="word-go")
        with self.assertRaises(GuideGroupingError) as duplicate:
            op(state, "assignWordEntrance", 3, wordId="word-go")
        self.assertEqual(duplicate.exception.code, "WORD_ALREADY_ASSIGNED")
        with self.assertRaises(GuideGroupingError) as entrance_reassigned:
            op(state, "assignNote", 1)
        self.assertEqual(entrance_reassigned.exception.code, "TAP_ALREADY_ASSIGNED")
        state = op(state, "ignore", 3)
        self.assertEqual(preview(state)["taps"][2]["assignmentStatus"], "ignored")
        state = op(state, "clear", 3)
        self.assertEqual(preview(state)["taps"][2]["assignmentStatus"], "unreviewed")

    def test_locked_and_out_of_phrase_groups_are_blocked_instead_of_proposed(self):
        state = load_fixture()
        state = op(state, "assignWordEntrance", 1, wordId="word-locked")
        result = preview(state)
        self.assertEqual(result["groups"][0]["blockers"], ["word-locked"])
        self.assertEqual(result["closedUnits"], [])

        # A tap can be explicitly reviewed even when its uncalibrated estimate is outside the phrase.
        package = package_fixture()
        package["score"]["phrases"][0]["startMs"] = 1500
        session = session_fixture()
        state = load_review(package, session)
        state = op(state, "assignWordEntrance", 1, wordId="word-go")
        self.assertIn("entrance-outside-phrase", preview(state)["groups"][0]["blockers"])

    def test_typed_release_closes_only_final_group_with_phrase_bounded_interval(self):
        state = load_fixture()
        state = op(state, "assignWordEntrance", 1, wordId="word-go")
        state = op(state, "assignNote", 2)
        with self.assertRaises(GuideGroupingError) as before_start:
            op(state, "setRelease", 1, endMs=1200)
        self.assertEqual(before_start.exception.code, "INVALID_RELEASE")
        state = op(state, "setRelease", 1, endMs=1300)
        result = preview(state)
        self.assertFalse(result["groups"][0]["requiresRelease"])
        self.assertEqual(result["groups"][0]["endSource"], "typed-release")
        self.assertEqual(result["closedUnits"][0]["endMs"], 1300)


if __name__ == "__main__":
    unittest.main()
