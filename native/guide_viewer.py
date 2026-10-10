"""Native, local-only guide-vocal experiment. Importing never opens audio devices."""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
from pathlib import Path
import queue
import shutil
import subprocess
import time

import numpy as np

from .companion import _validate_score
from .guide_capture import GuideCapture, list_input_devices
from .guide_features import GuideFeatureStream
from .guide_worker import GuideWorker

RATE = 16_000
CLIP_MS = 12_000
CASES = [('Held: arms', 'phrase-2', 10_500), ('Held: tears', 'phrase-3', 15_000),
         ('Fast: made chains', 'phrase-30', 105_000), ('Fast: need it on sight', 'phrase-41', 139_000)]


def load_bound_package(package_path: Path, media_path: Path) -> dict:
    if package_path.stat().st_size > 10_000_000:
        raise ValueError('Review package exceeds size limit.')
    package = json.loads(package_path.read_text(encoding='utf-8'))
    if package.get('version') != 'lyricvibe.review.v1':
        raise ValueError('Unsupported review package.')
    _validate_score(package['score'])
    digest = hashlib.sha256()
    with media_path.open('rb') as source:
        for block in iter(lambda: source.read(1_048_576), b''):
            digest.update(block)
    if (digest.hexdigest() != package['audio']['sha256']
            or media_path.stat().st_size != package['audio']['sizeBytes']):
        raise ValueError('Recording does not match review package.')
    return package


def decode_clip(media: Path, start_ms: int) -> bytes:
    executable = shutil.which('ffmpeg')
    if executable is None:
        raise ValueError('FFmpeg is required for local playback.')
    result = subprocess.run([executable, '-nostdin', '-v', 'error', '-ss', str(start_ms / 1000),
                             '-i', str(media), '-t', '12', '-vn', '-ac', '1', '-ar', str(RATE),
                             '-f', 's16le', 'pipe:1'], capture_output=True, timeout=15,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or not 0 < len(result.stdout) <= RATE * 2 * 12:
        raise ValueError('Bounded clip decoding failed.')
    return result.stdout


class SessionBuffer:
    """Bounded PCM window, epoch gate and source estimate shared by UI and tests."""
    def __init__(self):
        self.epoch = 0
        self.active = False
        self.chunks = deque()
        self.size = 0
        self.next_frame = None
        self.start_ms = 0
        self.delay_ms = 0

    def begin(self, start_ms, delay_ms):
        self.stop()
        self.active = True
        self.start_ms, self.delay_ms = start_ms, delay_ms
        return self.epoch

    def stop(self):
        self.epoch += 1
        self.active = False
        self.chunks.clear()
        self.size = 0
        self.next_frame = None

    def push(self, epoch, chunk):
        if not self.active or epoch != self.epoch:
            return False
        start = chunk['firstFrame']
        if chunk['discontinuity'] or (self.next_frame is not None and start != self.next_frame):
            self.chunks.clear()
            self.size = 0
        self.next_frame = start + chunk['frameCount']
        self.chunks.append((start, chunk['pcmS16LE']))
        self.size += len(chunk['pcmS16LE'])
        while self.chunks and self.size > RATE * 2 * 2:
            first, pcm = self.chunks.popleft()
            excess = self.size - RATE * 2 * 2
            removed = min(len(pcm), excess)
            self.size -= removed
            if removed < len(pcm):
                self.chunks.appendleft((first + removed // 2, pcm[removed:]))
        return True

    def window(self):
        if self.size < RATE * 2 * 2:
            return None
        first = self.chunks[0][0]
        source_ms = max(0, round(self.start_ms + first * 1000 / RATE - self.delay_ms))
        return b''.join(pcm for _, pcm in self.chunks), source_ms


class GuideViewer:
    def __init__(self, root, package, media, *, enumerate_devices=True):
        import tkinter as tk
        from tkinter import ttk
        self.tk, self.ttk, self.root = tk, ttk, root
        self.package, self.media = package, media
        self.buffer = SessionBuffer()
        self.features = GuideFeatureStream()
        self.input_queue = queue.Queue(maxsize=25)
        self.capture = GuideCapture()
        self.output = None
        self.output_pcm = b''
        self.output_frame = 0
        self.output_done = False
        self.worker = None
        self.last_inference = 0
        self.worker_started_at = 0
        self.mode = 'Acoustic cues only'
        self.events = []
        self.photo = None
        self.render_key = None
        self.closed = False
        self.started_at = 0
        self.taps = []
        self.space_down = False
        self.elapsed_ms = 0
        self.trial_microphone_enabled = False
        self.trial_taps_enabled = False
        self.trial_epoch = None
        root.title('LyricVibe · Guide vocals')
        root.geometry('920x650')
        root.minsize(560, 500)
        root.configure(bg='#101419')
        style = ttk.Style(root)
        style.theme_use('clam')
        style.configure('TFrame', background='#101419')
        style.configure('TLabel', background='#101419', foreground='#d8dfe7', font=('Segoe UI', 10))
        style.configure('TButton', font=('Segoe UI', 10), padding=(10, 6))
        pane = ttk.Frame(root, padding=20)
        pane.pack(fill='both', expand=True)
        ttk.Label(pane, text='Guide vocals', font=('Segoe UI', 22, 'bold')).pack(anchor='w')
        ttk.Label(pane, text='Sing or speak in rhythm · 12-second local recording trials').pack(anchor='w', pady=(0, 12))
        self.case = tk.StringVar(value=CASES[0][0])
        self.case_box = ttk.Combobox(pane, textvariable=self.case, values=[c[0] for c in CASES], state='readonly')
        self.case_box.pack(fill='x')
        self.case_box.bind('<<ComboboxSelected>>', lambda _: self.select_case())
        self.lyrics = tk.Text(pane, height=3, wrap='word', bg='#101419', fg='#ffffff',
                              font=('Segoe UI', 19), relief='flat', padx=0, pady=12)
        self.lyrics.pack(fill='x')
        self.devices = []
        error = None
        if enumerate_devices:
            try:
                self.devices = list_input_devices()
            except Exception as exc:
                error = str(exc)
        names = [f"{d['index']}: {d['name']}" for d in self.devices]
        default = next((i for i, d in enumerate(self.devices) if d['default']), 0)
        self.device_box = ttk.Combobox(pane, values=names, state='readonly')
        self.device_box.pack(fill='x', pady=(0, 10))
        if names:
            self.device_box.current(default)
        controls = ttk.Frame(pane)
        controls.pack(fill='x')
        self.start_button = ttk.Button(controls, text='Start trial', command=self.start)
        self.start_button.pack(side='left')
        self.stop_button = ttk.Button(controls, text='Stop', command=self.stop, state='disabled')
        self.stop_button.pack(side='left', padx=8)
        self.prepare_button = ttk.Button(controls, text='Prepare word follower', command=self.prepare)
        self.prepare_button.pack(side='left')
        modes = ttk.Frame(pane)
        modes.pack(fill='x', pady=(8, 0))
        self.use_microphone = tk.BooleanVar(value=True)
        self.use_taps = tk.BooleanVar(value=False)
        self.microphone_check = ttk.Checkbutton(modes, text='Microphone', variable=self.use_microphone)
        self.microphone_check.pack(side='left')
        self.tap_check = ttk.Checkbutton(modes, text='Syllable taps (Space)', variable=self.use_taps)
        self.tap_check.pack(side='left', padx=8)
        self.tap_button = ttk.Button(modes, text='Tap', command=self.tap)
        self.tap_button.pack(side='right')
        settings = ttk.Frame(pane)
        settings.pack(fill='x', pady=10)
        ttk.Label(settings, text='Guide delay (ms)').pack(side='left')
        self.delay = tk.StringVar(value='0')
        ttk.Entry(settings, textvariable=self.delay, width=8).pack(side='left', padx=8)
        ttk.Label(settings, text='Uncalibrated input/output clocks').pack(side='left')
        self.canvas = tk.Canvas(pane, height=200, bg='#080c11', highlightthickness=0)
        self.canvas.pack(fill='both', expand=True)
        self.legend = ttk.Label(pane, text='Gold: acoustic onsets · Blue: word matches · Green: manual taps', wraplength=800)
        self.legend.pack(anchor='w', pady=(8, 3))
        self.status_text = tk.StringVar(value=error or 'Idle. Microphone opens only when you press Start.')
        self.status_label = ttk.Label(pane, textvariable=self.status_text, wraplength=800)
        self.status_label.pack(anchor='w')
        self.result_text = tk.StringVar(value='Spectral cues do not identify syllables. Word follower is optional and experimental.')
        self.result_label = ttk.Label(pane, textvariable=self.result_text, wraplength=800)
        self.result_label.pack(anchor='w', pady=4)
        ttk.Button(pane, text='Export numeric trial…', command=self.export).pack(anchor='e')
        root.bind('<Configure>', self.resize)
        root.bind('<KeyPress-space>', self.space_press)
        root.bind('<KeyRelease-space>', self.space_release)
        root.bind('<Escape>', lambda _: self.stop())
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.select_case()
        root.after(100, self.tick)

    def resize(self, event):
        if event.widget == self.root:
            width = max(400, event.width - 50)
            self.result_label.configure(wraplength=width)
            self.status_label.configure(wraplength=width)
            self.legend.configure(wraplength=width)

    def select_case(self):
        self.stop()
        _, phrase_id, self.clip_start = next(c for c in CASES if c[0] == self.case.get())
        self.phrase = next(p for p in self.package['score']['phrases'] if p['id'] == phrase_id)
        self.lyrics.configure(state='normal')
        self.lyrics.delete('1.0', 'end')
        self.lyrics.insert('1.0', ' '.join(w['text'] for w in self.phrase['words']))
        self.lyrics.configure(state='disabled')
        self.features.reset()
        self.events.clear()
        self.taps.clear()
        self.canvas.delete('all')
        self.render_key = None

    def prepare(self):
        if self.worker is not None or self.buffer.active:
            return
        self.prepare_button.configure(state='disabled')
        self.status_text.set('Loading the pinned local word model; no microphone capture.')
        self.stop_button.configure(state='normal')
        self.worker_started_at = time.monotonic()
        self.worker = GuideWorker()
        try:
            self.worker.start()
        except Exception as exc:
            self.stop()
            self.status_text.set(f'Follower unavailable: {exc}')

    def start(self):
        if self.buffer.active or (self.worker is not None and not self.worker.ready):
            return
        try:
            if not self.use_microphone.get() and not self.use_taps.get():
                raise ValueError('Enable microphone, syllable taps, or both.')
            delay = int(self.delay.get())
            if not -2000 <= delay <= 2000:
                raise ValueError('Delay must be between -2000 and 2000 ms.')
            device = None
            if self.use_microphone.get():
                if not self.devices or self.device_box.current() < 0:
                    raise ValueError('Select an available microphone.')
                device = self.devices[self.device_box.current()]['index']
            pcm = decode_clip(self.media, self.clip_start)
            import sounddevice as sd
            epoch = self.buffer.begin(self.clip_start, delay)
            self.trial_epoch = epoch
            self.trial_microphone_enabled = self.use_microphone.get()
            self.trial_taps_enabled = self.use_taps.get()
            self.features.reset()
            self.events.clear()
            self.taps.clear()
            self.space_down = False
            self.elapsed_ms = 0
            self.output_pcm, self.output_frame, self.output_done = pcm, 0, False
            self.mode = ('Acoustic cues + provisional word follower' if self.worker is not None
                         else 'Acoustic cues only') if self.use_microphone.get() else 'Manual syllable taps'
            def incoming(chunk):
                try:
                    self.input_queue.put_nowait((epoch, chunk))
                except queue.Full:
                    pass  # the next delivered frame exposes the gap and resets continuity
            def outgoing(outdata, frames, clock, status):
                start = self.output_frame * 2
                block = self.output_pcm[start:start + frames * 2]
                outdata[:] = block + bytes(frames * 2 - len(block))
                self.output_frame += frames
                if start + frames * 2 >= len(self.output_pcm):
                    self.output_done = True
                    raise sd.CallbackStop
            self.output = sd.RawOutputStream(samplerate=RATE, channels=1, dtype='int16',
                                              blocksize=320, callback=outgoing)
            if self.use_microphone.get():
                self.capture.start(device, incoming, consent=True, max_capture_seconds=12)
            self.output.start()
            self.started_at = time.monotonic()
            self.start_button.configure(state='disabled')
            self.stop_button.configure(state='normal')
            self.case_box.configure(state='disabled')
            self.device_box.configure(state='disabled')
            self.microphone_check.configure(state='disabled')
            self.tap_check.configure(state='disabled')
            self.prepare_button.configure(state='disabled')
            self.status_text.set(f'{self.mode}. ' + ('Microphone active. ' if self.use_microphone.get() else 'Microphone off. ') + ('Tap Space at each syllable change.' if self.use_taps.get() else 'Sing in rhythm.'))
            self.canvas.focus_set()
        except Exception as exc:
            self.stop()
            self.status_text.set(f'Could not start: {exc}')

    def stop(self):
        if self.buffer.active and self.started_at:
            self.elapsed_ms = min(CLIP_MS, round((time.monotonic() - self.started_at) * 1000))
        self.buffer.stop()
        self.space_down = False
        errors = []
        if self.worker is not None:
            try:
                self.worker.close()
            except Exception:
                errors.append('Word worker cleanup failed; close the application.')
            else:
                self.worker = None
        capture_status = self.capture.stop()
        if capture_status['state'] != 'stopped':
            errors.append('Microphone cleanup failed; press Stop to retry.')
        if self.output is not None:
            try:
                self.output.abort()
            except Exception:
                pass
            try:
                self.output.close()
            except Exception:
                errors.append('Playback cleanup failed; press Stop to retry.')
            else:
                self.output = None
        self.output_pcm = b''
        while not self.input_queue.empty():
            try:
                self.input_queue.get_nowait()
            except queue.Empty:
                break
        self.start_button.configure(state='disabled' if errors else 'normal')
        self.stop_button.configure(state='normal' if errors else 'disabled')
        self.case_box.configure(state='readonly')
        self.device_box.configure(state='readonly')
        self.microphone_check.configure(state='normal')
        self.tap_check.configure(state='normal')
        self.prepare_button.configure(state='disabled' if errors else 'normal')
        self.status_text.set(' '.join(errors) if errors else 'Stopped. Raw buffers cleared. Prepare the word follower again for another word-matching trial.')
        return not errors

    def space_press(self, event):
        if event.widget.winfo_class() in ('TEntry', 'Entry', 'TCombobox', 'Text'):
            return None
        if self.buffer.active and self.use_taps.get():
            if not self.space_down:
                self.space_down = True
                self.tap()
            return 'break'
        return None

    def space_release(self, event):
        self.space_down = False

    def tap(self):
        if not self.buffer.active or not self.use_taps.get() or len(self.taps) >= 512:
            return
        guide_ms = round((time.monotonic() - self.started_at) * 1000)
        if guide_ms < 0 or guide_ms > CLIP_MS or (self.taps and guide_ms - self.taps[-1]['guideTimeMs'] < 50):
            return
        self.taps.append({'ordinal': len(self.taps) + 1, 'guideTimeMs': guide_ms,
                          'approximateSourceMs': max(0, self.clip_start + guide_ms - self.buffer.delay_ms),
                          'kind': 'manual-syllable-change', 'unitId': None, 'calibrated': False})
        self.result_text.set(f'{len(self.taps)} manual syllable-change markers. Unassigned to lyric units; no score edits.')

    def tick(self):
        if self.closed:
            return
        while not self.input_queue.empty():
            epoch, chunk = self.input_queue.get_nowait()
            if not self.buffer.push(epoch, chunk):
                continue
            try:
                self.features.push_pcm16(chunk['pcmS16LE'], chunk['firstFrame'])
            except ValueError:
                self.features.reset(chunk['firstFrame'])
                self.features.push_pcm16(chunk['pcmS16LE'], chunk['firstFrame'])
        message = self.worker.poll() if self.worker is not None else None
        if message:
            if message['status'] == 'ready':
                self.status_text.set('Word follower ready. Press Start when ready to sing.')
            elif message['status'] == 'error':
                self.stop()
                self.status_text.set(f"Follower unavailable: {message.get('code', 'WORKER_FAILED')}")
            elif message['status'] == 'result':
                epoch, event = message['epoch'], message['event']
                if epoch == self.buffer.epoch and self.buffer.active:
                    self.events.append(event)
                    self.events = self.events[-100:]
                    self.result_text.set(f"{event['status']}: {event['reason']} · compute {event.get('processingMs', 0):.0f} ms · 2 s analysis window")
        now = time.monotonic()
        if self.worker is not None:
            expired = ((not self.worker.ready and now - self.worker_started_at > 20)
                       or (self.worker.busy and now - self.last_inference > 5))
            if expired:
                self.stop()
                self.status_text.set('Word worker timed out. Capture and playback stopped; prepare again to retry.')
        if self.buffer.active:
            self.elapsed_ms = min(CLIP_MS, round((now - self.started_at) * 1000))
            state = self.capture.status()
            if self.output_done or state['state'] in ('failed', 'limit_reached') or now - self.started_at > 13:
                self.stop()
            elif self.worker is not None and self.worker.ready and not self.worker.busy and now - self.last_inference >= .5:
                window = self.buffer.window()
                if window:
                    self.last_inference = now
                    epoch = self.buffer.epoch
                    pcm, source_ms = window
                    words = [{'id': w['id'], 'text': w['text']} for w in self.phrase['words']]
                    try:
                        self.worker.submit(words, pcm, epoch, source_ms)
                    except Exception:
                        self.stop()
                        self.status_text.set('Word worker failed; capture and playback stopped.')
        self.draw()
        self.root.after(100, self.tick)

    def draw(self):
        frames = self.features.snapshot()['frames']
        if not frames and not self.taps:
            return
        width, height = max(1, self.canvas.winfo_width()), max(1, self.canvas.winfo_height())
        render_key = (width, height, frames[-1]['centerSample'] if frames else None,
                      len(self.taps), len(self.events), self.elapsed_ms if not frames else None)
        if render_key == self.render_key:
            return
        self.render_key = render_key
        self.canvas.delete('all')
        if frames:
            matrix = np.asarray([f['spectrum'] for f in frames]).T[::-1]
            pixels = np.clip(matrix, 0, 1)
            yi = np.linspace(0, 31, height).astype(int)
            xi = np.linspace(0, len(frames) - 1, width).astype(int)
            values = pixels[yi[:, None], xi]
            rgb = np.stack((10 + values * 40, 15 + values * 150, 22 + values * 215), axis=-1).astype(np.uint8)
            ppm = f'P6\n{width} {height}\n255\n'.encode() + rgb.tobytes()
            self.photo = self.tk.PhotoImage(data=ppm, format='PPM')
            self.canvas.create_image(0, 0, image=self.photo, anchor='nw')
        start, end = (frames[0]['timeMs'], frames[-1]['timeMs']) if frames else (0, max(1000, self.elapsed_ms))
        def x(ms):
            return (ms - start) / max(1, end - start) * width
        for frame in frames:
            if frame['onsetDetected']:
                px = x(frame['timeMs'])
                self.canvas.create_line(px, height - 26, px, height, fill='#e7b65e', width=2)
        for event in self.events:
            if event['status'] == 'provisional':
                ms = event['approximateSourceStartMs'] - self.buffer.start_ms + self.buffer.delay_ms
                if start <= ms <= end:
                    px = x(ms)
                    self.canvas.create_line(px, 0, px, height - 26, fill='#80c4ff', width=2)
                    label = next((w['text'] for w in self.phrase['words'] if w['id'] == event['wordId']), event['wordId'])
                    self.canvas.create_text(px + 4, 26, text=label, anchor='nw', fill='#d9efff')
        for tap in self.taps:
            if start <= tap['guideTimeMs'] <= end:
                px = x(tap['guideTimeMs'])
                self.canvas.create_line(px, 0, px, height, fill='#8ce7b0', width=2)
                self.canvas.create_text(px + 4, height - 42, text=str(tap['ordinal']), fill='#b6ffd0', anchor='nw')
        self.canvas.create_text(8, 8, text=f'{start / 1000:.2f}–{end / 1000:.2f} s guide', anchor='nw', fill='white')

    def export(self):
        from tkinter import filedialog
        if self.buffer.active:
            self.status_text.set('Stop the trial before exporting numeric evidence.')
            return
        target = filedialog.asksaveasfilename(defaultextension='.json', filetypes=[('JSON', '*.json')])
        if not target:
            return
        payload = {'version': 'lyricvibe.guide-session.v1', 'source': self.package['score']['source'],
                   'sourceSha256': self.package['audio']['sha256'], 'scoreRevision': self.package['score']['revision'],
                   'phraseId': self.phrase['id'], 'clipStartMs': self.clip_start,
                   'guideDelayMs': self.buffer.delay_ms, 'calibrated': False, 'scoreMutation': False,
                   'clockBasis': 'input frame estimate; separate output/input latency and human delay unmeasured',
                   'mode': self.mode, 'captureStatus': self.capture.status() if self.trial_microphone_enabled else None,
                   'captureEpoch': self.trial_epoch,
                   'tapClockBasis': 'monotonic time since output.start returned; latency uncalibrated',
                   'microphoneEnabled': self.trial_microphone_enabled, 'tapsEnabled': self.trial_taps_enabled, 'taps': self.taps,
                   'events': self.events, 'features': self.features.snapshot()}
        # Never silently replace an earlier trial.
        try:
            with Path(target).open('x', encoding='utf-8') as output:
                json.dump(payload, output, indent=2)
        except FileExistsError:
            self.status_text.set('Existing file preserved. Choose a new export filename.')
            return
        except OSError:
            self.status_text.set('Export failed. Choose another destination and retry.')
            return
        self.status_text.set('Numeric evidence exported. No audio saved.')

    def close(self):
        if not self.stop():
            return
        self.closed = True
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--media', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--foreground', action='store_true', help='Show this trial window in front on launch.')
    args = parser.parse_args()
    package = load_bound_package(args.package, args.media)
    if args.check:
        print(json.dumps({'ok': True, 'sourceBound': True, 'microphoneOpened': False}))
        return
    import tkinter as tk
    root = tk.Tk()
    viewer = GuideViewer(root, package, args.media, enumerate_devices=not args.self_test)
    if args.foreground:
        root.title('LyricVibe · Guide vocals · Current trial')
        def foreground():
            root.lift()
            root.attributes('-topmost', True)
            root.focus_force()
            root.after(300, lambda: root.attributes('-topmost', False))
        root.after(100, foreground)
    if args.self_test:
        viewer.features.push_pcm16(np.zeros(3200, dtype='<i2').tobytes(), 0)
        for width, height in [(920, 650), (600, 550)]:
            root.geometry(f'{width}x{height}')
            root.update()
            viewer.draw()
            root.update()
            assert viewer.canvas.winfo_width() > 100 and viewer.canvas.winfo_height() >= 80
            assert str(viewer.stop_button['state']) == 'disabled'
        viewer.close()
        print(json.dumps({'ok': True, 'tkRender': True, 'microphoneOpened': False, 'viewports': [920, 600]}))
        return
    root.mainloop()


if __name__ == '__main__':
    main()
