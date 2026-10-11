"""Native interaction checks with isolated fixture lyrics and no audio device."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

from native.lyric_timeline import LyricTimeline
from native.timeline_document import ROOT, TimelineDocument


@unittest.skipUnless(shutil.which('node'), 'Shared score validation requires Node')
class LyricTimelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = "const c=require('./extension/score-core.js');process.stdout.write(JSON.stringify(c.createScore({videoId:'FIXTURE0001',title:'Fixture',artist:'Fixture',durationMs:10000},'[00:01.00]hello world\\n[00:05.00]',{provider:'fixture',contentHash:'a'.repeat(64)})));"
        cls.score = json.loads(subprocess.run(['node', '-e', script], cwd=ROOT,
            capture_output=True, text=True, check=True, timeout=10).stdout)

    def setUp(self):
        import tkinter as tk
        try: self.root = tk.Tk()
        except tk.TclError as error: self.skipTest(f'Tk display unavailable: {error}')
        self.addCleanup(self.root.destroy)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = Path(self.temp.name)/'package.json'
        path.write_text(json.dumps({'version':'lyricvibe.review.v1', 'score':self.score}), encoding='utf-8')
        self.doc = TimelineDocument(path)
        self.app = LyricTimeline(self.root, self.doc)
        self.root.update()
        self.addCleanup(self.end_poll)

    def end_poll(self):
        self.app.closed = True
        self.root.after_cancel(self.app.poll_id)

    def test_drag_cancel_then_move_protect_and_undo(self):
        app = self.app
        hit = next(h for h in app.hitboxes if h[4] == app.selected and h[5] == 'block')
        point = (hit[0]+hit[2])/2
        event = SimpleNamespace(x=point, y=(hit[1]+hit[3])/2)
        before = self.doc.score
        app.press(event)
        app.motion(SimpleNamespace(x=point+20, y=event.y))
        app.stop()
        self.assertEqual(self.doc.score, before)
        app.press(event)
        app.motion(SimpleNamespace(x=point+20, y=event.y))
        app.release_drag()
        self.assertGreater(app.target()[0]['startMs'], before['phrases'][0]['words'][0]['startMs'])
        self.assertTrue(app.target()[0]['locked'])
        app.undo()
        self.assertEqual(app.target()[0]['startMs'], before['phrases'][0]['words'][0]['startMs'])

    def test_millisecond_wheel_is_draft_and_text_focus_keeps_playhead(self):
        app = self.app
        original = self.doc.score
        initial = int(app.start_value.get())
        app.wheel_timing(SimpleNamespace(widget=app.start_entry, delta=120, state=0))
        self.assertEqual(int(app.start_value.get()), initial+100)
        app.wheel_timing(SimpleNamespace(widget=app.start_entry, delta=-120, state=1))
        self.assertEqual(int(app.start_value.get()), initial-900)
        app.wheel_timing(SimpleNamespace(widget=app.start_entry, delta=120, state=0x20000))
        self.assertEqual(int(app.start_value.get()), initial-899)
        self.assertEqual(self.doc.score, original)
        position = app.position_ms
        app.nudge_playhead(SimpleNamespace(widget=app.start_entry, state=0), 50)
        self.assertEqual(app.position_ms, position)
        app.nudge_playhead(SimpleNamespace(widget=app.roll, state=0x20000), 50)
        self.assertEqual(app.position_ms, position+10)

    def test_narrow_layout_ruler_labels_do_not_collide(self):
        app = self.app
        self.root.geometry('600x650'); self.root.update()
        boxes = []
        for item in app.ruler.find_all():
            if app.ruler.type(item) == 'text' and app.ruler.itemcget(item, 'text').replace('.', '').isdigit():
                boxes.append(app.ruler.bbox(item))
        boxes.sort()
        self.assertGreater(len(boxes), 1)
        for left, right in zip(boxes, boxes[1:]): self.assertLessEqual(left[2], right[0])
        for item in app.roll.find_all():
            if app.roll.type(item) == 'text': self.assertEqual(float(app.roll.itemcget(item, 'width')), 0)
        for widget in [app.roll, app.ruler, app.apply_button, app.audition_button]:
            parent = widget.nametowidget(widget.winfo_parent())
            self.assertGreaterEqual(widget.winfo_x(), 0)
            self.assertLessEqual(widget.winfo_x()+widget.winfo_width(), parent.winfo_width())
            self.assertLessEqual(widget.winfo_y()+widget.winfo_height(), parent.winfo_height())


if __name__ == '__main__': unittest.main()
