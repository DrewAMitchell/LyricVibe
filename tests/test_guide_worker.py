import queue
import unittest
from unittest.mock import patch

from native.guide_worker import EXPECTED_PCM_BYTES, GuideWorker, GuideWorkerError


class _Connection:
    def __init__(self, incoming, outgoing):
        self.incoming = incoming
        self.outgoing = outgoing
        self.closed = False
        self.sent = []

    def send(self, value):
        if self.closed:
            raise OSError("closed")
        self.sent.append(value)
        self.outgoing.put(value)

    def poll(self, timeout=0):
        return not self.incoming.empty()

    def recv(self):
        if self.closed:
            raise OSError("closed")
        return self.incoming.get_nowait()

    def close(self):
        self.closed = True


class _Process:
    def __init__(self, **kwargs):
        self.alive = False
        self.terminate_called = False
        self.kill_called = False
        self.join_timeouts = []
        self.daemon = False
        self.kill_survives = False
        self.close_called = False

    def start(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.terminate_called = True

    def join(self, timeout=None):
        self.join_timeouts.append(timeout)

    def kill(self):
        self.kill_called = True
        if not self.kill_survives:
            self.alive = False

    def close(self):
        self.close_called = True


class _Context:
    def __init__(self):
        self.parent_to_child = queue.Queue()
        self.child_to_parent = queue.Queue()
        self.parent = _Connection(self.child_to_parent, self.parent_to_child)
        self.child = _Connection(self.parent_to_child, self.child_to_parent)
        self.child_copy = _Connection(self.parent_to_child, self.child_to_parent)
        self.process = None

    def Pipe(self, duplex=True):
        assert duplex is True
        return self.parent, self.child_copy

    def Process(self, **kwargs):
        self.process = _Process(**kwargs)
        return self.process


class GuideWorkerTests(unittest.TestCase):
    def make_worker(self):
        context = _Context()
        worker = GuideWorker()
        return worker, context, patch("native.guide_worker.multiprocessing.get_context", return_value=context)

    def test_validation_requires_exact_two_second_pcm_and_bounded_words(self):
        GuideWorker._validate([{"id": "w0", "text": "hello"}], bytes(EXPECTED_PCM_BYTES), 1, 0)
        for pcm in (b"", bytes(EXPECTED_PCM_BYTES - 2), bytes(EXPECTED_PCM_BYTES + 2)):
            with self.assertRaises(GuideWorkerError) as raised:
                GuideWorker._validate([{"id": "w0", "text": "hello"}], pcm, 1, 0)
            self.assertEqual(raised.exception.code, "INVALID_PCM")
        with self.assertRaises(GuideWorkerError) as raised:
            GuideWorker._validate([{"id": "w0", "text": "hello"}] * 5001, bytes(EXPECTED_PCM_BYTES), 1, 0)
        self.assertEqual(raised.exception.code, "INVALID_LYRICS")
        for words in (
            [{"id": "w0", "text": "hello"}, {"id": "w0", "text": "again"}],
            [{"id": "w0", "text": "x" * 257}],
        ):
            with self.assertRaises(GuideWorkerError) as raised:
                GuideWorker._validate(words, bytes(EXPECTED_PCM_BYTES), 1, 0)
            self.assertEqual(raised.exception.code, "INVALID_LYRICS")

    def test_worker_is_one_inflight_and_poll_transitions_ready_result(self):
        worker, context, context_patch = self.make_worker()
        with context_patch:
            worker.start()
            self.assertTrue(context.child_copy.closed)
            self.assertFalse(worker.ready)
            context.child.send({"status": "ready", "modelRevision": "sha256:fixture"})
            self.assertEqual(worker.poll()["status"], "ready")
            self.assertTrue(worker.ready)

            payload = bytes(EXPECTED_PCM_BYTES)
            words = [{"id": "w0", "text": "hello"}, {"id": "w1", "text": "there"}]
            worker.submit(words, payload, 7, 12_000)
            self.assertTrue(worker.busy)
            sent = context.parent.sent[-1]
            self.assertEqual(sent["epoch"], 7)
            self.assertIs(sent["pcm"], payload)
            with self.assertRaises(GuideWorkerError) as raised:
                worker.submit(words, payload, 7, 12_500)
            self.assertEqual(raised.exception.code, "WORKER_BUSY")

            context.child.send({"status": "result", "epoch": 7, "event": {"status": "unsupported", "scoreMutation": False}})
            result = worker.poll()
            self.assertEqual(result["epoch"], 7)
            self.assertFalse(worker.busy)
            worker.close()

    def test_submit_rejects_invalid_epoch_and_clock_before_sending(self):
        worker, context, context_patch = self.make_worker()
        with context_patch:
            worker.start()
            context.child.send({"status": "ready"})
            worker.poll()
            words = [{"id": "w0", "text": "hello"}]
            with self.assertRaises(GuideWorkerError) as raised:
                worker.submit(words, bytes(EXPECTED_PCM_BYTES), True, 0)
            self.assertEqual(raised.exception.code, "INVALID_SOURCE_EPOCH")
            with self.assertRaises(GuideWorkerError) as raised:
                worker.submit(words, bytes(EXPECTED_PCM_BYTES), 1, -1)
            self.assertEqual(raised.exception.code, "INVALID_MEDIA_TIME")
            self.assertEqual(context.parent.sent, [])
            worker.close()

    def test_close_terminates_then_kills_if_child_does_not_exit(self):
        worker, context, context_patch = self.make_worker()
        with context_patch:
            worker.start()
            worker._ready = True
            worker._busy = True
            process = context.process
            worker.close()
        self.assertTrue(process.terminate_called)
        self.assertTrue(process.kill_called)
        self.assertEqual(process.join_timeouts, [1.0, 1.0])
        self.assertTrue(context.parent.closed)
        self.assertTrue(context.child_copy.closed)
        self.assertFalse(worker.ready)
        self.assertFalse(worker.busy)
        self.assertTrue(process.close_called)
        self.assertIsNone(worker.poll())

    def test_failed_kill_retains_process_for_cleanup_retry(self):
        worker, context, context_patch = self.make_worker()
        with context_patch:
            worker.start()
            process = context.process
            process.kill_survives = True
            with self.assertRaises(GuideWorkerError) as raised:
                worker.close()
            self.assertEqual(raised.exception.code, "WORKER_CLEANUP_FAILED")
            self.assertIs(worker._process, process)
            self.assertFalse(process.close_called)

            process.alive = False
            worker.close()
        self.assertTrue(process.close_called)
        self.assertIsNone(worker._process)

    def test_worker_cannot_restart_after_close(self):
        worker, context, context_patch = self.make_worker()
        with context_patch:
            worker.start()
            worker.close()
            with self.assertRaises(GuideWorkerError) as raised:
                worker.start()
        self.assertEqual(raised.exception.code, "WORKER_CLOSED")

    def test_start_reaps_dead_process_before_replacing_it(self):
        first, second = _Context(), _Context()
        worker = GuideWorker()
        with patch("native.guide_worker.multiprocessing.get_context", side_effect=[first, second]):
            worker.start()
            first_process = first.process
            first_process.alive = False
            worker.start()
        self.assertTrue(first_process.close_called)
        self.assertTrue(first.parent.closed)
        self.assertIs(worker._process, second.process)
        worker.close()


if __name__ == "__main__":
    unittest.main()
