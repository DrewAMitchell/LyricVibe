"""Review a numeric guide take locally; never capture audio or edit the input score."""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time

from .guide_grouping import GuideGroupingError, load_review, preview, apply_operation

ROOT = Path(__file__).resolve().parents[1]
DRAFT_VERSION = 'lyricvibe.guide-review-actions.v1'


class ReviewDocument:
    """Same revisioned actions for UI and agent replay, including lossless undo."""
    def __init__(self, package_path, session_path):
        self.package_path, self.session_path = Path(package_path), Path(session_path)
        self.state = load_review(self.package_path, self.session_path)
        self.package = json.loads(self.package_path.read_text(encoding='utf-8'))
        self.session = json.loads(self.session_path.read_text(encoding='utf-8'))
        self.frames = self.session.get('features', {}).get('frames', [])
        if not isinstance(self.frames, list) or len(self.frames) > 1200:
            raise GuideGroupingError('INVALID_FEATURES', 'Saved spectrum exceeds the review bound.')
        previous = -1
        for frame in self.frames:
            if (not isinstance(frame, dict) or not isinstance(frame.get('timeMs'), (int, float))
                    or not math.isfinite(frame['timeMs']) or not previous < frame['timeMs'] <= 12000
                    or not isinstance(frame.get('spectrum'), list) or len(frame['spectrum']) != 32
                    or any(isinstance(v, bool) or not isinstance(v, (int, float))
                           or not math.isfinite(v) or not 0 <= v <= 1 for v in frame['spectrum'])):
                raise GuideGroupingError('INVALID_FEATURES', 'Saved spectrum has invalid numeric frames.')
            previous = frame['timeMs']
        self.binding = {
            'packageSha256': hashlib.sha256(self.package_path.read_bytes()).hexdigest(),
            'sessionSha256': hashlib.sha256(self.session_path.read_bytes()).hexdigest(),
            'source': deepcopy(self.state['source']),
        }
        self.actions, self.history = [], []

    def act(self, operation, expected_revision):
        if type(expected_revision) is not int or expected_revision != self.state['reviewRevision']:
            raise GuideGroupingError('REVISION_CONFLICT', 'Review changed; reload before acting.')
        old = deepcopy(self.state)
        if operation == {'type': 'undo'}:
            if not self.history:
                raise GuideGroupingError('NOTHING_TO_UNDO', 'No earlier decision to restore.')
            self.state = self.history.pop()
            self.state['reviewRevision'] = expected_revision + 1
        else:
            self.state = apply_operation(self.state, expected_revision, operation)
            self.history.append(old)
        self.actions.append({'expectedRevision': expected_revision, 'operation': deepcopy(operation)})

    def replay(self, draft):
        if (not isinstance(draft, dict) or draft.get('version') != DRAFT_VERSION
                or draft.get('binding') != self.binding or not isinstance(draft.get('actions'), list)
                or len(draft['actions']) > 5000):
            raise GuideGroupingError('DRAFT_MISMATCH', 'Draft does not match this exact take and package.')
        candidate = ReviewDocument(self.package_path, self.session_path)
        for action in draft['actions']:
            candidate.act(action['operation'], action['expectedRevision'])
        self.state, self.actions, self.history = candidate.state, candidate.actions, candidate.history

    def draft(self):
        return {'version': DRAFT_VERSION, 'binding': deepcopy(self.binding), 'actions': deepcopy(self.actions),
                'preview': preview(self.state), 'calibrated': False,
                'automaticAdmissionEnabled': False, 'scoreMutation': False}

    def score_preview(self, human_confirmed=False):
        if self.package['score'].get('offsetMs', 0) != 0:
            raise GuideGroupingError('OFFSET_REVIEW_REQUIRED', 'Guide review currently requires a zero score offset.')
        snapshot = preview(self.state)
        if any(t['assignmentStatus'] == 'unreviewed' or t['blockers'] for t in snapshot['taps']):
            raise GuideGroupingError('REVIEW_INCOMPLETE', 'Review every tap and resolve blocked groups first.')
        if any(g['requiresRelease'] for g in snapshot['groups']):
            raise GuideGroupingError('RELEASE_REQUIRED', 'Type the final lyric release before previewing.')
        units = [{k: u[k] for k in ('wordId', 'syllableId', 'startMs', 'endMs')}
                 for u in snapshot['closedUnits']]
        if not units:
            raise GuideGroupingError('NO_CLOSED_UNITS', 'Assign and close at least one lyric group.')
        executable = shutil.which('node')
        if not executable:
            raise GuideGroupingError('NODE_UNAVAILABLE', 'Node.js is required for shared score validation.')
        result = subprocess.run([executable, str(ROOT / 'scripts/guide-score-preview.cjs')],
                                input=json.dumps({'score': self.package['score'],
                                                  'expectedRevision': self.package['score']['revision'],
                                                  'units': units, 'humanConfirmed': human_confirmed}),
                                capture_output=True, text=True, timeout=10,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        output = json.loads(result.stdout)
        if not output.get('ok'):
            raise GuideGroupingError(output['error']['code'], output['error']['message'])
        return output


def write_new(path, value):
    with Path(path).open('x', encoding='utf-8') as target:
        json.dump(value, target, indent=2, allow_nan=False)
        target.write('\n')


def decode_audition(media, start_ms, stop):
    """Own/reap the decoder; Stop is checked at most 100 ms apart."""
    executable = shutil.which('ffmpeg')
    if not executable: raise ValueError('FFmpeg is unavailable.')
    if stop.is_set(): return b''
    process = subprocess.Popen([executable, '-nostdin', '-v', 'error', '-ss', str(start_ms / 1000),
                                '-i', str(media), '-t', '3', '-vn', '-ac', '1', '-ar', '16000',
                                '-f', 's16le', 'pipe:1'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    deadline = time.monotonic() + 15
    try:
        while not stop.is_set() and time.monotonic() < deadline:
            try:
                pcm, _ = process.communicate(timeout=.1)
                if process.returncode or not 0 < len(pcm) <= 96000: raise ValueError('Decoder failed.')
                return pcm
            except subprocess.TimeoutExpired: continue
        if stop.is_set(): return b''
        raise TimeoutError('Decoder exceeded its 15-second lease.')
    finally:
        if process.poll() is None: process.kill()
        process.communicate(timeout=2)


class GuideReview:
    def __init__(self, root, document, media=None):
        import tkinter as tk
        from tkinter import ttk
        self.root, self.doc, self.media = root, document, Path(media) if media else None
        self.tk, self.ttk = tk, ttk
        self.play_stop = threading.Event()
        self.messages = queue.Queue()
        self.play_thread = None
        self.closed = False
        self.selected = 1
        self.dirty = False
        self.snapshot = preview(document.state)
        self.phrase = next(p for p in self.doc.package['score']['phrases']
                           if p['id'] == self.doc.state['source']['phraseId'])
        self.words = {w['id']: w for w in self.phrase['words']}
        self.labels = {w['id']: w['text'] for w in self.phrase['words']}
        self.labels.update({'@word:' + w['id']: w['text'] + ' · word' for w in self.phrase['words']})
        for word in self.phrase['words']:
            for syllable in word.get('syllables', []):
                self.labels[syllable['id']] = word['text'] + ' / ' + syllable['text']
        root.title('LyricVibe · Review your take')
        root.geometry('920x760')
        root.minsize(600, 650)
        root.configure(background='#15191e')
        style = ttk.Style(root)
        style.theme_use('clam')
        style.configure('.', background='#15191e', foreground='#e7e9ed', font=('Segoe UI', 10))
        style.configure('TButton', padding=(10, 6), background='#29313b')
        style.configure('TCombobox', fieldbackground='#26303a', background='#26303a')
        style.map('TCombobox', fieldbackground=[('readonly', '#26303a')], foreground=[('readonly', '#e7e9ed')])
        style.configure('TEntry', fieldbackground='#26303a', foreground='#e7e9ed', insertcolor='#e7e9ed')
        style.configure('Treeview', background='#20262e', fieldbackground='#20262e',
                        foreground='#e7e9ed', rowheight=28)
        style.map('Treeview', background=[('selected', '#355b71')])
        style.configure('Treeview.Heading', background='#29313b', padding=5)
        outer = ttk.Frame(root, padding=16)
        outer.grid(sticky='nsew')
        root.rowconfigure(0, weight=1); root.columnconfigure(0, weight=1)
        outer.columnconfigure(0, weight=1); outer.rowconfigure(5, weight=1)
        title = self.doc.package['score']['source'].get('title', 'Guide take')
        ttk.Label(outer, text=title, font=('Segoe UI', 18, 'bold')).grid(row=0, sticky='w')
        self.lyrics = ttk.Label(outer, text=' '.join(w['text'] for w in self.phrase['words']),
                                font=('Segoe UI', 13), wraplength=850)
        self.lyrics.grid(row=1, sticky='ew', pady=(8, 8))
        self.summary = tk.StringVar()
        ttk.Label(outer, textvariable=self.summary).grid(row=2, sticky='w', pady=(0, 6))
        self.canvas = tk.Canvas(outer, height=130, background='#101419', highlightthickness=0)
        self.canvas.grid(row=3, sticky='ew')
        self.canvas.bind('<Configure>', lambda _: self.draw())
        self.canvas.bind('<Button-1>', self.pick)
        ttk.Label(outer, text='Your saved guide spectrum + taps · source-time estimates · no guide audio retained',
                  wraplength=850).grid(row=4, sticky='w', pady=(5, 8))
        table = ttk.Frame(outer)
        table.grid(row=5, sticky='nsew')
        table.rowconfigure(0, weight=1); table.columnconfigure(0, weight=1)
        self.tree = ttk.Treeview(table, columns=('time', 'meaning', 'lyric'), show='tree headings', height=6)
        self.tree.heading('#0', text='Tap'); self.tree.column('#0', width=50, minwidth=40, stretch=False)
        for key, heading, width in [('time', 'Source (ms)', 100), ('meaning', 'Meaning', 115), ('lyric', 'Lyric / issue', 260)]:
            self.tree.heading(key, text=heading); self.tree.column(key, width=width, minwidth=70)
        self.tree.grid(row=0, column=0, sticky='nsew')
        scroll = ttk.Scrollbar(table, orient='vertical', command=self.tree.yview)
        scroll.grid(row=0, column=1, sticky='ns'); self.tree.configure(yscrollcommand=scroll.set)
        self.tree.bind('<<TreeviewSelect>>', self.selection)
        self.tree.bind('<Key-e>', lambda _: self.entrance())
        self.tree.bind('<Key-n>', lambda _: self.apply({'type': 'assignNote'}))
        self.tree.bind('<Key-i>', lambda _: self.apply({'type': 'ignore'}))
        decisions = ttk.Frame(outer); decisions.grid(row=6, sticky='ew', pady=(12, 0))
        decisions.columnconfigure(1, weight=1)
        ttk.Label(decisions, text='Lyric unit').grid(row=0, column=0, padx=(0, 8))
        self.unit_choice = tk.StringVar()
        self.units = []
        self.combo = ttk.Combobox(decisions, state='readonly', textvariable=self.unit_choice)
        self.combo.grid(row=0, column=1, sticky='ew')
        buttons = ttk.Frame(outer); buttons.grid(row=7, sticky='ew', pady=(8, 4))
        for label, callback in [('Entrance', self.entrance), ('Note change', lambda: self.apply({'type': 'assignNote'})),
                                ('Ignore', lambda: self.apply({'type': 'ignore'})),
                                ('Clear', lambda: self.apply({'type': 'clear'})), ('Undo', self.undo)]:
            ttk.Button(buttons, text=label, command=callback).pack(side='left', padx=(0, 5))
        timing = ttk.Frame(outer); timing.grid(row=8, sticky='ew', pady=(4, 8))
        ttk.Label(timing, text='Final release (source ms)').pack(side='left')
        self.release = tk.StringVar()
        ttk.Entry(timing, textvariable=self.release, width=10).pack(side='left', padx=8)
        ttk.Button(timing, text='Set release', command=self.set_release).pack(side='left')
        audition = ttk.Frame(outer); audition.grid(row=9, sticky='ew')
        self.play_button = ttk.Button(audition, text='Hear original near tap', command=self.play)
        self.play_button.pack(side='left')
        if not self.media: self.play_button.state(['disabled'])
        ttk.Button(audition, text='Stop', command=self.stop).pack(side='left', padx=5)
        ttk.Button(audition, text='Preview score', command=self.show_preview).pack(side='right')
        files = ttk.Frame(outer); files.grid(row=10, sticky='ew', pady=(8, 0))
        ttk.Button(files, text='Open review draft', command=self.load_draft).pack(side='left')
        ttk.Button(files, text='Save review draft', command=self.save_draft).pack(side='left', padx=5)
        self.status = tk.StringVar(value='Select a tap, then choose its lyric and meaning. Note changes stay inside the preceding entrance.')
        self.status_label = ttk.Label(outer, textvariable=self.status, wraplength=850)
        self.status_label.grid(row=11, sticky='ew', pady=(10, 0))
        outer.bind('<Configure>', lambda e: self.wrap(e.width))
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.refresh()
        root.after(100, self.poll)

    def wrap(self, width):
        self.lyrics.configure(wraplength=max(400, width - 10))
        self.status_label.configure(wraplength=max(400, width - 10))

    def refresh(self):
        self.snapshot = preview(self.doc.state)
        self.units = []
        for word in self.phrase['words']:
            self.units.append((word['text'] + '  · whole word', {'type': 'assignWordEntrance', 'wordId': word['id']}))
            for unit in self.snapshot['units']:
                if unit.get('parentWordId') == word['id'] and unit.get('kind') == 'syllable':
                    self.units.append((self.labels[unit['unitId']] + '  · syllable', {'type': 'assignEntrance', 'unitId': unit['unitId']}))
        old_choice = self.unit_choice.get()
        self.combo['values'] = [u[0] for u in self.units]
        if old_choice not in self.combo['values'] and self.units: self.combo.current(0)
        self.tree.delete(*self.tree.get_children())
        for tap in self.snapshot['taps']:
            label = self.labels.get(tap['unitId'], '')
            group = next((g for g in self.snapshot['groups'] if g['tapOrdinal'] == tap['ordinal']), None)
            if group:
                end = group['endMs'] if group['endMs'] is not None else '? release'
                label += f" · {group['startMs']}–{end}"
            if tap['assignmentStatus'] == 'note': label = f"Within tap {tap['parentTapOrdinal']}"
            if tap['blockers']: label += ' · ' + ', '.join(tap['blockers'])
            self.tree.insert('', 'end', iid=str(tap['ordinal']), text=str(tap['ordinal']),
                             values=(tap['sourceTimeEstimateMs'], tap['assignmentStatus'], label))
        remaining = sum(t['assignmentStatus'] == 'unreviewed' for t in self.snapshot['taps'])
        self.summary.set(f"{len(self.snapshot['taps'])} taps · {remaining} to review · {len(self.snapshot['groups'])} lyric groups · uncalibrated")
        if self.tree.exists(str(self.selected)):
            self.tree.selection_set(str(self.selected)); self.tree.see(str(self.selected))
        self.draw()

    def selection(self, _=None):
        selected = self.tree.selection()
        if selected: self.selected = int(selected[0]); self.draw()

    def pick(self, event):
        taps = self.snapshot['taps']
        if taps:
            value = self.doc.session['clipStartMs'] + event.x / max(1, self.canvas.winfo_width()) * 12000
            self.selected = min(taps, key=lambda t: abs(t['sourceTimeEstimateMs'] - value))['ordinal']
            self.tree.selection_set(str(self.selected)); self.tree.see(str(self.selected))

    def draw(self):
        if not hasattr(self, 'canvas'): return
        canvas = self.canvas
        width, height = max(1, canvas.winfo_width()), 130
        start = self.doc.session['clipStartMs'] - self.doc.session['guideDelayMs']
        def x(ms): return (ms - start) / 12000 * width
        if getattr(self, '_spectrum_width', None) != width:
            canvas.delete('all'); self._spectrum_width = width
            for frame in self.doc.frames[::2]:
                left = x(start + frame['timeMs'])
                for band, value in enumerate(frame['spectrum']):
                    strength = max(0, min(1, float(value)))
                    color = '#%02x%02x%02x' % (int(14 + 35 * strength), int(24 + 150 * strength), int(30 + 165 * strength))
                    y = 103 - band * 3
                    canvas.create_rectangle(left, y, left + max(2, width / 400), y + 3, fill=color, outline='')
        canvas.delete('markers')
        colors = {'unreviewed': '#9aa6b3', 'entrance': '#75dbb5', 'note': '#c5a5f4', 'ignored': '#4d5661'}
        for tap in self.snapshot['taps']:
            left = x(tap['sourceTimeEstimateMs'])
            canvas.create_line(left, 5, left, 107, fill=colors[tap['assignmentStatus']], width=3 if tap['ordinal'] == self.selected else 1, tags='markers')
            canvas.create_text(left, 117 if tap['ordinal'] % 2 else 127, text=str(tap['ordinal']), fill=colors[tap['assignmentStatus']], font=('Segoe UI', 8), tags='markers')

    def apply(self, operation):
        try:
            self.doc.act(dict(operation, tapOrdinal=self.selected), self.doc.state['reviewRevision'])
            if operation['type'] in ('assignWordEntrance', 'assignEntrance', 'assignNote', 'ignore'):
                next_tap = next((t for t in self.doc.state['taps'] if t['ordinal'] > self.selected), None)
                if next_tap: self.selected = next_tap['ordinal']
            if operation['type'] == 'assignWordEntrance':
                word_ids = list(self.words)
                word_index = word_ids.index(operation['wordId'])
                if word_index + 1 < len(word_ids):
                    next_word = self.words[word_ids[word_index + 1]]
                    self.unit_choice.set(next_word['text'] + '  · whole word')
            self.dirty = True; self.refresh()
            self.status.set('Decision saved in this draft. The original score is unchanged.')
        except (GuideGroupingError, ValueError) as error: self.error(error)

    def entrance(self):
        index = self.combo.current()
        if index >= 0: self.apply(self.units[index][1])

    def set_release(self):
        try: self.apply({'type': 'setRelease', 'endMs': int(self.release.get())})
        except ValueError: self.status.set('Enter an integer source time in milliseconds.')

    def undo(self):
        try:
            self.doc.act({'type': 'undo'}, self.doc.state['reviewRevision'])
            self.dirty = True; self.refresh(); self.status.set('Restored the previous decision.')
        except GuideGroupingError as error: self.error(error)

    def error(self, error):
        self.status.set(f"{getattr(error, 'code', 'REVIEW_FAILED')}: {error}")

    def save_draft(self):
        from tkinter import filedialog
        path = filedialog.asksaveasfilename(parent=self.root, title='Save review draft as a new file',
                                          defaultextension='.json', initialfile='guide-stone-review.json')
        if path:
            try: write_new(path, self.doc.draft()); self.dirty = False; self.status.set('Review draft saved. It contains numeric decisions, no audio.')
            except (OSError, ValueError) as error: self.error(error)

    def load_draft(self):
        from tkinter import filedialog, messagebox
        if self.dirty and not messagebox.askyesno('Unsaved review', 'Replace the current unsaved review?', parent=self.root): return
        path = filedialog.askopenfilename(parent=self.root, title='Open matching review draft', filetypes=[('JSON', '*.json')])
        if path:
            try:
                if Path(path).stat().st_size > 5 * 1024 * 1024: raise ValueError('Draft exceeds 5 MiB.')
                self.doc.replay(json.loads(Path(path).read_text(encoding='utf-8')))
                self.dirty = False; self.refresh(); self.status.set('Restored decisions for this exact take.')
            except (OSError, ValueError, KeyError, TypeError) as error: self.error(error)

    def show_preview(self):
        from tkinter import messagebox, filedialog
        try:
            result = self.doc.score_preview()
            if not messagebox.askyesno('Review score copy', f"{result['finalRevision'] - result['initialRevision']} timing changes validated.\nGuide timing is uncalibrated. Export a separate score copy?", parent=self.root): return
            path = filedialog.asksaveasfilename(parent=self.root, title='Save a separate score copy', defaultextension='.json', initialfile='guide-score-copy.json')
            if path:
                result = self.doc.score_preview(True)
                write_new(path, result['previewScore'])
                self.status.set('Separate score copy saved. Original unchanged; automatic admission remains off.')
        except (OSError, ValueError, subprocess.SubprocessError) as error: self.error(error)

    def play(self):
        if self.play_thread and self.play_thread.is_alive(): self.status.set('Stop the current audition before starting another.'); return
        self.play_stop.clear()
        tap = next(t for t in self.snapshot['taps'] if t['ordinal'] == self.selected)
        start = max(0, tap['sourceTimeEstimateMs'] - 600)
        self.status.set('Preparing a bounded original-recording audition…')
        def worker():
            try:
                from .guide_viewer import load_bound_package
                import sounddevice as sd
                if self.play_stop.is_set(): return
                load_bound_package(self.doc.package_path, self.media)
                pcm = decode_audition(self.media, start, self.play_stop)
                if self.play_stop.is_set(): return
                self.messages.put('Playing original recording for up to 3 seconds; your guide audio was not saved.')
                position = 0
                finished = threading.Event()
                def output(buffer, frames, _time, _status):
                    nonlocal position
                    buffer[:] = bytes(len(buffer))
                    if self.play_stop.is_set(): raise sd.CallbackAbort
                    chunk = pcm[position:position + frames * 2]
                    buffer[:len(chunk)] = chunk
                    position += len(chunk)
                    if position >= len(pcm): raise sd.CallbackStop
                with sd.RawOutputStream(samplerate=16000, channels=1, dtype='int16', blocksize=320,
                                        callback=output, finished_callback=finished.set) as stream:
                    until = time.monotonic() + 5
                    while not finished.wait(.05) and time.monotonic() < until:
                        if self.play_stop.is_set(): stream.abort(); break
                self.messages.put('Audition stopped.')
            except Exception:
                self.messages.put('PLAYBACK_FAILED: Check the original recording, FFmpeg and output device.')
        self.play_thread = threading.Thread(target=worker, daemon=False)
        self.play_thread.start()

    def stop(self): self.play_stop.set()

    def poll(self):
        while not self.messages.empty(): self.status.set(self.messages.get_nowait())
        if not self.closed: self.root.after(100, self.poll)

    def close(self):
        from tkinter import messagebox
        if self.dirty and not messagebox.askyesno('Unsaved review', 'Close without saving these review decisions?', parent=self.root): return
        self.stop()
        def finish():
            if self.play_thread and self.play_thread.is_alive():
                self.status.set('Stopping audition and closing its decoder…')
                self.root.after(100, finish)
            else:
                self.closed = True; self.root.destroy()
        finish()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--session', required=True, type=Path)
    parser.add_argument('--media', type=Path)
    parser.add_argument('--actions', type=Path, help='Replay an exact-bound numeric draft before opening/checking.')
    parser.add_argument('--check', action='store_true', help='Print numeric review preview; no devices or GUI.')
    parser.add_argument('--self-test', action='store_true', help='Render actual widgets at wide and narrow sizes; no audio.')
    parser.add_argument('--foreground', action='store_true')
    args = parser.parse_args()
    try:
        document = ReviewDocument(args.package, args.session)
        if args.actions:
            if args.actions.stat().st_size > 5 * 1024 * 1024: raise ValueError('Draft exceeds 5 MiB.')
            document.replay(json.loads(args.actions.read_text(encoding='utf-8')))
        if args.check:
            print(json.dumps(preview(document.state))); return 0
        import tkinter as tk
        root = tk.Tk(); app = GuideReview(root, document, args.media)
        if args.self_test:
            for width, height in [(920, 760), (600, 650)]:
                root.geometry(f'{width}x{height}'); root.update()
                for widget in [app.combo, app.tree, app.play_button, app.status_label]:
                    assert widget.winfo_viewable() and widget.winfo_rootx() + widget.winfo_width() <= root.winfo_rootx() + root.winfo_width()
                    assert widget.winfo_rooty() + widget.winfo_height() <= root.winfo_rooty() + root.winfo_height()
            original = deepcopy(document.state)
            app.apply({'type': 'ignore'}); root.update()
            assert document.state['reviewRevision'] == 1
            app.undo(); root.update()
            assert all(t['assignmentStatus'] == 'unreviewed' for t in document.state['taps'])
            assert document.state['reviewRevision'] == 2
            restored = ReviewDocument(args.package, args.session)
            restored.replay(document.draft())
            assert restored.state == document.state
            assert original['taps'] == restored.state['taps']
            app.closed = True; root.destroy(); print(json.dumps({'ok': True, 'pid': os.getpid(), 'geometry': ['920x760', '600x650'], 'audioOpened': False})); return 0
        if args.foreground:
            root.lift(); root.attributes('-topmost', True); root.focus_force()
            root.after(300, lambda: root.attributes('-topmost', False))
        root.mainloop(); return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'ok': False, 'code': getattr(error, 'code', 'REVIEW_FAILED')})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
