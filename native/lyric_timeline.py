"""Local lyric time-block editor; source audio stays local and inputs stay immutable."""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import time

from .timeline_document import TimelineDocument
from .timeline_audio import TimelineAudio


class LyricTimeline:
    LEFT = 116

    def __init__(self, root, document, media=None):
        import tkinter as tk
        from tkinter import ttk
        self.tk, self.ttk, self.root, self.doc = tk, ttk, root, document
        self.package = document.package
        self.audio = TimelineAudio(document.package_path, Path(media), expected_package=self.package) if media else None
        self.score = document.score
        available = [p for p in self.score['phrases'] if p['words']]
        self.phrase_id = next((p['id'] for p in available if p['id'] == 'phrase-2'), available[0]['id'] if available else None)
        self.selected = None
        self.drag = None
        self.hitboxes = []
        self.dirty, self.closed = False, False
        self.position_ms = 0
        self.play_state = 'stopped'
        self.follow_audio = False
        self.play_request = 0
        self.rows = []
        self.compact = None
        self.text_fonts = {}
        root.title('LyricVibe · Lyric timeline')
        root.geometry('1120x820'); root.minsize(600, 600)
        root.configure(background='#11161c')
        style = ttk.Style(root); style.theme_use('clam')
        style.configure('.', background='#11161c', foreground='#e7eef5', font=('Segoe UI', 10))
        style.configure('TButton', padding=(12, 8), background='#283542', foreground='#e7eef5', borderwidth=0,
                        focusthickness=2, focuscolor='#7ee3c1')
        style.map('TButton', background=[('active', '#3b5060')], foreground=[('disabled', '#6c7c8d')])
        style.configure('Primary.TButton', background='#8ce5c9', foreground='#102c24', font=('Segoe UI', 10, 'bold'))
        style.map('Primary.TButton', background=[('active', '#b8f6e2')], foreground=[('active', '#102c24')])
        style.configure('Quiet.TButton', padding=(8, 5), background='#11161c')
        style.configure('Muted.TLabel', foreground='#a2b3c4')
        style.configure('TEntry', fieldbackground='#1e2a35', foreground='#e7eef5', insertcolor='#e7eef5', padding=6)
        style.configure('TCombobox', fieldbackground='#1e2a35', background='#283542', padding=5)
        style.map('TCombobox', fieldbackground=[('readonly', '#1e2a35')], foreground=[('readonly', '#e7eef5')])
        outer = ttk.Frame(root, padding=(20, 16)); outer.grid(sticky='nsew')
        root.columnconfigure(0, weight=1); root.rowconfigure(0, weight=1)
        outer.columnconfigure(0, weight=1); outer.rowconfigure(5, weight=1)
        self.outer = outer
        brand = ttk.Frame(outer); brand.grid(row=0, sticky='ew')
        ttk.Label(brand, text='LYRICVIBE  /  LYRIC TIMELINE', style='Muted.TLabel', font=('Segoe UI', 9, 'bold')).pack(side='left')
        ttk.Button(brand, text='Open Score…', style='Quiet.TButton', command=self.open_score).pack(side='right')
        self.save_button = ttk.Button(brand, text='Save Copy…', command=self.save_score)
        self.save_button.pack(side='right', padx=6)
        self.title = ttk.Label(outer, text=self.score['source'].get('title', 'Lyric timeline'), font=('Segoe UI', 21, 'bold'))
        self.title.grid(row=1, sticky='ew', pady=(4, 4))
        self.subtitle = ttk.Label(outer, text='Play the phrase. Drag a block to move it; drag its edges to change its duration.', style='Muted.TLabel', wraplength=1000)
        self.subtitle.grid(row=2, sticky='ew', pady=(0, 10))
        transport = ttk.Frame(outer); transport.grid(row=3, sticky='ew', pady=(0, 10))
        self.transport = transport
        self.play_button = ttk.Button(transport, text='▶  Play Preview', style='Primary.TButton', command=self.toggle_play)
        self.play_button.pack(side='left')
        self.stop_button = ttk.Button(transport, text='■  Stop', command=self.stop)
        self.stop_button.pack(side='left', padx=6)
        self.clock = tk.StringVar(value='00:00.000  ·  Stopped')
        self.clock_label = ttk.Label(transport, textvariable=self.clock, font=('Consolas', 11))
        self.clock_label.pack(side='left', padx=8)
        self.undo_button = ttk.Button(transport, text='↶  Undo', command=self.undo)
        self.undo_button.pack(side='right')
        tools = ttk.Frame(outer); tools.grid(row=4, sticky='ew', pady=(0, 8))
        self.phrase_ids = [p['id'] for p in available]
        self.phrase_box = ttk.Combobox(tools, state='readonly', width=34,
            values=[f"{i+1:02d}  {' '.join(w['text'] for w in p['words'])[:58]}" for i, p in enumerate(available)])
        if self.phrase_ids: self.phrase_box.current(self.phrase_ids.index(self.phrase_id))
        self.phrase_box.pack(side='left', fill='x', expand=True)
        self.phrase_box.bind('<<ComboboxSelected>>', self.change_phrase)
        ttk.Button(tools, text='−', width=3, command=lambda: self.zoom(1.4)).pack(side='left', padx=(8, 3))
        ttk.Button(tools, text='+', width=3, command=lambda: self.zoom(1/1.4)).pack(side='left')
        ttk.Button(tools, text='Fit Phrase', command=self.fit).pack(side='left', padx=(6, 0))
        chart = ttk.Frame(outer); chart.grid(row=5, sticky='nsew')
        chart.columnconfigure(0, weight=1); chart.rowconfigure(1, weight=1)
        self.ruler = tk.Canvas(chart, height=94, background='#0c1218', highlightthickness=0)
        self.ruler.grid(row=0, column=0, sticky='ew')
        self.roll = tk.Canvas(chart, background='#111a23', highlightthickness=0, yscrollincrement=34)
        self.roll.grid(row=1, column=0, sticky='nsew')
        scroll = ttk.Scrollbar(chart, orient='vertical', command=self.roll.yview)
        scroll.grid(row=1, column=1, sticky='ns'); self.roll.configure(yscrollcommand=scroll.set)
        self.roll.bind('<Button-1>', self.press)
        self.roll.bind('<B1-Motion>', self.motion)
        self.roll.bind('<ButtonRelease-1>', self.release_drag)
        self.roll.bind('<Motion>', self.hover)
        self.roll.bind('<MouseWheel>', self.wheel)
        self.ruler.bind('<Button-1>', self.seek_click)
        self.ruler.bind('<MouseWheel>', self.wheel)
        self.roll.bind('<Configure>', lambda _: self.draw())
        self.ruler.bind('<Configure>', lambda _: self.draw())
        self.preview = tk.Canvas(outer, height=62, background='#11161c', highlightthickness=0)
        self.preview.grid(row=6, sticky='ew', pady=(8, 0))
        self.preview.bind('<Configure>', lambda _: self.draw_preview())
        selection = ttk.Frame(outer); selection.grid(row=7, sticky='ew', pady=(4, 6))
        self.selection_text = tk.StringVar(value='Choose a lyric block')
        ttk.Label(selection, textvariable=self.selection_text, font=('Segoe UI', 11, 'bold')).pack(side='left')
        self.lock_button = ttk.Button(selection, text='Lock', style='Quiet.TButton', command=self.toggle_lock)
        self.lock_button.pack(side='right')
        self.split_button = ttk.Button(selection, text='Split Syllables…', style='Quiet.TButton', command=self.split_syllables)
        self.split_button.pack(side='right', padx=8)
        precision = ttk.Frame(outer); precision.grid(row=8, sticky='ew')
        self.start_value, self.end_value = tk.StringVar(), tk.StringVar()
        ttk.Label(precision, text='Start ms', style='Muted.TLabel').pack(side='left')
        self.start_entry = ttk.Entry(precision, textvariable=self.start_value, width=9)
        self.start_entry.pack(side='left', padx=(6, 14))
        ttk.Label(precision, text='End ms', style='Muted.TLabel').pack(side='left')
        self.end_entry = ttk.Entry(precision, textvariable=self.end_value, width=9)
        self.end_entry.pack(side='left', padx=6)
        self.apply_button = ttk.Button(precision, text='Apply Timing', command=self.apply_fields)
        self.apply_button.pack(side='left', padx=8)
        self.audition_button = ttk.Button(precision, text='▶  Hear Word', command=self.hear_word)
        self.audition_button.pack(side='right')
        for entry in [self.start_entry, self.end_entry]:
            entry.bind('<Return>', lambda _: self.apply_fields())
            entry.bind('<MouseWheel>', self.wheel_timing)
        self.status = tk.StringVar(value='Gray blocks are existing timing estimates. Select any word to begin; Space plays, Escape stops.')
        self.status_label = ttk.Label(outer, textvariable=self.status, style='Muted.TLabel', wraplength=1000)
        self.status_label.grid(row=9, sticky='ew', pady=(10, 0))
        outer.bind('<Configure>', self.resize)
        root.bind('<space>', self.space)
        root.bind('<Escape>', lambda _: self.stop())
        root.bind('<Control-z>', lambda _: self.undo())
        root.bind('<Left>', lambda e: self.nudge_playhead(e, -50))
        root.bind('<Right>', lambda e: self.nudge_playhead(e, 50))
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.fit()
        if self.phrase()['words']: self.select(('word', self.phrase()['words'][0]['id']))
        else: self.status.set('No lyric blocks in this score. Open a matching score that contains lyrics.')
        self.poll_id = root.after(33, self.poll)

    def phrase(self):
        return next((p for p in self.score['phrases'] if p['id'] == self.phrase_id), {'id': None, 'startMs': 0, 'endMs': 1000, 'words': []})

    def resize(self, event):
        width = event.width
        compact = width < 750
        self.title.configure(wraplength=max(440, width-40), font=('Segoe UI', 17 if compact else 21, 'bold'))
        self.subtitle.configure(wraplength=max(420, width-50))
        self.status_label.configure(wraplength=max(420, width-50))
        if compact != self.compact:
            self.compact = compact
            self.outer.configure(padding=(12, 10) if compact else (20, 16))
            self.subtitle.configure(text='Drag a word to move it. Drag an edge to stretch it.' if compact else
                'Play the phrase. Drag a block to move it; drag its edges to change its duration.')
            self.subtitle.grid_configure(pady=(0, 6 if compact else 10))
            self.transport.grid_configure(pady=(0, 6 if compact else 10))
            self.clock_label.configure(font=('Consolas', 9 if compact else 11))
            self.ruler.configure(height=66 if compact else 94)
            self.preview.configure(height=54 if compact else 62)
            self.status_label.grid_configure(pady=(6 if compact else 10, 0))

    def elide(self, text, pixels, bold=False):
        """Canvas text is always one line; the pinned label retains the full word."""
        from tkinter import font
        key = ('Segoe UI', 10, 'bold' if bold else 'normal')
        if key not in self.text_fonts: self.text_fonts[key] = font.Font(family=key[0], size=key[1], weight=key[2])
        measure = self.text_fonts[key].measure
        if measure(text) <= pixels: return text
        if measure('…') > pixels: return ''
        while text and measure(text+'…') > pixels: text = text[:-1]
        return text+'…'

    def fit(self):
        phrase = self.phrase(); offset = self.score.get('offsetMs', 0)
        self.view_start = max(0, phrase['startMs'] + offset - 650)
        self.view_end = phrase['endMs'] + offset + 650
        self.position_ms = self.view_start
        self.draw()

    def zoom(self, factor):
        center = (self.view_start + self.view_end) / 2
        span = max(1000, min(60000, (self.view_end-self.view_start)*factor))
        self.view_start = max(0, center-span/2); self.view_end = self.view_start+span
        self.draw()

    def x(self, media_ms):
        width = max(1, self.roll.winfo_width()-self.LEFT-12)
        return self.LEFT + (media_ms-self.view_start)/(self.view_end-self.view_start)*width

    def ms(self, x):
        width = max(1, self.roll.winfo_width()-self.LEFT-12)
        return self.view_start+(x-self.LEFT)/width*(self.view_end-self.view_start)

    def target(self):
        if not self.selected: return None, None
        kind, identity = self.selected
        for word in self.phrase()['words']:
            if kind == 'word' and word['id'] == identity: return word, word
            for child in word.get('syllables', []):
                if kind == 'syllable' and child['id'] == identity: return child, word
        return None, None

    def select(self, selected):
        self.selected = selected
        item, word = self.target()
        if item:
            self.selection_text.set(('Syllable “' if selected[0] == 'syllable' else 'Word “')+item['text']+'”')
            self.start_value.set(str(round(item['startMs']))); self.end_value.set(str(round(item['endMs'])))
            self.lock_button.configure(text='Allow Auto Timing' if item['locked'] else 'Protect Timing')
            self.apply_button.state(['!disabled'])
            self.split_button.state(['disabled'] if selected[0] != 'word' or word['locked'] or any(s['locked'] for s in word.get('syllables', [])) else ['!disabled'])
        self.draw()

    def refresh(self):
        self.score = self.doc.score
        available = [p for p in self.score['phrases'] if p['words']]
        self.phrase_ids = [p['id'] for p in available]
        self.phrase_box['values'] = [f"{i+1:02d}  {' '.join(w['text'] for w in p['words'])[:58]}" for i, p in enumerate(available)]
        if self.phrase_id not in self.phrase_ids: self.phrase_id = self.phrase_ids[0] if self.phrase_ids else None
        if self.phrase_ids: self.phrase_box.current(self.phrase_ids.index(self.phrase_id))
        else: self.phrase_box.set('No lyric blocks')
        if self.target()[0] is None: self.selected = ('word', self.phrase()['words'][0]['id']) if self.phrase()['words'] else None
        self.select(self.selected)

    def draw(self):
        if not hasattr(self, 'roll'): return
        roll, ruler = self.roll, self.ruler
        roll.delete('all'); ruler.delete('all'); self.hitboxes = []
        width = max(1, roll.winfo_width()); offset = self.score.get('offsetMs', 0)
        words = self.phrase()['words']
        height = sum(64 if w.get('syllables') else 36 for w in words)
        roll.configure(scrollregion=(0, 0, width, max(1, height)))
        span = self.view_end-self.view_start
        # Major labels need at least 58 px, even when the window is narrow.
        target_step = span * 58 / max(1, width-self.LEFT-12)
        step = next((s for s in [100, 250, 500, 1000, 2000, 5000, 10000, 30000] if s >= target_step), 60000)
        first = math.ceil(self.view_start / step)*step
        ruler_height = int(ruler.cget('height'))
        wave_center = (ruler_height+22)/2
        wave_amplitude = (ruler_height-30)/2
        for tick in range(int(first), int(self.view_end)+1, step):
            x = self.x(tick)
            ruler.create_line(x, 22, x, ruler_height, fill='#2d3a47')
            if x < width-40:
                ruler.create_text(x+4, 10, text=f'{tick/1000:g}', fill='#a7bacb', font=('Consolas', 9), anchor='w')
        ruler.create_text(12, 10, text='TIME · SECONDS', fill='#91a6b9', font=('Segoe UI', 8, 'bold'), anchor='w')
        ruler.create_text(12, wave_center, text='ORIGINAL\nRECORDING', fill='#91a6b9', font=('Segoe UI', 8), anchor='w')
        wave = self.package.get('waveform', {})
        peaks, bucket = wave.get('peaks', []), wave.get('bucketMs', 100)
        stride = max(1, math.floor(span/max(1, width-self.LEFT)/bucket))
        for index in range(max(0, int(self.view_start/bucket)), min(len(peaks), int(self.view_end/bucket)+1), stride):
            x = self.x(index*bucket); value = min(1, max(0, peaks[index]))
            ruler.create_line(x, wave_center-value*wave_amplitude, x, wave_center+value*wave_amplitude, fill='#476b7c')
        y = 0
        for number, word in enumerate(words):
            row_height = 64 if word.get('syllables') else 36
            bg = '#15202a' if number%2 else '#111a23'
            roll.create_rectangle(0, y, width, y+row_height, fill=bg, outline='')
            for tick in range(int(first), int(self.view_end)+1, step):
                roll.create_line(self.x(tick), y, self.x(tick), y+row_height, fill='#263440')
            roll.create_rectangle(0, y, self.LEFT, y+row_height, fill='#19232d', outline='')
            roll.create_text(14, y+17, text=self.elide(word['text'], self.LEFT-24), fill='#dce8f2', anchor='w', font=('Segoe UI', 10))
            self.hitboxes.append((0, y, self.LEFT, y+row_height, ('word', word['id']), 'label'))
            self.block(word, ('word', word['id']), y+5, 27, offset)
            for syllable in word.get('syllables', []): self.block(syllable, ('syllable', syllable['id']), y+35, 23, offset)
            roll.create_line(0, y+row_height, width, y+row_height, fill='#263440')
            y += row_height
        roll.create_line(self.LEFT, 0, self.LEFT, height, fill='#40505e')
        self.draw_playhead(); self.draw_preview()

    def block(self, item, target, top, height, offset):
        start, end = item['startMs'], item['endMs']
        if self.drag and self.drag['target'] == target: start, end = self.drag['preview']
        left, right = self.x(start+offset), self.x(end+offset)
        if right < self.LEFT or left > self.roll.winfo_width(): return
        a, b = max(self.LEFT+1, left), min(self.roll.winfo_width()-2, max(left+3, right))
        selected = self.selected == target
        fill = '#78909f' if item['provenance'] == 'estimated' else '#6fa9d1' if item['provenance'] == 'aligned' else '#68c7a7'
        self.roll.create_rectangle(a, top, b, top+height, fill=fill, outline='#d8fff3' if selected else '#263c4a', width=2 if selected else 1)
        if b-a > 24:
            self.roll.create_text(a+7, top+height/2, text=self.elide(item['text'], b-a-14, True), fill='#0b2026', anchor='w', font=('Segoe UI', 10, 'bold'))
        if selected:
            for edge in [a+3, b-3]: self.roll.create_line(edge, top+6, edge, top+height-6, fill='#e5fff6', width=2)
        self.hitboxes.append((a, top, b, top+height, target, 'block'))

    def draw_playhead(self):
        for canvas in [self.roll, self.ruler]:
            canvas.delete('playhead')
            x = self.x(self.position_ms)
            if x >= self.LEFT:
                end = float(self.roll.cget('scrollregion').split()[-1]) if canvas is self.roll else int(self.ruler.cget('height'))
                canvas.create_line(x, 0, x, end, fill='#f6db89', width=2, tags='playhead')
                if canvas is self.ruler:
                    canvas.create_polygon(x-5, 22, x+5, 22, x, 28, fill='#f6db89', outline='', tags='playhead')

    def draw_preview(self):
        if not hasattr(self, 'preview'): return
        from tkinter import font
        canvas = self.preview; canvas.delete('all')
        width = max(1, canvas.winfo_width())
        key = ('preview', 14 if width < 750 else 19)
        if key not in self.text_fonts: self.text_fonts[key] = font.Font(family='Segoe UI', size=key[1], weight='bold')
        f = self.text_fonts[key]
        tokens = self.phrase()['words']; lengths = [f.measure(w['text']+' ') for w in tokens]
        x, y = 6, 12
        active_time = self.position_ms-self.score.get('offsetMs', 0)
        for word, length in zip(tokens, lengths):
            if x+length > width-6 and x > 6: x, y = 6, y+28
            active = word['startMs'] <= active_time < word['endMs']
            canvas.create_text(x, y, text=word['text'], fill='#9cebd1' if active else '#718496', anchor='nw', font=f)
            x += length

    def hit(self, event):
        y = self.roll.canvasy(event.y)
        return next((h for h in reversed(self.hitboxes) if h[0] <= event.x <= h[2] and h[1] <= y <= h[3]), None)

    def press(self, event):
        self.roll.focus_set()
        hit = self.hit(event)
        if not hit:
            self.stop(); self.position_ms = max(0, self.ms(event.x)); self.draw_playhead(); self.draw_preview(); return
        self.select(hit[4]); item, word = self.target()
        if hit[5] == 'label': return
        self.stop()
        mode = 'start' if abs(event.x-hit[0]) <= 7 else 'end' if abs(event.x-hit[2]) <= 7 else 'move'
        self.drag = {'target': self.selected, 'mode': mode, 'x': event.x, 'old': (item['startMs'], item['endMs']),
                     'preview': (item['startMs'], item['endMs']), 'revision': self.doc.revision}

    def motion(self, event):
        if not self.drag: return
        delta = round(self.ms(event.x)-self.ms(self.drag['x']))
        start, end = self.drag['old']; item, word = self.target()
        low, high = (word['startMs'], word['endMs']) if self.selected[0] == 'syllable' else (self.phrase()['startMs'], self.phrase()['endMs'])
        mode = self.drag['mode']
        if mode == 'move':
            delta = max(low-start, min(high-end, delta)); start += delta; end += delta
        elif mode == 'start': start = max(low, min(end-10, start+delta))
        else: end = min(high, max(start+10, end+delta))
        self.drag['preview'] = (round(start), round(end))
        self.start_value.set(str(round(start))); self.end_value.set(str(round(end)))
        self.status.set(f'Moving “{item["text"]}” · {start/1000:.3f}–{end/1000:.3f} s · release to keep, Escape to cancel')
        self.draw()

    def release_drag(self, _=None):
        if not self.drag: return
        state = self.drag; self.drag = None
        if state['preview'] != state['old']: self.change_timing(*state['preview'], expected=state['revision'])
        else: self.draw()

    def hover(self, event):
        hit = self.hit(event)
        cursor = 'arrow'
        if hit and hit[5] == 'block': cursor = 'sb_h_double_arrow' if min(abs(event.x-hit[0]), abs(event.x-hit[2])) <= 7 else 'fleur'
        self.roll.configure(cursor=cursor)

    def wheel(self, event):
        if event.state & 4:
            self.zoom(1/1.2 if event.delta > 0 else 1.2)
        elif event.state & 1:
            delta = (self.view_end-self.view_start)*.1*(1 if event.delta < 0 else -1)
            span = self.view_end-self.view_start
            self.view_start = max(0, self.view_start+delta); self.view_end = self.view_start+span; self.draw()
        else: self.roll.yview_scroll(-1 if event.delta > 0 else 1, 'units')
        return 'break'

    def act(self, operation, expected=None):
        try:
            self.doc.act(operation, self.doc.revision if expected is None else expected)
            self.dirty = True; self.refresh()
            self.status.set('Timing updated and protected from automatic changes. Undo restores the previous timing.')
            return True
        except Exception as error:
            self.status.set(f'{getattr(error, "code", "EDIT_FAILED")}: {error}'); self.refresh(); return False

    def change_timing(self, start, end, expected=None):
        if not self.selected: return
        kind, identity = self.selected
        self.act({'type': 'setWordTiming' if kind == 'word' else 'setSyllableTiming',
                  'wordId' if kind == 'word' else 'syllableId': identity, 'startMs': int(start), 'endMs': int(end)}, expected)

    def apply_fields(self):
        try: self.change_timing(int(self.start_value.get()), int(self.end_value.get()))
        except ValueError: self.status.set('Type whole milliseconds for Start and End, then Apply Timing.')

    def wheel_timing(self, event):
        item, word = self.target()
        if not item: return 'break'
        value = self.start_value if event.widget is self.start_entry else self.end_value
        step = 1000 if event.state & 1 else 1 if event.state & (8 | 0x20000) else 100
        try:
            value.set(str(int(value.get()) + step * (1 if event.delta > 0 else -1)))
            self.status.set('Timing draft changed. Apply Timing keeps it; scroll 100 ms, Shift 1000 ms, Alt 1 ms.')
        except ValueError: self.status.set('Type whole milliseconds before scrolling this field.')
        return 'break'

    def toggle_lock(self):
        item, word = self.target()
        if not item: return
        kind, identity = self.selected
        if self.act({'type': 'setWordLock' if kind == 'word' else 'setSyllableLock',
                     'wordId' if kind == 'word' else 'syllableId': identity, 'locked': not item['locked']}):
            self.status.set('Automatic timing protection removed for this item. Manual editing is always available.' if item['locked'] else 'Timing protected from automatic changes. You can still drag or resize it.')

    def split_syllables(self):
        from tkinter import simpledialog
        word, _ = self.target()
        if not word or self.selected[0] != 'word': return
        target = word.get('spokenText') or word['text']
        split = simpledialog.askstring('Split lyric syllables', f'Insert | between the syllables of “{target}”.\nExample: crum|ble. Pitch changes stay inside one syllable.\nNew boundaries start as estimates for you to adjust.',
                                      initialvalue='|'.join(s['text'] for s in word.get('syllables', [])) or target, parent=self.root)
        if split is None: return
        parts = split.split('|')
        if ''.join(parts) != target or any(not part for part in parts):
            self.status.set('Keep the exact word spelling and insert | only between syllables.'); return
        span = word['endMs']-word['startMs']
        children = [{'id': f'{word["id"]}-syllable-{i+1}', 'text': text,
                     'startMs': round(word['startMs']+span*i/len(parts)),
                     'endMs': round(word['startMs']+span*(i+1)/len(parts)),
                     'provenance': 'estimated', 'locked': False, 'effects': []} for i, text in enumerate(parts)]
        if self.act({'type': 'setWordSyllables', 'wordId': word['id'], 'syllables': children}):
            self.status.set('Syllables added inside the word. Their initial equal spacing is estimated; drag their edges while listening.')

    def undo(self):
        self.drag = None
        try:
            self.doc.undo(self.doc.revision); self.dirty = True; self.refresh(); self.status.set('Previous edit restored.')
        except Exception as error: self.status.set(str(error))

    def change_phrase(self, _=None):
        self.stop(); self.drag = None
        if not self.phrase_ids: return
        self.phrase_id = self.phrase_ids[self.phrase_box.current()]
        self.selected = ('word', self.phrase()['words'][0]['id']); self.roll.yview_moveto(0); self.fit(); self.select(self.selected)

    def seek_click(self, event):
        if event.x < self.LEFT: return
        self.stop(); self.position_ms = max(0, self.ms(event.x)); self.draw_playhead(); self.draw_preview(); self.update_clock()

    def nudge_playhead(self, event, delta):
        if event.widget.winfo_class() in ('TEntry', 'Entry', 'TCombobox'): return
        self.stop(); self.position_ms = max(0, self.position_ms+delta*(5 if event.state & 1 else .2 if event.state & (8 | 0x20000) else 1))
        self.draw_playhead(); self.draw_preview(); self.update_clock(); return 'break'

    def space(self, event):
        if event.widget.winfo_class() in ('TEntry', 'Entry', 'TCombobox'): return
        self.toggle_play(); return 'break'

    def toggle_play(self):
        if not self.audio: self.status.set('Open with the original recording to play this timeline.'); return
        if self.audio.busy: self.stop(); return
        start = self.position_ms if self.view_start <= self.position_ms < self.view_end-100 else self.view_start
        self.request_playback(round(start), 12)

    def hear_word(self):
        item, _ = self.target()
        if self.audio and item:
            self.request_playback(max(0, round(item['startMs']+self.score.get('offsetMs', 0)-350)), 3)

    def request_playback(self, start, duration):
        self.stop()
        request = self.play_request
        def begin():
            if self.closed or request != self.play_request: return
            if self.audio.busy: self.root.after(25, begin); return
            if self.audio.play(start, duration_seconds=duration):
                self.follow_audio = True
                self.status.set('Preparing the original recording… Stop cancels playback.')
        begin()

    def stop(self):
        self.play_request += 1
        if self.audio:
            position = self.audio.poll().get('positionMs')
            if self.follow_audio and position is not None: self.position_ms = position
            self.audio.stop()
        self.follow_audio = False
        self.play_state = 'stopped'
        if self.drag:
            self.drag = None; self.select(self.selected); self.status.set('Move canceled. Timing unchanged.')

    def update_clock(self):
        value = max(0, round(self.position_ms))
        self.clock.set(f'{value//60000:02d}:{(value//1000)%60:02d}.{value%1000:03d}  ·  {self.play_state.title()}')

    def poll(self):
        if self.audio:
            previous_state = self.play_state
            state = self.audio.poll(); self.play_state = state['state']
            if self.follow_audio and state.get('positionMs') is not None: self.position_ms = state['positionMs']
            if state.get('error'): self.status.set(state['error'])
            elif self.play_state == 'playing' and previous_state != 'playing':
                self.status.set('Playing the original recording. Space pauses; Escape stops and retains your place.')
            if self.play_state == 'playing' and self.position_ms >= self.view_end: self.audio.stop()
        self.play_button.configure(text='◌  Preparing…' if self.play_state == 'preparing' else 'Ⅱ  Pause' if self.play_state == 'playing' else '▶  Play Preview')
        self.stop_button.state(['!disabled'] if self.play_state in ('playing', 'preparing') else ['disabled'])
        self.update_clock(); self.draw_playhead(); self.draw_preview()
        if not self.closed: self.poll_id = self.root.after(33, self.poll)

    def save_score(self):
        from tkinter import filedialog
        path = filedialog.asksaveasfilename(parent=self.root, title='Save a new lyric score copy', initialfile='lyric-timing-score.json', defaultextension='.json')
        if path:
            try: self.doc.export(path); self.dirty = False; self.status.set('Score copy saved. Reopen it here or import it into the matching YouTube extension.')
            except Exception as error: self.status.set(str(error))

    def open_score(self):
        from tkinter import filedialog, messagebox
        if self.dirty and not messagebox.askyesno('Unsaved timing', 'Replace the current unsaved changes with a score copy?', parent=self.root): return
        path = filedialog.askopenfilename(parent=self.root, title='Open a score for this exact song', filetypes=[('Lyric score JSON', '*.json')])
        if path:
            try:
                self.doc.import_score(path, self.doc.revision); self.dirty = False; self.refresh(); self.fit()
                self.status.set('Matching score opened. Protected timings were preserved.')
            except Exception as error: self.status.set(str(error))

    def close(self):
        from tkinter import messagebox
        if self.dirty and not messagebox.askyesno('Unsaved lyric timing', 'Close without saving your timing changes?', parent=self.root): return
        self.stop()
        def finish():
            if self.audio and not self.audio.close(): self.root.after(100, finish)
            else:
                self.closed = True; self.root.after_cancel(self.poll_id); self.root.destroy()
        finish()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--media', type=Path)
    parser.add_argument('--score', type=Path, help='Open a saved score copy for this exact package before showing the editor.')
    parser.add_argument('--foreground', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if not args.self_test:
        from .windows_runtime import install_headless_children
        install_headless_children()
    import tkinter as tk
    document = TimelineDocument(args.package)
    if args.score is not None:
        document.import_score(args.score, document.revision)
    root = tk.Tk(); app = LyricTimeline(root, document, args.media)
    if args.self_test:
        try:
            for width, height in [(1120, 820), (600, 650)]:
                root.geometry(f'{width}x{height}'); root.update()
                for widget in [app.roll, app.play_button, app.apply_button, app.status_label]:
                    assert widget.winfo_viewable()
                    assert widget.winfo_rootx()+widget.winfo_width() <= root.winfo_rootx()+root.winfo_width()
                    assert widget.winfo_rooty()+widget.winfo_height() <= root.winfo_rooty()+root.winfo_height()
            print(json.dumps({'ok': True, 'pid': os.getpid(), 'audioOpened': False, 'geometry': ['1120x820', '600x650']}))
        finally: app.closed = True; root.after_cancel(app.poll_id); root.destroy()
        return 0
    if args.foreground:
        root.lift(); root.attributes('-topmost', True); root.focus_force()
        root.after(300, lambda: root.attributes('-topmost', False))
    root.mainloop(); return 0


if __name__ == '__main__': raise SystemExit(main())
