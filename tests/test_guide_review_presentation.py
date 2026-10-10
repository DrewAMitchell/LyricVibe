"""Tk-free checks for the guide review's asynchronous playback state seam."""
from __future__ import annotations

import threading
import unittest

from native.guide_review import GuideReview


class _Status:
    def __init__(self):
        self.value = None

    def set(self, value):
        self.value = value


def _review(epoch=4, stopped=False):
    review = GuideReview.__new__(GuideReview)
    review.play_epoch = epoch
    review.play_stop = threading.Event()
    if stopped:
        review.play_stop.set()
    review.playback_clock = None
    review.playback_state = "stopped"
    review.status = _Status()
    review.states = []
    review.set_playback_state = review.states.append
    return review


class GuideReviewPresentationTests(unittest.TestCase):
    def test_current_clock_message_sets_playback_clock_and_state(self):
        review = _review()

        review._handle_playback_message(("clock", 4, 12_345, 88.25))

        self.assertEqual(review.playback_clock, (12_345, 88.25))
        self.assertEqual(review.states, ["playing"])

    def test_clock_message_is_ignored_after_stop_request(self):
        review = _review(stopped=True)

        review._handle_playback_message(("clock", 4, 12_345, 88.25))

        self.assertIsNone(review.playback_clock)
        self.assertEqual(review.states, [])

    def test_stale_epoch_messages_cannot_change_current_playback(self):
        review = _review()
        review.playback_clock = (20_000, 91.0)
        review._handle_playback_message(("clock", 3, 12_345, 88.25))
        review._handle_playback_message(("stopped", 3))
        review._handle_playback_message(("failed", 3, "old failure"))

        self.assertEqual(review.playback_clock, (20_000, 91.0))
        self.assertEqual(review.states, [])
        self.assertIsNone(review.status.value)

    def test_stopped_message_clears_clock_and_state(self):
        review = _review()
        review.playback_clock = (12_345, 88.25)

        review._handle_playback_message(("stopped", 4))

        self.assertIsNone(review.playback_clock)
        self.assertEqual(review.states, ["stopped"])

    def test_failure_message_clears_clock_and_exposes_recovery_message(self):
        review = _review()
        review.playback_clock = (12_345, 88.25)

        review._handle_playback_message(("failed", 4, "Check the recording and output device."))

        self.assertIsNone(review.playback_clock)
        self.assertEqual(review.states, ["failed"])
        self.assertEqual(review.status.value, "Check the recording and output device.")


if __name__ == "__main__":
    unittest.main()
