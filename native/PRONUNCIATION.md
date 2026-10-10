# Native pronunciation lookup

LyricVibe includes a small offline English pronunciation lookup for review
tools that need pronunciation alternatives, stress marks, and syllable counts.
It is an aid for inspecting supplied words. It does not recognize lyrics, score
singing, locate phones or syllables in audio, estimate vowel duration, or
provide word boundaries. A pronunciation's vowel-nucleus count is not a sung
syllable-timing measurement.

The data is a compressed copy of CMU Pronouncing Dictionary from upstream
revision [`74790861f652b15e4ac49015a90074ad62a27690`](https://github.com/cmusphinx/cmudict/tree/74790861f652b15e4ac49015a90074ad62a27690),
stored as `native/data/cmudict.dict.gz`. Its license is preserved in
[`data/cmudict.LICENSE`](data/cmudict.LICENSE). CMUdict describes
its entries as US-English pronunciations and explicitly notes that it can
contain errors, omissions, and inconsistencies. The dictionary may return
multiple variants; an out-of-vocabulary token remains explicitly unknown, with
no spelling-based guess.

The lookup derives syllable counts from vowel phonemes and returns CMUdict's
stress digits with each variant. These are lexical dictionary annotations,
not evidence of what a singer pronounced. The lookup returns no confidence
score and makes no claim that a listed variant is present in a recording.

The pinned upstream dictionary bytes have SHA-256
`81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22` before
compression; the bundled gzip has SHA-256
`ed91821de146d4cc1bfdfb04c830c60b69c562eb2b62c1d5b2077ac655eb5159`.

Useful upstream references:

- [CMUdict README at the pinned revision](https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/README)
- [CMUdict license at the pinned revision](https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/LICENSE)
- [Pronunciation data at the pinned revision](https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/cmudict.dict)
- [Phone inventory, including vowel-phone classification](https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/cmudict.phones)
- [Symbol inventory, including stress-marked vowels](https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/cmudict.symbols)

CMUdict's license asks downstream redistributors to acknowledge the source.
This project does so here and retains the upstream copyright, conditions, and
disclaimer with the bundled data. The included full text is at
[`data/cmudict.LICENSE`](data/cmudict.LICENSE).
