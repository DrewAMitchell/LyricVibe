"""Killable, bounded subprocess owner for the experimental lyric follower."""

from __future__ import annotations

import multiprocessing
from multiprocessing.connection import Connection
from typing import Any


SAMPLE_RATE_HZ = 16_000
WINDOW_SECONDS = 2
EXPECTED_PCM_BYTES = SAMPLE_RATE_HZ * 2 * WINDOW_SECONDS
MAX_WORDS = 5_000
MAX_WORD_FIELD_CHARS = 256


class GuideWorkerError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _child_main(connection: Connection) -> None:
    """Own model and follower state in a separately killable process."""
    try:
        from .guide_follower import CachedCtcRuntime, GuideFollower

        runtime = CachedCtcRuntime()
    except Exception:
        try:
            connection.send({"status": "error", "code": "RUNTIME_NOT_READY"})
        except Exception:
            pass
        finally:
            connection.close()
        return

    follower = None
    epoch = None
    try:
        connection.send({"status": "ready", "modelRevision": runtime.model_revision})
        while True:
            message = connection.recv()
            if not isinstance(message, dict) or message.get("type") != "submit":
                continue
            pcm = message.get("pcm")
            words = message.get("words")
            request_epoch = message.get("epoch")
            window_start_ms = message.get("windowStartMs")
            try:
                if request_epoch != epoch or follower is None:
                    follower = GuideFollower(words, runtime=runtime)
                    follower.reset(request_epoch)
                    epoch = request_epoch
                event = follower.observe_pcm(
                    pcm,
                    source_epoch=request_epoch,
                    window_start_ms=window_start_ms,
                    sample_rate_hz=SAMPLE_RATE_HZ,
                )
                connection.send({"status": "result", "epoch": request_epoch, "event": event})
            except Exception as error:
                code = getattr(error, "code", "FOLLOWER_FAILED")
                if code not in {"INVALID_LYRICS", "INVALID_PCM", "WINDOW_TOO_SHORT", "WINDOW_TOO_LONG", "INVALID_MEDIA_TIME", "INVALID_SOURCE_EPOCH", "RUNTIME_NOT_READY", "MODEL_INFERENCE_FAILED"}:
                    code = "FOLLOWER_FAILED"
                try:
                    connection.send({"status": "error", "epoch": request_epoch, "code": code})
                except Exception:
                    break
            finally:
                # Drop this command's private audio reference before waiting for
                # another request. No request queue or decoded text is kept.
                del pcm
                del message
    except (EOFError, OSError):
        pass
    finally:
        follower = None
        connection.close()


class GuideWorker:
    """Single-inflight process wrapper; caller owns source-epoch stale gating."""

    def __init__(self):
        self._process: Any = None
        self._parent: Any = None
        self._child: Any = None
        self._ready = False
        self._busy = False
        self._closed = False

    @property
    def ready(self) -> bool:
        return self._ready

    @property
    def busy(self) -> bool:
        return self._busy

    def start(self) -> None:
        if self._process is not None:
            if self._process.is_alive():
                return
            old_process = self._process
            try:
                old_process.join(timeout=0)
                if old_process.is_alive():
                    raise GuideWorkerError("WORKER_CLEANUP_FAILED", "The previous guide worker has not exited.")
                old_process.close()
            except GuideWorkerError:
                raise
            except Exception as error:
                raise GuideWorkerError("WORKER_CLEANUP_FAILED", "The previous guide worker could not be reaped.") from error
            for pipe in (self._parent, self._child):
                if pipe is not None:
                    try:
                        pipe.close()
                    except Exception:
                        pass
            self._process = self._parent = self._child = None
            self._ready = self._busy = False
        if self._closed:
            raise GuideWorkerError("WORKER_CLOSED", "This guide worker has been closed.")
        try:
            context = multiprocessing.get_context("spawn")
            parent, child = context.Pipe(duplex=True)
            process = context.Process(target=_child_main, args=(child,), name="lyricvibe-guide-worker")
            process.daemon = True
            process.start()
            # The spawned process owns its copy. Keeping the parent's duplicate
            # open can mask EOF when the child exits unexpectedly.
            child.close()
        except Exception as error:
            try:
                parent.close()
                child.close()
            except Exception:
                pass
            raise GuideWorkerError("WORKER_START_FAILED", "Could not start the local guide worker.") from error
        self._parent, self._child, self._process = parent, None, process
        self._ready = False
        self._busy = False

    def submit(self, words: list[dict[str, str]], pcm: bytes, epoch: int, window_start_ms: int) -> None:
        if not self._process or not self._process.is_alive():
            raise GuideWorkerError("WORKER_NOT_RUNNING", "The local guide worker is not running.")
        if not self._ready:
            raise GuideWorkerError("RUNTIME_NOT_READY", "The local guide model is not ready.")
        if self._busy:
            raise GuideWorkerError("WORKER_BUSY", "Wait for the current guide window to finish.")
        self._validate(words, pcm, epoch, window_start_ms)
        try:
            self._parent.send({
                "type": "submit",
                "words": words,
                "pcm": pcm,
                "epoch": epoch,
                "windowStartMs": window_start_ms,
            })
            self._busy = True
        except Exception as error:
            raise GuideWorkerError("WORKER_SEND_FAILED", "Could not submit this guide window.") from error

    def poll(self) -> dict[str, Any] | None:
        if self._parent is None or self._closed:
            return None
        try:
            if not self._parent.poll(0):
                if self._process is not None and not self._process.is_alive():
                    self._ready = False
                    self._busy = False
                    return {"status": "error", "code": "WORKER_EXITED"}
                return None
            message = self._parent.recv()
        except (EOFError, OSError):
            self._ready = False
            self._busy = False
            return {"status": "error", "code": "WORKER_EXITED"}
        status = message.get("status") if isinstance(message, dict) else None
        if status == "ready":
            self._ready = True
            return message
        if status == "result" or status == "error":
            self._busy = False
            if status == "error":
                self._ready = False if message.get("code") == "RUNTIME_NOT_READY" else self._ready
            return message
        self._ready = False
        self._busy = False
        return {"status": "error", "code": "WORKER_PROTOCOL_ERROR"}

    def close(self) -> None:
        self._closed = True
        self._ready = False
        self._busy = False
        process, parent, child = self._process, self._parent, self._child
        if process is not None:
            try:
                if process.is_alive():
                    try:
                        process.terminate()
                    except Exception:
                        pass
                    process.join(timeout=1.0)
                    if process.is_alive():
                        try:
                            process.kill()
                        except Exception:
                            pass
                        process.join(timeout=1.0)
                else:
                    # join is also required to reap a child that exited early.
                    process.join(timeout=1.0)
            except Exception as error:
                raise GuideWorkerError("WORKER_CLEANUP_FAILED", "The local guide worker could not be joined.") from error
            try:
                alive = process.is_alive()
            except Exception as error:
                raise GuideWorkerError("WORKER_CLEANUP_FAILED", "The local guide worker state could not be verified.") from error
            if alive:
                # Keep the process/pipe handles so a caller can retry cleanup.
                raise GuideWorkerError("WORKER_CLEANUP_FAILED", "The local guide worker is still running; retry cleanup.")
        for pipe in (parent, child):
            if pipe is not None:
                try:
                    pipe.close()
                except Exception:
                    pass
        if process is not None:
            try:
                process.close()
            except Exception as error:
                raise GuideWorkerError("WORKER_CLEANUP_FAILED", "The local guide worker handle could not be released.") from error
        self._process = self._parent = self._child = None

    @staticmethod
    def _validate(words: list[dict[str, str]], pcm: bytes, epoch: int, window_start_ms: int) -> None:
        if not isinstance(words, list) or not 0 < len(words) <= MAX_WORDS:
            raise GuideWorkerError("INVALID_LYRICS", "Guide input needs 1 to 5000 supplied words.")
        seen_ids: set[str] = set()
        for word in words:
            if (
                not isinstance(word, dict)
                or not isinstance(word.get("id"), str)
                or not word["id"]
                or len(word["id"]) > MAX_WORD_FIELD_CHARS
                or not isinstance(word.get("text"), str)
                or not word["text"].strip()
                or len(word["text"]) > MAX_WORD_FIELD_CHARS
                or word["id"] in seen_ids
            ):
                raise GuideWorkerError("INVALID_LYRICS", "Each guide word needs a nonempty stable ID and text.")
            seen_ids.add(word["id"])
        if not isinstance(pcm, bytes) or len(pcm) != EXPECTED_PCM_BYTES:
            raise GuideWorkerError("INVALID_PCM", "Guide input must be exactly 2 seconds of mono 16 kHz PCM16.")
        if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
            raise GuideWorkerError("INVALID_SOURCE_EPOCH", "Source epoch must be a nonnegative integer.")
        if not isinstance(window_start_ms, int) or isinstance(window_start_ms, bool) or window_start_ms < 0:
            raise GuideWorkerError("INVALID_MEDIA_TIME", "Window start must be nonnegative source-media milliseconds.")
