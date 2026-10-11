"""Windows GUI process policy: console children never request a console window.

Install once at a GUI entry point, before optional runtime imports. This covers
indirect children such as Python's platform probe during sounddevice import.
It does not hide the program's own Tk window or change non-Windows behavior.
"""
from __future__ import annotations

import inspect
import os
import subprocess


def install_headless_children() -> None:
    if os.name != 'nt' or getattr(subprocess.Popen, '_lyricvibe_headless', False):
        return
    original = subprocess.Popen
    signature = inspect.signature(original)

    class HeadlessPopen(original):
        _lyricvibe_headless = True

        def __init__(self, *args, **kwargs):
            # Binding preserves positional creationflags and all standard Popen
            # options, including flags selected by a dependency.
            bound = signature.bind_partial(*args, **kwargs)
            bound.arguments['creationflags'] = (bound.arguments.get('creationflags', 0)
                                                 | subprocess.CREATE_NO_WINDOW)
            super().__init__(*bound.args, **bound.kwargs)

    subprocess.Popen = HeadlessPopen
