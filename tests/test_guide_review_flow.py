"""Tests for review-stage and focus derivation from numeric previews."""
import copy
import unittest

from native.guide_review_flow import derive_review_flow


def tap(ordinal, status="unreviewed", blockers=None):
    return {"ordinal": ordinal, "assignmentStatus": status, "blockers": blockers or []}


def group(ordinal=1, *, release=False, end=500, blockers=None):
    return {
        "tapOrdinal": ordinal, "unitId": "@word:word-1", "parentWordId": "word-1",
        "startMs": 100, "endMs": end, "requiresRelease": release,
        "blockers": blockers or [], "noteTapOrdinals": [2],
    }


def snapshot(taps=None, groups=None, closed=None):
    return {"taps": taps or [], "groups": groups or [], "closedUnits": closed or []}


class GuideReviewFlowTests(unittest.TestCase):
    def test_empty_take_has_explicit_empty_phase(self):
        flow = derive_review_flow(snapshot())
        self.assertEqual(flow["phase"], "empty")
        self.assertIsNone(flow["currentTapOrdinal"])
        self.assertFalse(flow["previewReady"])

    def test_review_focus_keeps_manual_selection_and_reports_next_unresolved(self):
        flow = derive_review_flow(snapshot(
            [tap(1, "entrance"), tap(2), tap(3, "ignored")], [group()],
        ), selectedOrdinal=3)
        self.assertEqual(flow["phase"], "review")
        self.assertEqual(flow["currentTapOrdinal"], 3)
        self.assertEqual(flow["nextUnresolvedTapOrdinal"], 2)
        self.assertEqual(flow["reviewed"], 2)
        self.assertEqual(flow["activeGroup"], {
            "tapOrdinal": 1, "unitId": "@word:word-1", "parentWordId": "word-1",
            "startMs": 100, "endMs": 500, "requiresRelease": False,
            "blocked": False, "noteTapOrdinals": [2], "noteTapCount": 1,
        })

    def test_release_phase_targets_pending_final_group(self):
        flow = derive_review_flow(snapshot(
            [tap(1, "entrance"), tap(2, "note")], [group(release=True, end=None)],
        ))
        self.assertEqual(flow["phase"], "release")
        self.assertEqual(flow["reviewed"], 2)
        self.assertEqual(flow["releaseTapOrdinal"], 1)
        self.assertFalse(flow["previewReady"])

    def test_ready_requires_closed_group_and_no_unresolved_taps(self):
        flow = derive_review_flow(snapshot(
            [tap(1, "entrance"), tap(2, "note")], [group()], [{"startMs": 100, "endMs": 500}],
        ), selectedOrdinal=1)
        self.assertEqual(flow["phase"], "ready")
        self.assertTrue(flow["previewReady"])
        self.assertIsNone(flow["nextUnresolvedTapOrdinal"])

    def test_blocker_is_plain_language_and_points_to_tap(self):
        flow = derive_review_flow(snapshot(
            [tap(1, "entrance", ["word-locked"]), tap(2)], [group(blockers=["word-locked"])],
        ), selectedOrdinal=2)
        self.assertEqual(flow["phase"], "review")
        self.assertEqual(flow["nextUnresolvedTapOrdinal"], 1)
        self.assertEqual(flow["blocker"]["tapOrdinal"], 1)
        self.assertEqual(flow["blocker"]["kind"], "locked-unit")
        self.assertIn("Choose an unlocked", flow["blocker"]["recovery"])
        self.assertNotIn("word-locked", str(flow["blocker"]))

    def test_all_ignored_take_explains_missing_closeable_group(self):
        flow = derive_review_flow(snapshot([tap(1, "ignored")]))
        self.assertEqual(flow["phase"], "review")
        self.assertEqual(flow["blocker"]["kind"], "no-closeable-group")

    def test_snapshot_is_never_mutated(self):
        value = snapshot([tap(1)], [group(release=True, end=None)])
        before = copy.deepcopy(value)
        derive_review_flow(value)
        self.assertEqual(value, before)


if __name__ == "__main__":
    unittest.main()
