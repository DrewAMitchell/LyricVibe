import threading
import time
import types
import unittest

from native.timeline_audio import TimelineAudio, RATE


class CallbackStop(Exception):
    pass


class CallbackAbort(Exception):
    pass


class FakeStream:
    def __init__(self, **kwargs):
        self.callback = kwargs['callback']
        self.finished_callback = kwargs['finished_callback']
        self.closed = False
        self.aborted = False
        self.output = bytearray()
        self._lock = threading.Lock()

    def start(self):
        pass

    def emit(self, frames=320, clock=None):
        block = bytearray(frames * 2)
        try:
            self.callback(block, frames, clock or types.SimpleNamespace(
                outputBufferDacTime=0.1, currentTime=0.1), None)
        except CallbackStop:
            self.finished_callback()
        except CallbackAbort:
            self.finished_callback()
        with self._lock:
            self.output.extend(block)
        return block

    def emit_to_end(self):
        while True:
            try:
                self.emit()
            except (CallbackStop, CallbackAbort):
                return
            if self.closed or self.aborted:
                return

    def abort(self):
        self.aborted = True
        self.finished_callback()

    def stop(self):
        self.finished_callback()

    def close(self):
        self.closed = True


class TimelineAudioTests(unittest.TestCase):
    def setUp(self):
        self.package = {'version': 'lyricvibe.review.v1', 'audio': {'durationMs': 30_000, 'sha256': 'bound'}}
        self.streams = []
        self.stream_ready = threading.Event()
        self.clock = [100.0]

    def make_audio(self, *, package_loader=None, decoder=None, duration_ms=None, expected_package=None):
        package = self.package
        if duration_ms is not None:
            package = {'version': package['version'], 'audio': {**package['audio'], 'durationMs': duration_ms}}
        calls = []

        def load(package_path, media_path):
            calls.append((package_path, media_path))
            return package_loader(package_path, media_path) if package_loader else package

        def decode(media_path, start_ms, stop_event, duration_seconds):
            if decoder:
                return decoder(media_path, start_ms, stop_event, duration_seconds)
            return b'\x01\x00' * (RATE * duration_seconds)

        def stream_factory(**kwargs):
            stream = FakeStream(**kwargs)
            self.streams.append(stream)
            self.stream_ready.set()
            return stream

        audio = TimelineAudio('package.json', 'take.wav', expected_package=expected_package,
                              package_loader=load, decoder=decode,
                              output_stream_factory=stream_factory, callback_stop=CallbackStop,
                              callback_abort=CallbackAbort, monotonic=lambda: self.clock[0])
        return audio, calls

    def wait_for(self, predicate, timeout=1.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(.005)
        return predicate()

    def finish_audio(self, audio):
        if audio.busy:
            audio.stop()
        self.assertTrue(self.wait_for(lambda: not audio.busy))
        self.assertTrue(audio.close())

    def test_play_is_nonblocking_busy_is_rejected_and_exact_binding_is_rechecked(self):
        audio, calls = self.make_audio()
        began = time.monotonic()
        self.assertTrue(audio.play(1_250, 3))
        self.assertLess(time.monotonic() - began, .2)
        self.assertFalse(audio.play(4_000, 3))
        self.assertTrue(self.stream_ready.wait(1))
        self.assertEqual(audio.poll(), {'state': 'preparing', 'positionMs': 1_250.0,
                                        'error': None, 'errorCode': None})
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(str(package).endswith('package.json') and str(media).endswith('take.wav')
                            for package, media in calls))
        self.finish_audio(audio)

    def test_output_dac_clock_drives_source_media_position(self):
        audio, _ = self.make_audio()
        self.assertTrue(audio.play(2_000, 12))
        self.assertTrue(self.stream_ready.wait(1))
        stream = self.streams[0]
        stream.emit(clock=types.SimpleNamespace(outputBufferDacTime=10.2, currentTime=10.0))
        self.assertEqual(audio.poll()['state'], 'playing')
        # First sample is scheduled 200 ms ahead; estimates are bounded to frames submitted.
        self.clock[0] = 100.21
        self.assertEqual(audio.poll()['positionMs'], 2_010.0)
        self.finish_audio(audio)

    def test_future_dac_anchor_with_nonzero_frame_does_not_jump_to_buffer_start(self):
        audio, _ = self.make_audio()
        self.assertTrue(audio.play(1_000, 12))
        self.assertTrue(self.stream_ready.wait(1))
        stream = self.streams[0]
        stream.emit(clock=types.SimpleNamespace(outputBufferDacTime=10.0, currentTime=10.0))
        self.clock[0] = 100.02
        stream.emit(clock=types.SimpleNamespace(outputBufferDacTime=10.01, currentTime=10.0))
        self.assertEqual(audio.poll()['positionMs'], 1_010.0)
        self.finish_audio(audio)

    def test_stop_invalidates_a_late_callback_and_clock(self):
        audio, _ = self.make_audio()
        self.assertTrue(audio.play(500, 12))
        self.assertTrue(self.stream_ready.wait(1))
        stream = self.streams[0]
        audio.stop()
        with self.assertRaises(CallbackAbort):
            stream.callback(bytearray(640), 320,
                            types.SimpleNamespace(outputBufferDacTime=10.0, currentTime=0.0), None)
        self.assertEqual(audio.poll(), {'state': 'stopped', 'positionMs': 500.0,
                                        'error': None, 'errorCode': None})
        self.finish_audio(audio)

    def test_decoder_failure_is_reported_without_leaking_exception_details(self):
        audio, _ = self.make_audio(decoder=lambda *_: (_ for _ in ()).throw(RuntimeError('C:\\private\\take.wav')))
        self.assertTrue(audio.play(100, 3))
        self.assertTrue(self.wait_for(lambda: audio.poll()['state'] == 'failed'))
        result = audio.poll()
        self.assertIn('FFmpeg', result['error'])
        self.assertEqual(result['errorCode'], 'AUDIO_DECODE_FAILED')
        self.assertNotIn('private', result['error'])
        self.assertTrue(audio.close())

    def test_media_end_clamps_pcm_and_reported_playhead(self):
        audio, _ = self.make_audio(duration_ms=1_500)
        self.assertTrue(audio.play(1_000, 3))
        self.assertTrue(self.stream_ready.wait(1))
        stream = self.streams[0]
        for _ in range(26):
            stream.emit()
        self.assertTrue(self.wait_for(lambda: not audio.busy))
        self.assertEqual(audio.poll(), {'state': 'stopped', 'positionMs': 1_500.0,
                                        'error': None, 'errorCode': None})
        self.assertEqual(audio._queued_frame, RATE // 2)
        self.assertTrue(audio.close())

    def test_terminal_position_uses_actual_short_decoder_output(self):
        audio, _ = self.make_audio(decoder=lambda *_: b'\x01\x00' * 400)
        self.assertTrue(audio.play(1_000, 3))
        self.assertTrue(self.stream_ready.wait(1))
        stream = self.streams[0]
        stream.emit(frames=320)
        stream.emit(frames=320)
        self.assertTrue(self.wait_for(lambda: not audio.busy))
        self.assertEqual(audio.poll(), {'state': 'stopped', 'positionMs': 1_025.0,
                                        'error': None, 'errorCode': None})
        self.assertEqual(audio._queued_frame, 400)
        self.assertTrue(audio.close())

    def test_changed_media_binding_after_decode_never_opens_output(self):
        returns = [self.package, {'version': 'lyricvibe.review.v1',
                                  'audio': {'durationMs': 30_000, 'sha256': 'changed'}}]
        audio, _ = self.make_audio(package_loader=lambda *_: returns.pop(0))
        self.assertTrue(audio.play(100, 3))
        self.assertTrue(self.wait_for(lambda: audio.poll()['state'] == 'failed'))
        self.assertEqual(self.streams, [])
        self.assertTrue(audio.close())

    def test_package_must_match_the_document_binding_before_decode(self):
        expected = {'version': 'lyricvibe.review.v1', 'audio': {'durationMs': 30_000, 'sha256': 'other'}}
        decoded = []
        audio, _ = self.make_audio(expected_package=expected,
                                  decoder=lambda *_: decoded.append(True) or b'\x01\x00' * 160)
        self.assertTrue(audio.play(100, 3))
        self.assertTrue(self.wait_for(lambda: audio.poll()['state'] == 'failed'))
        self.assertIn('matches this editor document', audio.poll()['error'])
        self.assertEqual(audio.poll()['errorCode'], 'SOURCE_BINDING_FAILED')
        self.assertEqual(decoded, [])
        self.assertEqual(self.streams, [])
        self.assertTrue(audio.close())

    def test_output_failure_is_actionable_without_leaking_device_details(self):
        audio, _ = self.make_audio()
        audio._output_stream_factory = lambda **_kwargs: (_ for _ in ()).throw(RuntimeError('secret device path'))
        self.assertTrue(audio.play(100, 3))
        self.assertTrue(self.wait_for(lambda: audio.poll()['state'] == 'failed'))
        error = audio.poll()['error']
        self.assertIn('output device', error)
        self.assertNotIn('secret', error)
        self.assertEqual(audio.poll()['errorCode'], 'AUDIO_OUTPUT_FAILED')
        audio.stop()
        self.assertIsNone(audio.poll()['errorCode'])
        self.assertTrue(audio.close())

    def test_missing_output_dac_clock_has_its_own_sanitized_error_code(self):
        audio, _ = self.make_audio()
        self.assertTrue(audio.play(100, 3))
        self.assertTrue(self.stream_ready.wait(1))
        self.streams[0].emit(clock=types.SimpleNamespace())
        self.assertTrue(self.wait_for(lambda: audio.poll()['state'] == 'failed'))
        result = audio.poll()
        self.assertEqual(result['errorCode'], 'OUTPUT_CLOCK_UNAVAILABLE')
        self.assertIn('DAC clock', result['error'])
        self.assertNotIn('path', result['error'].lower())
        self.assertTrue(audio.close())

    def test_argument_bounds_and_close_reject_new_playback(self):
        audio, _ = self.make_audio()
        for start in (-1, float('nan'), True):
            with self.assertRaises(ValueError):
                audio.play(start, 3)
        with self.assertRaises(ValueError):
            audio.play(0, 4)
        self.assertTrue(audio.close())
        self.assertFalse(audio.play(0, 3))

    def test_close_signals_worker_and_reports_when_ui_may_finish_closing(self):
        entered = threading.Event()
        release = threading.Event()

        def delayed_decode(*_args):
            entered.set()
            release.wait(1)
            return b'\x01\x00' * 160

        audio, _ = self.make_audio(decoder=delayed_decode)
        self.assertTrue(audio.play(0, 3))
        self.assertTrue(entered.wait(1))
        self.assertFalse(audio.close())
        self.assertFalse(audio.play(0, 3))
        release.set()
        self.assertTrue(self.wait_for(audio.close))


if __name__ == '__main__':
    unittest.main()
