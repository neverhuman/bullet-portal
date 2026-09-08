#!/usr/bin/env python3
"""Fake-process acceptance for the standalone Linux CI supervisor."""

import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SUPERVISOR = Path(__file__).with_name("component-process.py").resolve()
WORKER = r'''
import ctypes, os, signal, sys, time
from pathlib import Path
mode, record = sys.argv[1:3]
def note():
    stamp = Path(f"/proc/{os.getpid()}/stat").read_text().rpartition(")")[2].split()[19]
    fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.write(fd, f"{os.getpid()} {stamp}\n".encode())
    os.close(fd)
def forever():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    while True: time.sleep(1)
note()
if mode == "normal":
    assert "COMPONENT_PARENT_SECRET" not in os.environ
    assert os.environ["PATH"] == "/usr/bin:/bin"
    assert sys.argv[3] == "literal $(false); `false`"
    os.write(1, b"exact stdout\n")
    os.write(2, b"exact stderr\n")
elif mode == "nonzero":
    os.write(1, b"worker failure\n")
    sys.exit(27)
elif mode == "overflow":
    while True: os.write(1, b"x" * 65536)
elif mode == "backpressure":
    os.write(1, b"x" * 100000)
else:
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    if os.fork() == 0:
        os.setsid()
        assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
        note()
        if os.fork() == 0:
            os.setsid()
            note()
            forever()
        forever()
    while len(Path(record).read_text().splitlines()) != 3: time.sleep(0.01)
    Path(record + ".ready").touch()
    if mode == "residual": sys.exit(0)
    forever()
'''


def identity(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()[19]
    except FileNotFoundError:
        return None


class ComponentProcessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != "linux" or not hasattr(os, "pidfd_open"):
            raise RuntimeError("COMPONENT_PROCESS_TEST_LINUX_REQUIRED")
        # Adopt the supervisor when the parent-death fixture kills its launcher.
        if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
            raise RuntimeError("COMPONENT_PROCESS_TEST_SUBREAPER_REQUIRED")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.worker = self.root / "fake-worker.py"
        self.worker.write_text(WORKER)
        self.record = self.root / "children"
        self.handles = []
        self.addCleanup(self.emergency_cleanup)

    def remember(self, pid):
        stamp = identity(pid)
        if stamp is not None:
            try:
                descriptor = os.pidfd_open(pid)
            except ProcessLookupError:
                return
            if identity(pid) == stamp:
                self.handles.append((pid, stamp, descriptor))
            else:
                os.close(descriptor)

    def emergency_cleanup(self):
        # Test failure fallback uses only exact fixture identities, never ps/pkill.
        if self.record.exists():
            for line in self.record.read_text().splitlines():
                pid, stamp = line.split()
                if identity(int(pid)) == stamp:
                    self.remember(int(pid))
        for _pid, _stamp, descriptor in self.handles:
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(descriptor)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    time.sleep(0.01)
            except ChildProcessError:
                return

    def command(self, mode, timeout=3):
        return [sys.executable, str(SUPERVISOR), "--timeout-seconds", str(timeout), "--",
                sys.executable, str(self.worker), mode, str(self.record), "literal $(false); `false`"]

    def start(self, mode, timeout=3):
        process = subprocess.Popen(self.command(mode, timeout), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE,
                                   env={"PATH": "/untrusted", "COMPONENT_PARENT_SECRET": "canary"})
        self.remember(process.pid)
        self.addCleanup(process.stdout.close)
        self.addCleanup(process.stderr.close)
        return process

    def ready(self, process):
        deadline = time.monotonic() + 4
        while not Path(str(self.record) + ".ready").exists():
            self.assertIsNone(process.poll(), "supervisor exited before escaped children were ready")
            self.assertLess(time.monotonic(), deadline, "fixture readiness deadline")
            time.sleep(0.01)
        entries = [line.split() for line in self.record.read_text().splitlines()]
        self.assertEqual(len(entries), 3)
        for pid, _stamp in entries:
            self.remember(int(pid))
        self.assertNotEqual(os.getsid(int(entries[0][0])), os.getsid(int(entries[1][0])))
        self.assertNotEqual(os.getsid(int(entries[1][0])), os.getsid(int(entries[2][0])))

    def assert_gone(self):
        self.assertTrue(self.record.exists())
        for line in self.record.read_text().splitlines():
            pid, stamp = line.split()
            self.assertNotEqual(identity(int(pid)), stamp, f"unreaped fixture process {pid}")

    def test_normal_preserves_output_and_clears_environment_without_shell(self):
        process = self.start("normal")
        stdout, stderr = process.communicate(timeout=12)
        self.assertEqual((process.returncode, stdout, stderr), (0, b"exact stdout\n", b"exact stderr\n"))
        self.assert_gone()

    def test_nonzero_preserves_worker_exit(self):
        process = self.start("nonzero")
        stdout, stderr = process.communicate(timeout=12)
        self.assertEqual((process.returncode, stdout, stderr), (27, b"worker failure\n", b""))
        self.assert_gone()

    def test_output_overflow_is_bounded_and_reaped(self):
        process = self.start("overflow")
        stdout, stderr = process.communicate(timeout=12)
        self.assertEqual(process.returncode, 125)
        self.assertIn(b"COMPONENT_PROCESS_OUTPUT_LIMIT", stderr)
        self.assertLessEqual(len(stdout) + len(stderr), 1024 * 1024)
        self.assert_gone()

    def test_stalled_output_receiver_refuses_without_hanging(self):
        process = self.start("backpressure")
        # Deliberately leave stdout unread until the supervisor exits.
        self.assertEqual(process.wait(timeout=5), 125)
        stdout, stderr = process.communicate(timeout=2)
        self.assertIn(b"COMPONENT_PROCESS_OUTPUT_UNDRAINED", stderr)
        self.assertLess(len(stdout), 100000)
        self.assert_gone()

    def test_invalid_timeout_refuses_before_child_creation(self):
        for timeout in ("nan", "inf", "0", "-1", "701"):
            with self.subTest(timeout=timeout):
                process = self.start("normal", timeout=timeout)
                stdout, stderr = process.communicate(timeout=2)
                self.assertEqual((process.returncode, stdout), (125, b""))
                self.assertEqual(stderr, b"COMPONENT_PROCESS_TIMEOUT_INVALID\n")
                self.assertFalse(self.record.exists())

    def test_timeout_reaps_escaped_nested_subreapers(self):
        process = self.start("escaped", timeout=0.5)
        self.ready(process)
        _stdout, stderr = process.communicate(timeout=12)
        self.assertEqual(process.returncode, 124)
        self.assertIn(b"COMPONENT_PROCESS_TIMEOUT", stderr)
        self.assert_gone()

    def interrupt(self, number):
        process = self.start("escaped")
        self.ready(process)
        with os.fdopen(os.pidfd_open(process.pid), "rb") as descriptor:
            signal.pidfd_send_signal(descriptor.fileno(), number)
        _stdout, stderr = process.communicate(timeout=12)
        self.assertEqual(process.returncode, 128 + number)
        self.assertIn(b"COMPONENT_PROCESS_INTERRUPTED", stderr)
        self.assert_gone()

    def test_term_reaps_escaped_descendants(self):
        self.interrupt(signal.SIGTERM)

    def test_int_reaps_escaped_descendants(self):
        self.interrupt(signal.SIGINT)

    def test_normal_exit_refuses_and_reaps_residual_descendants(self):
        process = self.start("residual")
        _stdout, stderr = process.communicate(timeout=12)
        self.assertEqual(process.returncode, 125)
        self.assertIn(b"COMPONENT_PROCESS_RESIDUAL_CHILDREN", stderr)
        self.assert_gone()

    def test_parent_death_reaps_escaped_descendants(self):
        launcher = self.root / "launcher.py"
        launcher.write_text("""import pathlib, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
with (root / 'out').open('wb') as out, (root / 'err').open('wb') as err:
    process = subprocess.Popen(sys.argv[2:], stdout=out, stderr=err)
(root / 'supervisor.pid').write_text(str(process.pid))
time.sleep(30)
""")
        parent = subprocess.Popen([sys.executable, str(launcher), str(self.root)] + self.command("escaped"))
        self.remember(parent.pid)
        self.ready(parent)
        supervisor = int((self.root / "supervisor.pid").read_text())
        self.remember(supervisor)
        descriptor = os.pidfd_open(parent.pid)
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        os.close(descriptor)
        parent.wait(timeout=2)
        deadline = time.monotonic() + 10
        while True:
            waited, status = os.waitpid(supervisor, os.WNOHANG)
            if waited:
                self.assertEqual(os.waitstatus_to_exitcode(status), 143)
                break
            self.assertLess(time.monotonic(), deadline, "parent-death cleanup deadline")
            time.sleep(0.01)
        self.assertIn(b"COMPONENT_PROCESS_INTERRUPTED", (self.root / "err").read_bytes())
        self.assert_gone()


if __name__ == "__main__":
    unittest.main(verbosity=2)
