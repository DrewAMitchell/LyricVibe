import subprocess
import unittest
from unittest.mock import patch

from native.windows_runtime import install_headless_children


class WindowsRuntimeTests(unittest.TestCase):
    def test_console_policy_preserves_flags_and_positional_arguments_and_installs_once(self):
        calls = []

        class FakePopen:
            def __init__(self, args, bufsize=-1, creationflags=0, *, shell=False):
                calls.append((args, bufsize, creationflags, shell))

        with patch('native.windows_runtime.os.name', 'nt'), \
                patch.object(subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), \
                patch.object(subprocess, 'Popen', FakePopen):
            install_headless_children()
            installed = subprocess.Popen
            install_headless_children()
            self.assertIs(subprocess.Popen, installed)
            subprocess.Popen('ver', 4, 0x20, shell=True)
            subprocess.Popen(['node'], creationflags=0x100)
        self.assertEqual(calls, [('ver', 4, 0x08000020, True), (['node'], -1, 0x08000100, False)])

    def test_non_windows_is_unchanged(self):
        original = subprocess.Popen
        with patch('native.windows_runtime.os.name', 'posix'):
            install_headless_children()
        self.assertIs(subprocess.Popen, original)
