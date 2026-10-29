"""Review-only phrase alignment from local media; never edits the input score."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from native.companion import ROOT, _validate_score
from native.pronunciation import lookup_word

MAX_PHRASE_MS = 12_000
TOKEN = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)*")


def token(text):
    value = text.strip(" \t.,!?;:\"()[]{}").replace("’", "'")
    if not TOKEN.fullmatch(value):
        raise ValueError("Phrase contains an unsupported English word; no partial text was aligned.")
    return value


def phrase_plan(score, phrase_id):
    phrase = next((p for p in score["phrases"] if p["id"] == phrase_id), None)
    if not phrase:
        raise ValueError("Unknown phrase ID.")
    if any(type(value) is not int for value in [phrase["startMs"], phrase["endMs"], score.get("offsetMs", 0)]):
        raise ValueError("Phrase bounds and offset must be whole source milliseconds.")
    duration = phrase["endMs"] - phrase["startMs"]
    if not 0 < duration <= MAX_PHRASE_MS:
        raise ValueError("Select a phrase with explicit positive bounds of at most 12 seconds.")
    start = phrase["startMs"] + score.get("offsetMs", 0)
    if start < 0:
        raise ValueError("Phrase starts before the source recording.")
    if any(p["id"] != phrase_id and p["startMs"] < phrase["endMs"] and p["endMs"] > phrase["startMs"] for p in score["phrases"]):
        raise ValueError("Overlapping vocal phrases need review; this aligner accepts one vocal stream.")
    words = [w for w in phrase["words"] if not w.get("excluded")]
    if not words or len(words) > 200:
        raise ValueError("Phrase must contain 1–200 included words.")
    return phrase, words, int(start), int(duration), " ".join(token(w.get("spokenText") or w["text"]) for w in words)


def spelling_hints(words):
    """Use explicit existing cuts first; dictionaries supply only unique guesses."""
    requests = []
    hints = {}
    for word in words:
        if word.get("syllables"):
            hints[word["id"]] = {"parts": [s["text"] for s in word["syllables"]], "basis": "existing-segmentation"}
            continue
        counts = sorted({p["syllableCount"] for p in lookup_word(word.get("spokenText") or word["text"])["pronunciations"]})
        if len(counts) == 1:
            requests.append({"wordId": word["id"], "text": word.get("spokenText") or word["text"], "count": counts[0]})
    if requests:
        script = "const fs=require('fs'),p=require('./extension/pronunciation.js');process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(w=>({wordId:w.wordId,...p.partsForCount(w.text,w.count)}))));"
        result = run_process(["node", "-e", script], json.dumps(requests).encode(), 15, "spelling")
        for row in json.loads(result):
            if row.get("parts"):
                hints[row["wordId"]] = {"parts": row["parts"], "basis": "dictionary-spelling-estimate"}
    return hints


def proposals(score, phrase_id, aligned, hints):
    phrase, words, start, duration, transcript = phrase_plan(score, phrase_id)
    anchors = aligned.get("words", [])
    if len(anchors) != len(words):
        raise ValueError("Model did not align every supplied word; no partial operations emitted.")
    operations, word_proposals, review, protected = [], [], [], []
    evidence_seed = hashlib.sha256(json.dumps(aligned, sort_keys=True).encode()).hexdigest()
    previous_end = 0
    for index, (word, anchor) in enumerate(zip(words, anchors)):
        if anchor.get("wordIndex") != index or token(anchor.get("text", "")).casefold() != token(word.get("spokenText") or word["text"]).casefold():
            raise ValueError("Model word order/text does not match the supplied phrase.")
        a, b = anchor.get("startMs"), anchor.get("endMs")
        if not all(type(t) is int for t in [a, b]) or not previous_end <= a < b <= duration:
            raise ValueError("Model word interval is invalid, overlapping or outside the phrase.")
        previous_end = b
        if word.get("locked") or any(s.get("locked") for s in word.get("syllables", [])):
            protected.append(word["id"])
            continue
        word_proposals.append({"wordId": word["id"], "startMs": phrase["startMs"] + a, "endMs": phrase["startMs"] + b,
                               "accepted": False, "evidenceId": f"phrase:{evidence_seed}:{word['id']}"})
        hint = hints.get(word["id"])
        children = []
        characters = anchor.get("characters", [])
        if hint:
            parts = hint["parts"]
            expected = word.get("spokenText") or word["text"]
            if not parts or "".join(parts) != expected:
                raise ValueError("Syllable spelling does not reconstruct the supplied word.")
            sizes = [len(re.sub(r"[^A-Za-z']", "", part.replace("’", "'"))) for part in parts]
            if all(sizes) and len(characters) == sum(sizes):
                cursor = 0
                for n, size in enumerate(sizes):
                    group = characters[cursor:cursor + size]
                    for j, char in enumerate(group):
                        ca, cb = char.get("startMs"), char.get("endMs")
                        if char.get("characterIndex") != cursor + j or not all(type(t) is int for t in [ca, cb]) or not a <= ca < cb <= b:
                            raise ValueError("Invalid acoustic character alignment.")
                        if cursor + j and ca < characters[cursor + j - 1]["endMs"]:
                            raise ValueError("Overlapping acoustic character alignment.")
                    children.append({"id": word.get("syllables", [])[n]["id"] if n < len(word.get("syllables", [])) else f"{word['id']}-aligned-{n+1}",
                                     "text": parts[n], "startMs": phrase["startMs"] + group[0]["startMs"],
                                     "endMs": phrase["startMs"] + group[-1]["endMs"], "provenance": "aligned", "locked": False,
                                     "effects": word.get("syllables", [])[n].get("effects", []) if n < len(word.get("syllables", [])) else []})
                    cursor += size
        if children:
            operations.append({"type": "setWordSyllables", "wordId": word["id"], "syllables": children})
        review.append({"wordId": word["id"], "syllableCount": len(children) or None,
                       "segmentationBasis": hint["basis"] if hint else "unresolved", "timingBasis": "ctc-character-groups" if children else "ctc-word",
                       "accepted": False, "confidenceCalibrated": False})
    return {"version": "lyricvibe.alignment.v1", "mediaKey": _validate_score(score)["mediaKey"],
            "lyricsHash": score["lyrics"]["contentHash"], "expectedRevision": score["revision"], "phraseId": phrase_id,
            "window": {"sourceStartMs": start, "durationMs": duration, "playbackRate": 1},
            "adapter": "phrase-constrained-ctc", "model": aligned.get("model"), "modelRevision": aligned.get("modelRevision"),
            "proposals": word_proposals, "syllableOperations": operations, "words": review, "protectedWordIds": protected,
            "accepted": False, "automaticAdmissionEnabled": False,
            "diagnostics": {"timingMs": {key: aligned[key] for key in ["elapsedMs", "modelLoadMs", "inferenceMs", "forcedAlignmentMs"]
                                           if type(aligned.get(key)) in [int, float]},
                            "greedyConsistency": aligned.get("diagnostics", {}).get("greedyConsistency"),
                            "confidenceCalibrated": False},
            "limitations": ["Speech-trained model; singing accuracy is uncalibrated.",
                            "Character-group syllable estimates are not phoneme boundaries or note changes.",
                            "Review against audio before applying; input score remains unchanged."]}


def log_probe(state, pid, label):
    ledger = os.environ.get("LV_PROBE_LEDGER")
    if ledger:
        with open(ledger, "a", encoding="utf8") as f:
            f.write(f"\n{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {state} LyricVibe phrase alignment {label} PID{pid}; bounded local trial.\n")


def run_process(command, data, timeout, label):
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    log_probe("START", child.pid, label)
    try:
        out, err = child.communicate(data, timeout=timeout)
        if child.returncode:
            raise RuntimeError(f"{label} failed: " + err.decode("utf8", errors="replace")[-1000:])
        if len(out) > 1_048_576:
            raise RuntimeError(f"{label} exceeded the bounded output size.")
        return out
    except BaseException:
        if child.poll() is None:
            child.kill()
        child.communicate()
        raise
    finally:
        log_probe("END", child.pid, label)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    if sys.argv[1:] == ["--worker"]:
        from native.alignment import align_samples
        request = json.loads(sys.stdin.buffer.read(600_000))
        result = align_samples(base64.b64decode(request["pcm"], validate=True), request["text"], include_characters=True)
        sys.stdout.write(json.dumps(result))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["score", "media", "phrase-id", "output"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    output, source, media = Path(args.output), Path(args.score), Path(args.media)
    if output.exists() or output.resolve() in [source.resolve(), media.resolve()]:
        raise ValueError("Output must be a new file separate from the inputs.")
    if source.stat().st_size > 10_000_000 or media.stat().st_size > 512 * 1024 * 1024:
        raise ValueError("Input exceeds the existing score/media size limit.")
    score_bytes = source.read_bytes()
    score = json.loads(score_bytes)
    _validate_score(score)
    phrase, words, start, duration, text = phrase_plan(score, args.phrase_id)
    media_hash = file_hash(media)
    pcm = run_process([args.ffmpeg, "-v", "error", "-nostdin", "-ss", str(start / 1000), "-i", str(media.resolve()),
                       "-t", str(duration / 1000), "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], None, 20, "decode")
    if not pcm or len(pcm) > 384_000 or len(pcm) % 2:
        raise ValueError("Decoded audio is empty or outside the bounded PCM contract.")
    aligned = json.loads(run_process([sys.executable, "-m", "native.phrase_alignment", "--worker"],
                         json.dumps({"pcm": base64.b64encode(pcm).decode(), "text": text}).encode(), 60, "model"))
    result = proposals(score, args.phrase_id, aligned, spelling_hints(words))
    result["sourceEvidence"] = {"scoreSha256": hashlib.sha256(score_bytes).hexdigest(), "mediaSha256": media_hash,
                                "pcmSha256": hashlib.sha256(pcm).hexdigest(), "audioRetained": False}
    if source.read_bytes() != score_bytes or file_hash(media) != media_hash:
        raise ValueError("An input changed during alignment; no proposal written.")
    # Shared core validates the complete operation batch without persisting it.
    script = "const fs=require('fs'),s=require('./extension/score-core.js'),x=JSON.parse(fs.readFileSync(0,'utf8'));s.validateAlignmentReceipt(x.score,x.receipt);let score=s.applyAlignment(x.score,x.receipt.proposals.map(p=>({...p,accepted:true})),x.score.revision);for(const op of x.receipt.syllableOperations)score=s.applyOperation(score,op,score.revision);process.stdout.write('ok');"
    run_process(["node", "-e", script], json.dumps({"score": score, "receipt": result}).encode(), 15, "validate")
    with output.open("x", encoding="utf8") as f:
        json.dump(result, f, indent=2)
    print(json.dumps({"output": str(output.resolve()), "phraseId": args.phrase_id, "proposedWords": len(result["words"]),
                      "proposedSyllables": sum(w["syllableCount"] or 0 for w in result["words"]), "accepted": False}))


if __name__ == "__main__":
    log_probe("START", os.getpid(), "controller")
    try:
        main()
    finally:
        log_probe("END", os.getpid(), "controller")
