import unittest
from types import SimpleNamespace

from native.guide_capture import (
    BLOCK_SIZE_FRAMES,
    SAMPLE_RATE_HZ,
    GuideCapture,
    GuideCaptureError,
    list_input_devices,
)


class FakeCallbackAbort(Exception):
    pass


class FakeCallbackStop(Exception):
    pass


class FakeStream:
    def __init__(self, *, callback, **settings):
        self.callback = callback
        self.settings = settings
        self.started = False
        self.stopped = False
        self.closed = False
        self.close_failures_remaining = 0
        self.start_failure = False

    @property
    def active(self):
        return self.started and not self.stopped

    def start(self):
        if self.start_failure:
            raise RuntimeError("private device error")
        self.started = True

    def stop(self):
        self.stopped = True

    def close(self):
        if self.close_failures_remaining:
            self.close_failures_remaining -= 1
            raise RuntimeError("private close error")
        self.closed = True

    def deliver(self, frames, *, input_time=1.25, current_time=1.27, overflow=False):
        data = b"\x34\x12" * frames
        timing = SimpleNamespace(inputBufferAdcTime=input_time, currentTime=current_time)
        status = SimpleNamespace(input_overflow=overflow)
        return self.callback(data, frames, timing, status)


class FakeSoundDevice:
    CallbackAbort = FakeCallbackAbort
    CallbackStop = FakeCallbackStop

    def __init__(self, *, supported=True):
        self.default = SimpleNamespace(device=(0, 0))
        self.devices = [
            {"name": "Microphone A", "max_input_channels": 2, "default_samplerate": 48_000.0},
            {"name": "Output only", "max_input_channels": 0, "default_samplerate": 48_000.0},
        ]
        self.supported = supported
        self.streams = []
        self.checks = []
        self.start_failure = False

    def query_devices(self):
        return self.devices

    def check_input_settings(self, **settings):
        self.checks.append(settings)
        if not self.supported:
            raise ValueError("unsupported format")

    def RawInputStream(self, **settings):
        stream = FakeStream(**settings)
        stream.start_failure = self.start_failure
        self.streams.append(stream)
        return stream


class GuideCaptureTests(unittest.TestCase):
    def test_device_listing_is_input_only_and_never_opens_a_stream(self):
        backend = FakeSoundDevice()

        devices = list_input_devices(_backend=backend)

        self.assertEqual(devices, [{
            "index": 0,
            "name": "Microphone A",
            "channels": 2,
            "defaultRate": 48_000.0,
            "default": True,
        }])
        self.assertEqual(backend.streams, [])

    def test_requires_explicit_consent_before_device_or_stream_access(self):
        backend = FakeSoundDevice()
        capture = GuideCapture(_backend=backend)

        with self.assertRaises(GuideCaptureError) as caught:
            capture.start(0, lambda chunk: None)

        self.assertEqual(caught.exception.code, "CAPTURE_CONSENT_REQUIRED")
        self.assertEqual(backend.checks, [])
        self.assertEqual(backend.streams, [])
        self.assertEqual(capture.status()["state"], "idle")

    def test_unsupported_16khz_format_is_a_typed_error_without_stream_open(self):
        backend = FakeSoundDevice(supported=False)
        capture = GuideCapture(_backend=backend)

        with self.assertRaises(GuideCaptureError) as caught:
            capture.start(0, lambda chunk: None, consent=True)

        self.assertEqual(caught.exception.code, "CAPTURE_FORMAT_UNSUPPORTED")
        self.assertEqual(backend.streams, [])

    def test_start_delivers_pcm_with_sample_clock_then_stop_closes_and_reports_no_pcm(self):
        backend = FakeSoundDevice()
        capture = GuideCapture(_backend=backend)
        chunks = []

        started = capture.start(0, chunks.append, consent=True, max_capture_seconds=1)
        stream = backend.streams[0]
        stream.deliver(BLOCK_SIZE_FRAMES, overflow=True)
        status = capture.status()
        stopped = capture.stop()

        self.assertEqual(started["state"], "recording")
        self.assertEqual(stream.settings["samplerate"], SAMPLE_RATE_HZ)
        self.assertEqual(stream.settings["channels"], 1)
        self.assertEqual(stream.settings["dtype"], "int16")
        self.assertEqual(len(chunks), 1)
        self.assertEqual(len(chunks[0]["pcmS16LE"]), BLOCK_SIZE_FRAMES * 2)
        self.assertEqual(chunks[0]["firstFrame"], 0)
        self.assertEqual(chunks[0]["frameCount"], BLOCK_SIZE_FRAMES)
        self.assertEqual(chunks[0]["inputBufferAdcTime"], 1.25)
        self.assertTrue(chunks[0]["inputOverflow"])
        self.assertTrue(chunks[0]["discontinuity"])
        self.assertEqual(status["framesCaptured"], BLOCK_SIZE_FRAMES)
        self.assertEqual(status["inputOverflowCount"], 1)
        self.assertEqual(stopped["state"], "stopped")
        self.assertNotIn("pcmS16LE", stopped)
        self.assertTrue(stream.stopped)
        self.assertTrue(stream.closed)

    def test_capture_has_hard_duration_cap_and_delivers_only_remaining_frames(self):
        backend = FakeSoundDevice()
        capture = GuideCapture(_backend=backend)
        chunks = []
        capture.start(0, chunks.append, consent=True, max_capture_seconds=0.02)
        stream = backend.streams[0]

        with self.assertRaises(FakeCallbackStop):
            stream.deliver(BLOCK_SIZE_FRAMES * 2)

        self.assertEqual(capture.status()["state"], "limit_reached")
        self.assertEqual(capture.status()["framesCaptured"], BLOCK_SIZE_FRAMES)
        self.assertEqual(chunks[0]["frameCount"], BLOCK_SIZE_FRAMES)
        self.assertEqual(len(chunks[0]["pcmS16LE"]), BLOCK_SIZE_FRAMES * 2)
        stopped = capture.stop()
        self.assertIsNone(stopped["lastErrorCode"])
        self.assertTrue(stream.closed)

    def test_callback_failure_is_sanitized_and_stop_still_closes_stream(self):
        backend = FakeSoundDevice()
        capture = GuideCapture(_backend=backend)
        capture.start(0, lambda _chunk: (_ for _ in ()).throw(ValueError("private callback detail")), consent=True)
        stream = backend.streams[0]

        with self.assertRaises(FakeCallbackAbort):
            stream.deliver(BLOCK_SIZE_FRAMES)

        self.assertEqual(capture.status()["state"], "failed")
        self.assertEqual(capture.status()["lastErrorCode"], "CAPTURE_CALLBACK_FAILED")
        self.assertNotIn("private callback detail", str(capture.status()))
        capture.stop()
        self.assertTrue(stream.closed)

    def test_stop_is_idempotent(self):
        capture = GuideCapture(_backend=FakeSoundDevice())
        self.assertEqual(capture.stop()["state"], "stopped")
        self.assertEqual(capture.stop()["state"], "stopped")

    def test_start_failure_closes_the_constructed_stream(self):
        backend = FakeSoundDevice()
        backend.start_failure = True
        capture = GuideCapture(_backend=backend)

        with self.assertRaises(GuideCaptureError) as caught:
            capture.start(0, lambda chunk: None, consent=True)

        self.assertEqual(caught.exception.code, "CAPTURE_START_FAILED")
        self.assertEqual(capture.status()["state"], "failed")
        self.assertEqual(capture.status()["lastErrorCode"], "CAPTURE_START_FAILED")
        self.assertTrue(backend.streams[0].closed)
        self.assertIsNone(capture._stream)

    def test_close_failure_keeps_stream_handle_for_cleanup_retry(self):
        backend = FakeSoundDevice()
        capture = GuideCapture(_backend=backend)
        capture.start(0, lambda chunk: None, consent=True)
        stream = backend.streams[0]
        stream.close_failures_remaining = 1

        first = capture.stop()
        self.assertEqual(first["state"], "failed")
        self.assertEqual(first["lastErrorCode"], "CAPTURE_STOP_FAILED")
        self.assertIs(capture._stream, stream)
        self.assertFalse(stream.closed)

        second = capture.stop()
        self.assertEqual(second["state"], "stopped")
        self.assertIsNone(second["lastErrorCode"])
        self.assertTrue(stream.closed)


if __name__ == "__main__":
    unittest.main()
