import unittest

from native.pronunciation import lookup_text, lookup_word


class PronunciationLookupTests(unittest.TestCase):
    def test_returns_multiple_cmu_alternatives_with_vowel_stress_and_syllable_count(self):
        result = lookup_word("tears")

        self.assertEqual(result["status"], "found")
        self.assertGreaterEqual(len(result["pronunciations"]), 2)
        self.assertTrue(all(item["syllableCount"] == 1 for item in result["pronunciations"]))
        self.assertTrue(all(item["stressPattern"] == [1] for item in result["pronunciations"]))
        self.assertNotEqual(
            result["pronunciations"][0]["phonemes"],
            result["pronunciations"][1]["phonemes"],
        )
        self.assertIn("not locate sung", result["timingClaim"])

    def test_out_of_vocabulary_is_explicit_and_does_not_guess_from_spelling(self):
        result = lookup_word("quizzicalxyz")

        self.assertEqual(result["status"], "out-of-vocabulary")
        self.assertEqual(result["pronunciations"], [])

    def test_text_lookup_normalizes_punctuation_but_keeps_oov_tokens_visible(self):
        results = lookup_text("The cat, quizzicalxyz!")

        self.assertEqual([item["status"] for item in results], ["found", "found", "out-of-vocabulary"])
        self.assertEqual(results[0]["pronunciations"][0]["syllableCount"], 1)

    def test_empty_single_word_request_is_rejected(self):
        with self.assertRaises(ValueError):
            lookup_word("   ")


if __name__ == "__main__":
    unittest.main()
