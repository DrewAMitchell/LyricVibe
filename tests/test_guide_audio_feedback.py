import unittest
from array import array

from native.guide_audio_feedback import LiveTapClickMixer, add_tap_clicks


def pcm_samples(values):
    samples = array('h', values)
    return samples.tobytes()


def sample_values(pcm):
    samples = array('h')
    samples.frombytes(pcm)
    return list(samples)


class TapClickTests(unittest.TestCase):
    def test_add_tap_clicks_returns_new_pcm_and_uses_source_relative_sample_offset(self):
        original = pcm_samples([0] * 1000)
        result = add_tap_clicks(original, 100, [104])

        self.assertEqual(original, pcm_samples([0] * 1000))
        self.assertNotEqual(result, original)
        samples = sample_values(result)
        self.assertTrue(all(value == 0 for value in samples[:64]))
        self.assertTrue(any(value != 0 for value in samples[65:544]))
        self.assertTrue(all(value == 0 for value in samples[544:]))

    def test_live_mixer_carries_a_click_across_callback_blocks(self):
        mixer = LiveTapClickMixer()
        original = bytes(1280)
        self.assertTrue(mixer.schedule(320))

        first = mixer.mix(original[:640], 0)
        second = mixer.mix(original[640:], 320)
        third = mixer.mix(bytes(640), 640)
        fourth = mixer.mix(bytes(640), 960)

        self.assertEqual(first, original[:640])
        self.assertTrue(any(second))
        self.assertTrue(any(third[:320]))
        self.assertEqual(third[320:], bytes(320))
        self.assertEqual(fourth, bytes(640))
        self.assertEqual(original, bytes(1280))

    def test_clear_invalidates_pending_clicks_and_queue_is_bounded(self):
        mixer = LiveTapClickMixer(max_queued=1)
        self.assertTrue(mixer.schedule(0))
        self.assertFalse(mixer.schedule(1))
        mixer.clear()

        self.assertEqual(mixer.mix(bytes(640), 0), bytes(640))

        active = LiveTapClickMixer()
        self.assertTrue(active.schedule(0))
        self.assertTrue(any(active.mix(bytes(640), 0)))
        active.clear()
        self.assertEqual(active.mix(bytes(640), 320), bytes(640))

    def test_click_addition_saturates_signed_pcm(self):
        mixer = LiveTapClickMixer()
        maximum = pcm_samples([32767] * 640)
        self.assertTrue(mixer.schedule(0))

        result = sample_values(mixer.mix(maximum, 0))

        self.assertTrue(all(-32768 <= value <= 32767 for value in result))
        self.assertEqual(result[1], 32767)

    def test_rejects_malformed_pcm_or_invalid_schedule_frame(self):
        mixer = LiveTapClickMixer()
        self.assertFalse(mixer.schedule(-1))
        with self.assertRaises(ValueError):
            mixer.mix(b'odd', 0)
        with self.assertRaises(ValueError):
            add_tap_clicks(b'odd', 0, [0])


if __name__ == '__main__':
    unittest.main()
