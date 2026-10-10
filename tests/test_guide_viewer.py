import unittest
import queue
import sys
import types
from pathlib import Path
from unittest.mock import patch

from native.guide_viewer import SessionBuffer, RATE


class SessionBufferTests(unittest.TestCase):
    def test_variable_callback_sizes_keep_exact_model_window(self):
        state = SessionBuffer()
        epoch = state.begin(10500, 0)
        for index in range(67):
            state.push(epoch, {'firstFrame': index * 480, 'frameCount': 480,
                               'pcmS16LE': bytes(960), 'discontinuity': False})
        pcm, source_ms = state.window()
        self.assertEqual(len(pcm), 64000)
        self.assertEqual(source_ms, 10510)

    def chunk(self, frame, *, gap=False):
        return {'firstFrame': frame, 'frameCount': 320,
                'pcmS16LE': bytes(640), 'discontinuity': gap}

    def test_stop_rejects_late_capture_and_clears_pcm(self):
        state = SessionBuffer()
        epoch = state.begin(10500, 250)
        self.assertTrue(state.push(epoch, self.chunk(0)))
        state.stop()
        self.assertFalse(state.push(epoch, self.chunk(320)))
        self.assertEqual(state.size, 0)
        self.assertIsNone(state.window())

    def test_rolling_window_uses_samples_and_explicit_delay(self):
        state = SessionBuffer()
        epoch = state.begin(10500, 250)
        for i in range(125):
            state.push(epoch, self.chunk(i * 320))
        pcm, source_ms = state.window()
        self.assertEqual(len(pcm), RATE * 2 * 2)
        self.assertEqual(source_ms, 10750)

    def test_gap_requires_fresh_full_window(self):
        state = SessionBuffer()
        epoch = state.begin(15000, 0)
        for i in range(100):
            state.push(epoch, self.chunk(i * 320))
        self.assertIsNotNone(state.window())
        state.push(epoch, self.chunk(33000))
        self.assertIsNone(state.window())
        self.assertEqual(state.size, 640)


class FakeCapture:
    def __init__(self):
        self.start_calls = []
        self.stop_calls = 0

    def start(self, *args, **kwargs):
        self.start_calls.append((args, kwargs))
        return {'state': 'recording'}

    def stop(self):
        self.stop_calls += 1
        return {'state': 'stopped'}


class FakeOutput:
    def __init__(self, **settings):
        self.settings = settings
        self.start_calls = 0
        self.abort_calls = 0
        self.close_calls = 0
        self.close_failures_remaining = 0

    def start(self):
        self.start_calls += 1

    def abort(self):
        self.abort_calls += 1

    def close(self):
        self.close_calls += 1
        if self.close_failures_remaining:
            self.close_failures_remaining -= 1
            raise RuntimeError('private playback device detail')


class FakeWorker:
    def __init__(self):
        self.close_calls = 0

    def close(self):
        self.close_calls += 1


def fake_sounddevice():
    class CallbackStop(Exception):
        pass

    return types.SimpleNamespace(CallbackStop=CallbackStop, RawOutputStream=FakeOutput)


def minimal_package():
    ids = ('phrase-2', 'phrase-3', 'phrase-30', 'phrase-41')
    return {'score': {'phrases': [{'id': phrase_id, 'words': [{'id': 'w1', 'text': 'guide'}]}
                                  for phrase_id in ids]}}


class GuideViewerLifecycleTests(unittest.TestCase):
    def setUp(self):
        try:
            import tkinter as tk
            self.root = tk.Tk()
            self.root.withdraw()
        except Exception as exc:
            self.skipTest(f'Tk display unavailable: {exc}')

        from native.guide_viewer import GuideViewer
        self.viewer = GuideViewer(self.root, minimal_package(), Path('unused-media'), enumerate_devices=False)
        self.capture = FakeCapture()
        self.viewer.capture = self.capture
        self.sounddevice_patch = patch.dict(sys.modules, {'sounddevice': fake_sounddevice()})
        self.sounddevice_patch.start()
        self.decode_patch = patch('native.guide_viewer.decode_clip', return_value=bytes(3200))
        self.decode_patch.start()

    def tearDown(self):
        if hasattr(self, 'decode_patch'):
            self.decode_patch.stop()
        if hasattr(self, 'sounddevice_patch'):
            self.sounddevice_patch.stop()
        if hasattr(self, 'viewer'):
            self.viewer.stop()
        if hasattr(self, 'root'):
            try:
                self.root.destroy()
            except Exception:
                pass

    def test_tap_only_start_never_opens_microphone(self):
        self.viewer.use_microphone.set(False)
        self.viewer.use_taps.set(True)

        self.viewer.start()

        self.assertTrue(self.viewer.buffer.active)
        self.assertEqual(self.capture.start_calls, [])
        self.assertIsInstance(self.viewer.output, FakeOutput)
        self.assertEqual(self.viewer.output.start_calls, 1)
        self.assertIn('Microphone off.', self.viewer.status_text.get())

    def test_note_changes_group_under_one_syllable_entrance(self):
        self.viewer.use_microphone.set(False)
        self.viewer.use_taps.set(True)
        self.viewer.start()
        self.viewer.started_at = 100.0
        with patch('native.guide_viewer.time.monotonic', return_value=100.5):
            self.viewer.tap()
        for stamp in (100.8, 101.1):
            with patch('native.guide_viewer.time.monotonic', return_value=stamp):
                self.viewer.tap(kind='manual-note-change')
        self.assertEqual(len(self.viewer.taps), 3)
        self.assertEqual([tap['withinTapOrdinal'] for tap in self.viewer.taps], [None, 1, 1])
        self.assertEqual(sum(tap['kind'] == 'manual-syllable-onset' for tap in self.viewer.taps), 1)
        self.assertTrue(all(tap['unitId'] is None for tap in self.viewer.taps))
        self.assertIn('1 entrances · 2 note changes', self.viewer.result_text.get())

    def test_stop_cleans_worker_input_and_output_after_close_failure_then_retries(self):
        worker = FakeWorker()
        output = FakeOutput()
        output.close_failures_remaining = 1
        self.viewer.worker = worker
        self.viewer.output = output
        self.viewer.output_pcm = bytes(640)
        self.viewer.input_queue.put((0, {'pcmS16LE': bytes(640)}))
        self.viewer.buffer.begin(0, 0)
        self.viewer.started_at = 1

        first = self.viewer.stop()

        self.assertFalse(first)
        self.assertEqual(worker.close_calls, 1)
        self.assertIsNone(self.viewer.worker)
        self.assertEqual(self.capture.stop_calls, 1)
        self.assertEqual(output.abort_calls, 1)
        self.assertEqual(output.close_calls, 1)
        self.assertIs(self.viewer.output, output)
        self.assertEqual(self.viewer.output_pcm, b'')
        self.assertTrue(self.viewer.input_queue.empty())
        self.assertIn('Playback cleanup failed', self.viewer.status_text.get())

        second = self.viewer.stop()

        self.assertTrue(second)
        self.assertEqual(output.close_calls, 2)
        self.assertIsNone(self.viewer.output)
        self.assertEqual(self.capture.stop_calls, 2)
        self.assertTrue(self.viewer.input_queue.empty())

    def test_space_repeat_stale_key_and_inactive_taps_do_not_add_markers(self):
        class Event:
            widget = None

        event = Event()
        event.widget = self.viewer.canvas
        self.viewer.use_microphone.set(False)
        self.viewer.use_taps.set(True)

        self.viewer.tap()
        self.assertEqual(self.viewer.taps, [])

        self.viewer.start()
        self.viewer.started_at = 100.0
        with patch('native.guide_viewer.time.monotonic', return_value=100.5):
            self.assertEqual(self.viewer.space_press(event), 'break')
            self.assertEqual(self.viewer.space_press(event), 'break')
        self.assertEqual(len(self.viewer.taps), 1)

        self.viewer.stop()
        with patch('native.guide_viewer.time.monotonic', return_value=101.0):
            self.assertIsNone(self.viewer.space_press(event))
            self.viewer.tap()
        self.assertEqual(len(self.viewer.taps), 1)

        self.viewer.use_taps.set(False)
        self.viewer.buffer.begin(0, 0)
        self.viewer.started_at = 100.0
        with patch('native.guide_viewer.time.monotonic', return_value=101.0):
            self.viewer.tap()
        self.assertEqual(len(self.viewer.taps), 1)
        self.viewer.stop()


if __name__ == '__main__':
    unittest.main()
