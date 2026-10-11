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
from .guide_review_flow import derive_review_flow
from .guide_audio_feedback import add_tap_clicks

ROOT = Path(__file__).resolve().parents[1]
DRAFT_VERSION = 'lyricvibe.guide-review-actions.v1'


class ReviewDocument:
    """Same revisioned actions for UI and agent replay, including lossless undo."""
    def __init__(self, package_path, session_path):
        self.package_path, self.session_path = Path(package_path), Path(session_path)
        def read_once(path):
            with path.open('rb') as source: data = source.read(5 * 1024 * 1024 + 1)
            if len(data) > 5 * 1024 * 1024:
                raise GuideGroupingError('INPUT_TOO_LARGE', 'Review input exceeds 5 MiB.')
            return data, json.loads(data.decode('utf-8'))
        package_bytes, self.package = read_once(self.package_path)
        session_bytes, self.session = read_once(self.session_path)
        self.state = load_review(self.package, self.session)
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
            'packageSha256': hashlib.sha256(package_bytes).hexdigest(),
            'sessionSha256': hashlib.sha256(session_bytes).hexdigest(),
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
        if candidate.binding != self.binding:
            raise GuideGroupingError('INPUT_CHANGED', 'Original take or package changed; reopen the matching inputs.')
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


def decode_audition(media, start_ms, stop, duration_seconds=3):
    """Own/reap the decoder; Stop is checked at most 100 ms apart."""
    if duration_seconds not in (3, 12): raise ValueError('Audition must be 3 or 12 seconds.')
    executable = shutil.which('ffmpeg')
    if not executable: raise ValueError('FFmpeg is unavailable.')
    if stop.is_set(): return b''
    process = subprocess.Popen([executable, '-nostdin', '-v', 'error', '-ss', str(start_ms / 1000),
                                '-i', str(media), '-t', str(duration_seconds), '-vn', '-ac', '1', '-ar', '16000',
                                '-f', 's16le', 'pipe:1'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    deadline = time.monotonic() + 15
    try:
        while not stop.is_set() and time.monotonic() < deadline:
            try:
                pcm, _ = process.communicate(timeout=.1)
                if process.returncode or not 0 < len(pcm) <= duration_seconds * 32000: raise ValueError('Decoder failed.')
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
        self.play_epoch = 0
        self.playback_state = 'stopped'
        self.playback_clock = None
        self.playback_ms = None
        self.audition_start_ms = None
        self.closed, self.dirty = False, False
        self.selected = 1
        self.snapshot = preview(document.state)
        self.phrase = next(p for p in self.doc.package['score']['phrases']
                           if p['id'] == self.doc.state['source']['phraseId'])
        self.words = {w['id']: w for w in self.phrase['words']}
        self.labels = {w['id']: w['text'] for w in self.phrase['words']}
        self.labels.update({'@word:' + w['id']: w['text'] for w in self.phrase['words']})
        for word in self.phrase['words']:
            for syllable in word.get('syllables', []):
                self.labels[syllable['id']] = word['text'] + ' / ' + syllable['text']
        root.title('LyricVibe · Guided timing review')
        root.geometry('960x780')
        root.minsize(600, 650)
        root.configure(background='#111417')
        style = ttk.Style(root)
        style.theme_use('clam')
        style.configure('.', background='#111417', foreground='#edf1f5', font=('Segoe UI', 10))
        style.configure('TButton', padding=(12, 9), background='#252c34', foreground='#edf1f5',
                        borderwidth=1, relief='flat', focusthickness=2, focuscolor='#a8e6cf')
        style.map('TButton', background=[('active', '#35414d')], foreground=[('disabled', '#78838f')])
        style.configure('Primary.TButton', background='#afe8d0', foreground='#12281f',
                        font=('Segoe UI', 10, 'bold'))
        style.map('Primary.TButton', background=[('active', '#d0f6e6')], foreground=[('active', '#12281f')])
        style.configure('Quiet.TButton', background='#111417', borderwidth=0, padding=(9, 6))
        style.configure('Chip.TButton', background='#20272e', padding=(10, 7), borderwidth=1)
        style.configure('Chosen.Chip.TButton', background='#afe8d0', foreground='#12281f')
        style.map('Chosen.Chip.TButton', background=[('active', '#d0f6e6')], foreground=[('active', '#12281f')])
        style.configure('Muted.TLabel', foreground='#a3adb9')
        style.configure('Surface.TFrame', background='#1a2026')
        style.configure('Surface.TLabel', background='#1a2026')
        style.configure('TEntry', fieldbackground='#252e37', foreground='#edf1f5',
                        insertcolor='#edf1f5', padding=8)
        style.configure('TCombobox', fieldbackground='#252e37', background='#252e37')
        style.map('TCombobox', fieldbackground=[('readonly', '#252e37')], foreground=[('readonly', '#edf1f5')])
        style.configure('Treeview', background='#1a2026', fieldbackground='#1a2026',
                        foreground='#edf1f5', rowheight=30)
        style.map('Treeview', background=[('selected', '#36576a')])
        style.configure('Treeview.Heading', background='#252c34', padding=8)
        style.configure('Horizontal.TProgressbar', background='#afe8d0', troughcolor='#252c34', borderwidth=0)
        outer = ttk.Frame(root, padding=(20, 12))
        self.outer = outer
        outer.grid(sticky='nsew')
        root.rowconfigure(0, weight=1); root.columnconfigure(0, weight=1)
        outer.columnconfigure(0, weight=1); outer.rowconfigure(6, weight=1)
        header = ttk.Frame(outer); header.grid(row=0, sticky='ew')
        ttk.Label(header, text='LYRICVIBE  /  GUIDE TAKE', style='Muted.TLabel',
                  font=('Segoe UI', 9, 'bold')).pack(side='left')
        ttk.Button(header, text='Open Draft…', style='Quiet.TButton', command=self.load_draft).pack(side='right')
        title = self.doc.package['score']['source'].get('title', 'Your guide take')
        self.lyrics = ttk.Label(outer, text=title, font=('Segoe UI', 19, 'bold'), wraplength=880)
        self.lyrics.grid(row=1, sticky='ew', pady=(4, 6))
        self.step_text = tk.StringVar(value='1  Group Taps     →     2  Mark Release     →     3  Save Timing')
        ttk.Label(outer, textvariable=self.step_text, style='Muted.TLabel').grid(row=2, sticky='w', pady=(0, 6))
        self.summary = tk.StringVar()
        progress_row = ttk.Frame(outer); progress_row.grid(row=3, sticky='ew', pady=(0, 8))
        ttk.Label(progress_row, textvariable=self.summary, style='Muted.TLabel').pack(side='left')
        self.progress = ttk.Progressbar(progress_row, length=140, mode='determinate')
        self.progress.pack(side='right')
        self.canvas = tk.Canvas(outer, height=100, background='#0b1014',
                                highlightthickness=1, highlightbackground='#303943')
        self.canvas.grid(row=4, sticky='ew')
        self.canvas.bind('<Configure>', lambda _: self.draw())
        self.canvas.bind('<Button-1>', self.pick)
        transport = ttk.Frame(outer); transport.grid(row=5, sticky='ew', pady=(8, 8))
        self.play_button = ttk.Button(transport, text='▶  Hear This Tap', command=self.play)
        self.play_button.pack(side='left')
        self.take_button = ttk.Button(transport, text='▶  Full Take', command=lambda: self.play(whole_take=True))
        self.take_button.pack(side='left', padx=(6, 0))
        self.stop_button = ttk.Button(transport, text='■  Stop', command=self.stop)
        self.stop_button.pack(side='left', padx=(6, 12))
        self.clicks = tk.BooleanVar(value=True)
        ttk.Checkbutton(transport, text='Tap Clicks', variable=self.clicks).pack(side='left')
        self.playback_text = tk.StringVar(value='■  Stopped')
        ttk.Label(outer, textvariable=self.playback_text, style='Muted.TLabel',
                  font=('Consolas', 10)).grid(row=9, sticky='w', pady=(4, 0))
        self.decision_surface = ttk.Frame(outer, style='Surface.TFrame', padding=14)
        self.decision_surface.grid(row=6, sticky='nsew')
        self.decision_surface.columnconfigure(0, weight=1)
        self.focus_heading = tk.StringVar()
        ttk.Label(self.decision_surface, textvariable=self.focus_heading, style='Surface.TLabel',
                  font=('Consolas', 10)).grid(row=0, sticky='w')
        self.task_text = tk.StringVar(value='Which lyric begins at this tap?')
        self.task_label = ttk.Label(self.decision_surface, textvariable=self.task_text, style='Surface.TLabel',
                                    font=('Segoe UI', 16, 'bold'), wraplength=820)
        self.task_label.grid(row=1, sticky='w', pady=(8, 4))
        self.focus_group = tk.StringVar()
        self.group_label = ttk.Label(self.decision_surface, textvariable=self.focus_group,
                                    style='Surface.TLabel', wraplength=820)
        self.group_label.grid(row=2, sticky='w', pady=(0, 12))
        self.unit_choice = tk.StringVar()
        self.chosen_unit_index = 0
        self.units = []
        self.combo = ttk.Combobox(self.decision_surface, state='readonly', textvariable=self.unit_choice)
        self.chip_frame = ttk.Frame(self.decision_surface, style='Surface.TFrame')
        self.chip_frame.grid(row=3, sticky='ew', pady=(0, 12))
        self.chip_buttons = []
        self.chip_indexes = []
        self.chip_frame.bind('<Configure>', lambda _: self.layout_chips())
        self.actions_frame = ttk.Frame(self.decision_surface, style='Surface.TFrame')
        self.actions_frame.grid(row=4, sticky='ew')
        self.entrance_button = ttk.Button(self.actions_frame, text='↳  Mark Entrance',
                                          style='Primary.TButton', command=self.entrance)
        self.entrance_button.pack(side='left')
        self.note_button = ttk.Button(self.actions_frame, text='♫  Another Note', command=lambda: self.apply({'type': 'assignNote'}))
        self.note_button.pack(side='left', padx=6)
        ttk.Button(self.actions_frame, text='×  Ignore Tap', command=lambda: self.apply({'type': 'ignore'})).pack(side='left')
        self.release_frame = ttk.Frame(self.decision_surface, style='Surface.TFrame')
        self.release = tk.StringVar()
        ttk.Label(self.release_frame, text='Release (source ms)', style='Surface.TLabel').pack(side='left')
        ttk.Entry(self.release_frame, textvariable=self.release, width=9).pack(side='left', padx=8)
        ttk.Button(self.release_frame, text='Use Playhead', command=self.release_at_playhead).pack(side='left', padx=(0, 6))
        ttk.Button(self.release_frame, text='Set Release', style='Primary.TButton', command=self.set_release).pack(side='left')
        self.status = tk.StringVar(value='Choose a lyric → Mark Entrance. A held note change → Another Note.')
        self.status_label = ttk.Label(self.decision_surface, textvariable=self.status, style='Surface.TLabel', wraplength=820)
        self.status_label.grid(row=2, sticky='ew', pady=(0, 12))
        navigation = ttk.Frame(outer); navigation.grid(row=7, sticky='ew', pady=(6, 0))
        ttk.Button(navigation, text='◀  Previous Tap', style='Quiet.TButton', command=lambda: self.move(-1)).pack(side='left')
        ttk.Button(navigation, text='Next Tap  ▶', style='Quiet.TButton', command=lambda: self.move(1)).pack(side='left', padx=4)
        ttk.Button(navigation, text='↶  Undo', style='Quiet.TButton', command=self.undo).pack(side='right')
        ttk.Button(navigation, text='Clear Tap', style='Quiet.TButton', command=lambda: self.apply({'type': 'clear'})).pack(side='right')
        footer = ttk.Frame(outer); footer.grid(row=8, sticky='ew', pady=(6, 0))
        ttk.Button(footer, text='Tap Details…', style='Quiet.TButton', command=self.show_details).pack(side='left')
        ttk.Button(footer, text='Save Draft…', command=self.save_draft).pack(side='right')
        self.preview_button = ttk.Button(footer, text='Review Timing…', style='Primary.TButton', command=self.show_preview)
        self.preview_button.pack(side='right', padx=8)
        self.tree = ttk.Treeview(outer, columns=('time', 'meaning', 'lyric'), show='tree headings')
        for key, heading in [('#0', 'Tap'), ('time', 'Source (ms)'), ('meaning', 'Meaning'), ('lyric', 'Lyric / Issue')]:
            self.tree.heading(key, text=heading); self.tree.column(key, width=80 if key != 'lyric' else 240)
        self.tree.bind('<<TreeviewSelect>>', self.selection)
        outer.bind('<Configure>', lambda e: self.wrap(e.width))
        root.bind('<Escape>', lambda _: self.stop())
        root.bind('<Control-space>', lambda _: self.play())
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.refresh()
        self.set_playback_state('stopped')
        self.poll_id = root.after(33, self.poll)

    def wrap(self, width):
        compact = width < 700
        self.outer.configure(padding=(16, 8) if compact else (20, 12))
        self.decision_surface.configure(padding=10 if compact else 14)
        self.canvas.configure(height=64 if compact else 100)
        self.lyrics.grid_configure(pady=(0, 2) if compact else (4, 6))
        self.lyrics.configure(wraplength=max(400, width - 8))
        for label in [self.status_label, self.task_label, self.group_label]:
            label.configure(wraplength=max(380, width - 52))

    def layout_chips(self):
        width = max(400, self.chip_frame.winfo_width())
        if getattr(self, '_chip_width', None) == width: return
        self._chip_width = width
        row, used, row_height = 0, 0, 0
        for button in self.chip_buttons:
            size = button.winfo_reqwidth() + 6
            if used and used + size > width: row += row_height + 6; used, row_height = 0, 0
            button.place(x=used, y=row)
            row_height = max(row_height, button.winfo_reqheight())
            used += size
        self.chip_frame.configure(height=row + row_height)

    def choose_unit(self, index):
        self.chosen_unit_index = index
        self.combo.current(index)
        self.refresh()
        self.status.set('Chosen “' + self.units[index][0].split('  ·')[0] + '”. Mark Entrance to start that lyric at this tap.')

    def release_at_playhead(self):
        if self.playback_ms is None:
            self.feedback('Play this moment, stop at the release, then use the playhead. You can also type the time.')
            return
        self.stop(); self.release.set(str(round(self.playback_ms)))
        self.feedback('Playback time copied. Set Release to confirm it.')

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
        chosen_word = self.units[self.chosen_unit_index][1].get('wordId') if self.units else None
        if not chosen_word and self.units:
            chosen_unit = self.units[self.chosen_unit_index][1].get('unitId')
            chosen_word = next((u.get('parentWordId') for u in self.snapshot['units'] if u['unitId'] == chosen_unit), None)
        syllables = self.words.get(chosen_word, {}).get('syllables', [])
        indexes = [i for i, (_, op) in enumerate(self.units) if op['type'] == 'assignWordEntrance'
                   or (len(syllables) > 1 and op.get('unitId') in {s['id'] for s in syllables})]
        signature = tuple((i, self.units[i][0]) for i in indexes)
        if getattr(self, '_chip_signature', None) != signature:
            for button in self.chip_buttons: button.destroy()
            self.chip_buttons = []
            self.chip_indexes = indexes
            for index in indexes:
                label = self.units[index][0]
                text = label.split('  ·')[0]
                button = self.ttk.Button(self.chip_frame, text=text, style='Chip.TButton',
                                         width=0, command=lambda value=index: self.choose_unit(value))
                self.chip_buttons.append(button)
            self._chip_signature = signature; self._chip_width = None
            self.layout_chips()
        for number, button in zip(self.chip_indexes, self.chip_buttons):
            button.configure(style='Chosen.Chip.TButton' if number == self.chosen_unit_index else 'Chip.TButton')
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
        flow = derive_review_flow(self.snapshot, self.selected)
        self.summary.set(f"{flow['reviewed']} of {flow['total']} taps reviewed   ·   guide timing")
        self.progress.configure(maximum=max(1, flow['total']), value=flow['reviewed'])
        if self.tree.exists(str(self.selected)):
            self.tree.selection_set(str(self.selected)); self.tree.see(str(self.selected))
        self.update_focus()
        self.draw()

    def update_focus(self):
        flow = derive_review_flow(self.snapshot, self.selected)
        current = next((t for t in self.snapshot['taps'] if t['ordinal'] == self.selected), None)
        if not current:
            self.focus_heading.set('NO TAPS IN THIS TAKE')
            self.task_text.set('Record a short guide take first')
            self.focus_group.set('Open Guide vocals, play the phrase, and tap at lyric or note changes.')
            self.chip_frame.grid_remove(); self.actions_frame.grid_remove(); self.release_frame.grid_remove()
            self.preview_button.pack_forget()
            return
        status = {'unreviewed': 'Needs Review', 'entrance': 'Lyric Entrance', 'note': 'Note Change', 'ignored': 'Ignored'}[current['assignmentStatus']]
        self.focus_heading.set(f"TAP {self.selected:02d} / {len(self.snapshot['taps']):02d}    {current['sourceTimeEstimateMs'] / 1000:.3f} s    ·    {status}")
        group = flow['activeGroup']
        label = self.labels.get(group['unitId'], '') if group else None
        self.group_label.grid()
        if group: self.status_label.grid_remove()
        else: self.status_label.grid()
        self.chip_frame.grid(); self.actions_frame.grid(); self.release_frame.grid_remove()
        self.preview_button.pack_forget()
        if flow['phase'] == 'release':
            self.step_text.set('✓ Group Taps     →     ● Mark Release     →     ○ Save Timing')
            self.task_text.set('When does the final lyric end?')
            self.focus_group.set('Play the held lyric, stop at its release, then use the playhead or type a time.')
            self.chip_frame.grid_remove(); self.actions_frame.grid_remove()
            self.release_frame.grid(row=5, sticky='ew', pady=(4, 0))
        elif flow['phase'] == 'ready':
            self.step_text.set('✓ Group Taps     →     ✓ Mark Release     →     ● Save Timing')
            self.task_text.set('Review your timing groups')
            self.focus_group.set(f"{len(self.snapshot['groups'])} lyric groups are closed. Review Timing checks a separate score copy before export.")
            self.chip_frame.grid_remove(); self.actions_frame.grid_remove()
            self.preview_button.pack(side='right', padx=8)
        else:
            self.step_text.set('● Group Taps     →     ○ Mark Release     →     ○ Save Timing')
            self.task_text.set('What changes at this tap?')
            self.focus_group.set(f'Holding “{label}” · {group["noteTapCount"]} note changes. Another Note keeps this lyric.' if group else 'Hear the moment. Choose the lyric below, then mark its entrance.')
            if not group: self.group_label.grid_remove()
        if flow['blocker']:
            self.status.set(flow['blocker']['title'] + '. ' + flow['blocker']['recovery'])
            self.group_label.grid_remove(); self.status_label.grid()

    def move(self, direction):
        taps = self.snapshot['taps']; index = next((i for i, t in enumerate(taps) if t['ordinal'] == self.selected), 0)
        if taps:
            self.selected = taps[max(0, min(len(taps) - 1, index + direction))]['ordinal']
            self.tree.selection_set(str(self.selected)); self.update_focus(); self.draw()

    def show_details(self):
        window = self.tk.Toplevel(self.root); window.title('LyricVibe · Tap details'); window.geometry('720x430')
        details = self.ttk.Treeview(window, columns=('time', 'meaning', 'lyric'), show='tree headings')
        for key, heading in [('#0', 'Tap'), ('time', 'Source ms'), ('meaning', 'Meaning'), ('lyric', 'Lyric')]:
            details.heading(key, text=heading); details.column(key, width=80 if key != 'lyric' else 230)
        for item in self.tree.get_children():
            details.insert('', 'end', iid=item, text=item, values=self.tree.item(item, 'values'))
        details.pack(fill='both', expand=True, padx=12, pady=12)
        def pick(_):
            chosen = details.selection()
            if chosen:
                self.selected = int(chosen[0]); self.tree.selection_set(chosen[0]); self.update_focus(); self.draw()
        details.bind('<<TreeviewSelect>>', pick)

    def selection(self, _=None):
        selected = self.tree.selection()
        if selected: self.selected = int(selected[0]); self.update_focus(); self.draw()

    def pick(self, event):
        taps = self.snapshot['taps']
        if taps:
            value = self.doc.session['clipStartMs'] - self.doc.session['guideDelayMs'] + event.x / max(1, self.canvas.winfo_width()) * 12000
            self.selected = min(taps, key=lambda t: abs(t['sourceTimeEstimateMs'] - value))['ordinal']
            self.tree.selection_set(str(self.selected)); self.tree.see(str(self.selected))

    def draw(self):
        if not hasattr(self, 'canvas'): return
        canvas = self.canvas
        width, height = max(1, canvas.winfo_width()), 90
        start = self.doc.session['clipStartMs'] - self.doc.session['guideDelayMs']
        def x(ms): return (ms - start) / 12000 * width
        if getattr(self, '_spectrum_width', None) != width:
            canvas.delete('all'); self._spectrum_width = width
            for frame in self.doc.frames[::2]:
                left = x(start + frame['timeMs'])
                for band, value in enumerate(frame['spectrum']):
                    strength = max(0, min(1, float(value)))
                    color = '#%02x%02x%02x' % (int(14 + 35 * strength), int(24 + 150 * strength), int(30 + 165 * strength))
                    y = 67 - band * 2
                    canvas.create_rectangle(left, y, left + max(2, width / 400), y + 2, fill=color, outline='')
        canvas.delete('markers')
        colors = {'unreviewed': '#9aa6b3', 'entrance': '#75dbb5', 'note': '#c5a5f4', 'ignored': '#4d5661'}
        for tap in self.snapshot['taps']:
            left = x(tap['sourceTimeEstimateMs'])
            canvas.create_line(left, 5, left, 69, fill=colors[tap['assignmentStatus']], width=3 if tap['ordinal'] == self.selected else 1, tags='markers')
            canvas.create_text(left, 77 if tap['ordinal'] % 2 else 87, text=str(tap['ordinal']), fill=colors[tap['assignmentStatus']], font=('Segoe UI', 8), tags='markers')

    def apply(self, operation):
        try:
            self.doc.act(dict(operation, tapOrdinal=self.selected), self.doc.state['reviewRevision'])
            if operation['type'] in ('assignWordEntrance', 'assignEntrance', 'assignNote', 'ignore'):
                unresolved = [t for t in preview(self.doc.state)['taps'] if t['assignmentStatus'] == 'unreviewed' or t['blockers']]
                next_tap = next((t for t in unresolved if t['ordinal'] > self.selected), unresolved[0] if unresolved else None)
                if next_tap: self.selected = next_tap['ordinal']
            if operation['type'] == 'assignWordEntrance':
                word_ids = list(self.words)
                word_index = word_ids.index(operation['wordId'])
                if word_index + 1 < len(word_ids):
                    next_word = self.words[word_ids[word_index + 1]]
                    self.unit_choice.set(next_word['text'] + '  · whole word')
                    self.chosen_unit_index = next(i for i, (_, target) in enumerate(self.units) if target.get('wordId') == next_word['id'])
            flow = derive_review_flow(preview(self.doc.state), self.selected)
            if flow['phase'] == 'release': self.selected = flow['releaseTapOrdinal']
            self.dirty = True; self.refresh()
            self.status.set('Decision saved in this draft. The original score is unchanged.')
        except (GuideGroupingError, ValueError) as error: self.error(error)

    def entrance(self):
        index = self.chosen_unit_index
        if index >= 0: self.apply(self.units[index][1])

    def set_release(self):
        try: self.apply({'type': 'setRelease', 'endMs': int(self.release.get())})
        except ValueError: self.feedback('Enter an integer source time in milliseconds.')

    def undo(self):
        try:
            self.doc.act({'type': 'undo'}, self.doc.state['reviewRevision'])
            self.dirty = True; self.refresh(); self.status.set('Restored the previous decision.')
        except GuideGroupingError as error: self.error(error)

    def error(self, error):
        self.feedback(f"{getattr(error, 'code', 'REVIEW_FAILED')}: {error}")

    def feedback(self, message):
        self.status.set(message)
        self.group_label.grid_remove(); self.status_label.grid()

    def save_draft(self):
        from tkinter import filedialog
        path = filedialog.asksaveasfilename(parent=self.root, title='Save review draft as a new file',
                                          defaultextension='.json', initialfile='guide-stone-review.json')
        if path:
            try: write_new(path, self.doc.draft()); self.dirty = False; self.feedback('Review draft saved. It contains numeric decisions, no audio.')
            except (OSError, ValueError) as error: self.error(error)

    def load_draft(self):
        from tkinter import filedialog, messagebox
        if self.dirty and not messagebox.askyesno('Unsaved review', 'Replace the current unsaved review?', parent=self.root): return
        path = filedialog.askopenfilename(parent=self.root, title='Open matching review draft', filetypes=[('JSON', '*.json')])
        if path:
            try:
                if Path(path).stat().st_size > 5 * 1024 * 1024: raise ValueError('Draft exceeds 5 MiB.')
                self.doc.replay(json.loads(Path(path).read_text(encoding='utf-8')))
                self.dirty = False; self.refresh(); self.feedback('Restored decisions for this exact take.')
            except (OSError, ValueError, KeyError, TypeError) as error: self.error(error)

    def show_preview(self):
        from tkinter import filedialog
        try:
            result = self.doc.score_preview()
        except (OSError, ValueError, subprocess.SubprocessError) as error: self.error(error)
        else:
            reviewed_revision = self.doc.state['reviewRevision']
            window = self.tk.Toplevel(self.root)
            window.title('LyricVibe · Review timing changes'); window.geometry('680x480'); window.minsize(560, 380)
            pane = self.ttk.Frame(window, padding=20); pane.pack(fill='both', expand=True)
            pane.columnconfigure(0, weight=1); pane.rowconfigure(2, weight=1)
            self.ttk.Label(pane, text='Review timing changes', font=('Segoe UI', 18, 'bold')).grid(row=0, sticky='w')
            self.ttk.Label(pane, text='Guide timing is uncalibrated. Save creates a separate score copy.',
                           style='Muted.TLabel', wraplength=600).grid(row=1, sticky='w', pady=(6, 14))
            table = self.ttk.Treeview(pane, columns=('lyric', 'original', 'draft', 'notes'), show='headings')
            for key, heading, width in [('lyric', 'Lyric', 150), ('original', 'Original · seconds', 160),
                                         ('draft', 'Your guide · seconds', 160), ('notes', 'Notes', 55)]:
                table.heading(key, text=heading); table.column(key, width=width, minwidth=50)
            table.grid(row=2, sticky='nsew')
            scroll = self.ttk.Scrollbar(pane, orient='vertical', command=table.yview)
            scroll.grid(row=2, column=1, sticky='ns'); table.configure(yscrollcommand=scroll.set)
            for group in self.snapshot['groups']:
                word = self.words[group['parentWordId']]
                original = next((s for s in word.get('syllables', []) if s['id'] == group['unitId']), word)
                table.insert('', 'end', values=(self.labels.get(group['unitId'], word['text']),
                    f"{original['startMs']/1000:.3f}–{original['endMs']/1000:.3f}",
                    f"{group['startMs']/1000:.3f}–{group['endMs']/1000:.3f}", len(group['noteTapOrdinals'])))
            actions = self.ttk.Frame(pane); actions.grid(row=3, sticky='ew', pady=(14, 0))
            self.ttk.Button(actions, text='←  Back to Review', command=window.destroy).pack(side='left')
            def export():
                path = filedialog.asksaveasfilename(parent=window, title='Save a separate score copy', defaultextension='.json', initialfile='guide-score-copy.json')
                if path:
                    try:
                        if self.doc.state['reviewRevision'] != reviewed_revision:
                            raise GuideGroupingError('REVISION_CONFLICT', 'Review changed. Close this preview and review the current timings before saving.')
                        confirmed = self.doc.score_preview(True)
                        write_new(path, confirmed['previewScore'])
                        self.feedback('Separate score copy saved. Original unchanged; automatic admission remains off.')
                        window.destroy()
                    except (OSError, ValueError, subprocess.SubprocessError) as error: self.error(error)
            self.ttk.Button(actions, text='↓  Save Score Copy…', style='Primary.TButton', command=export).pack(side='right')

    def play(self, whole_take=False):
        if self.play_thread and self.play_thread.is_alive(): self.status.set('Stop the current audition before starting another.'); return
        if not self.media:
            self.status.set('Open this take with the original recording to audition it.'); return
        self.play_stop.clear()
        self.play_epoch += 1
        epoch = self.play_epoch
        tap = next((t for t in self.snapshot['taps'] if t['ordinal'] == self.selected), None)
        if not tap and not whole_take: return
        start = max(0, self.doc.session['clipStartMs'] - self.doc.session['guideDelayMs']) if whole_take else max(0, tap['sourceTimeEstimateMs'] - 600)
        duration = 12 if whole_take else 3
        self.audition_start_ms = start
        clicks_enabled = self.clicks.get()
        tap_times = [t['sourceTimeEstimateMs'] for t in self.snapshot['taps']]
        self.set_playback_state('preparing')
        def worker():
            failed = False
            try:
                from .review_source import load_bound_package
                import sounddevice as sd
                if self.play_stop.is_set(): return
                verified = load_bound_package(self.doc.package_path, self.media)
                if verified != self.doc.package: raise ValueError('Original package changed.')
                pcm = decode_audition(self.media, start, self.play_stop, duration)
                if self.play_stop.is_set(): return
                if clicks_enabled: pcm = add_tap_clicks(pcm, start, tap_times)
                position = 0
                finished = threading.Event()
                def output(buffer, frames, _time, _status):
                    nonlocal position
                    buffer[:] = bytes(len(buffer))
                    if self.play_stop.is_set(): raise sd.CallbackAbort
                    self.messages.put(('clock', epoch, start + position / 32,
                                       time.monotonic() + max(0, _time.outputBufferDacTime - _time.currentTime)))
                    chunk = pcm[position:position + frames * 2]
                    buffer[:len(chunk)] = chunk
                    position += len(chunk)
                    if position >= len(pcm): raise sd.CallbackStop
                with sd.RawOutputStream(samplerate=16000, channels=1, dtype='int16', blocksize=320,
                                        callback=output, finished_callback=finished.set) as stream:
                    until = time.monotonic() + duration + 2
                    while not finished.wait(.05) and time.monotonic() < until:
                        if self.play_stop.is_set(): stream.abort(); break
            except Exception:
                failed = True
                self.messages.put(('failed', epoch, 'Playback failed. Check the original recording, FFmpeg and output device, then try Hear This Tap again.'))
            finally:
                if not failed: self.messages.put(('stopped', epoch))
        self.play_thread = threading.Thread(target=worker, daemon=False)
        self.play_thread.start()

    def stop(self):
        self.play_stop.set(); self.playback_clock = None
        self.set_playback_state('stopped')

    def set_playback_state(self, state):
        self.playback_state = state
        labels = {'preparing': '◌  Preparing…', 'playing': '▶  Playing', 'stopped': '■  Stopped', 'failed': '×  Playback Failed'}
        self.playback_text.set(labels[state])
        self.play_button.configure(text='◌  Preparing…' if state == 'preparing' else '▶  Hear This Tap')
        self.play_button.state(['disabled'] if state in ('preparing', 'playing') or not self.media else ['!disabled'])
        self.take_button.state(['disabled'] if state in ('preparing', 'playing') or not self.media else ['!disabled'])
        self.stop_button.state(['!disabled'] if state in ('preparing', 'playing') else ['disabled'])

    def _handle_playback_message(self, message):
        if not isinstance(message, tuple) or len(message) < 2 or message[1] != self.play_epoch: return
        kind = message[0]
        if kind == 'clock' and not self.play_stop.is_set():
            self.playback_clock = message[2:]
            if self.playback_state != 'playing': self.set_playback_state('playing')
        elif kind == 'stopped':
            self.playback_clock = None; self.set_playback_state('stopped')
        elif kind == 'failed':
            self.playback_clock = None; self.set_playback_state('failed'); self.status.set(message[2])
            if hasattr(self, 'group_label'):
                self.group_label.grid_remove(); self.status_label.grid()

    def poll(self):
        while not self.messages.empty():
            message = self.messages.get_nowait()
            self._handle_playback_message(message)
        if self.playback_clock:
            source_ms, due = self.playback_clock
            self.playback_ms = max(self.audition_start_ms, source_ms + (time.monotonic() - due) * 1000)
            self.canvas.delete('playhead')
            start = self.doc.session['clipStartMs'] - self.doc.session['guideDelayMs']
            x = (self.playback_ms - start) / 12000 * self.canvas.winfo_width()
            self.canvas.create_line(x, 0, x, 110, fill='#ffffff', width=2, tags='playhead')
            self.playback_text.set(f"▶  {self.playback_ms / 1000:.3f} s")
        if not self.closed: self.poll_id = self.root.after(33, self.poll)

    def close(self):
        from tkinter import messagebox
        if self.dirty and not messagebox.askyesno('Unsaved review', 'Close without saving these review decisions?', parent=self.root): return
        self.stop()
        def finish():
            if self.play_thread and self.play_thread.is_alive():
                self.status.set('Stopping audition and closing its decoder…')
                self.root.after(100, finish)
            else:
                self.closed = True
                self.root.after_cancel(self.poll_id)
                self.root.destroy()
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
                for widget in [app.entrance_button, app.play_button, app.status_label]:
                    assert widget.winfo_viewable() and widget.winfo_rootx() + widget.winfo_width() <= root.winfo_rootx() + root.winfo_width()
                    assert widget.winfo_rooty() + widget.winfo_height() <= root.winfo_rooty() + root.winfo_height()
                assert app.entrance_button.winfo_rooty() + app.entrance_button.winfo_height() <= app.decision_surface.winfo_rooty() + app.decision_surface.winfo_height()
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
            app.closed = True; root.after_cancel(app.poll_id); root.destroy(); print(json.dumps({'ok': True, 'pid': os.getpid(), 'geometry': ['920x760', '600x650'], 'audioOpened': False})); return 0
        if args.foreground:
            root.lift(); root.attributes('-topmost', True); root.focus_force()
            root.after(300, lambda: root.attributes('-topmost', False))
        root.mainloop(); return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'ok': False, 'code': getattr(error, 'code', 'REVIEW_FAILED')})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
