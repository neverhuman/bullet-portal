#!/usr/bin/env python3
"""Linux CI child supervision only; no workload or release authority."""

import ctypes
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

OUTPUT_LIMIT = 1024 * 1024
CLEANUP_SECONDS = 8


class Refusal(Exception):
    def __init__(self, reason, status=125):
        super().__init__(reason)
        self.status = status


def children():
    # This single-threaded process owns this list; never enumerate global PIDs.
    words = Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()
    if any(not word.isdecimal() or int(word) <= 0 for word in words):
        raise Refusal("COMPONENT_PROCESS_CHILD_INVENTORY_INVALID")
    return {int(word) for word in words}


def kill_child(pid):
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        # Recheck custody after opening the pidfd; a reused nonchild is excluded.
        if pid in children():
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            except ProcessLookupError:
                pass
    finally:
        os.close(descriptor)


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def cleanup():
    deadline = time.monotonic() + CLEANUP_SECONDS
    while time.monotonic() < deadline:
        try:
            # Killing nested subreapers causes their children to be adopted here.
            for pid in children():
                kill_child(pid)
            reap()
            if not children():
                return True
        except (OSError, Refusal):
            pass
        time.sleep(0.01)
    return False


def install_custody(stop):
    if sys.platform != "linux" or not hasattr(os, "pidfd_open"):
        raise Refusal("COMPONENT_PROCESS_LINUX_PIDFD_REQUIRED")
    if not hasattr(signal, "pidfd_send_signal"):
        raise Refusal("COMPONENT_PROCESS_LINUX_PIDFD_REQUIRED")
    parent = os.getppid()

    def interrupted(number, _frame):
        if not stop[0]:
            stop[0] = number

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4
    libc.prctl.restype = ctypes.c_int
    for option, value in ((36, 1), (1, signal.SIGTERM)):
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise Refusal("COMPONENT_PROCESS_CUSTODY_UNAVAILABLE")
    if parent == 1 or os.getppid() != parent:
        stop[0] = signal.SIGTERM
    descriptor = os.pidfd_open(os.getpid())
    os.close(descriptor)
    children()


class Output:
    def __init__(self):
        self.pending = {1: bytearray(), 2: bytearray()}
        self.total = 0
        self.blocking = {}
        for descriptor in self.pending:
            self.blocking[descriptor] = os.get_blocking(descriptor)
            os.set_blocking(descriptor, False)

    def add(self, descriptor, data):
        # Reserve enough room for one bounded supervisor refusal diagnostic.
        room = OUTPUT_LIMIT - 256 - self.total
        accepted = data[:max(room, 0)]
        self.pending[descriptor].extend(accepted)
        self.total += len(accepted)
        if len(accepted) != len(data):
            raise Refusal("COMPONENT_PROCESS_OUTPUT_LIMIT")

    def flush(self):
        for descriptor, pending in self.pending.items():
            if not pending:
                continue
            try:
                written = os.write(descriptor, pending[:65536])
            except (BlockingIOError, InterruptedError):
                continue
            del pending[:written]
        return not any(self.pending.values())

    def finish(self, reason):
        if reason:
            self.pending[2].extend((reason + "\n").encode("ascii"))
        deadline = time.monotonic() + 1
        try:
            while not self.flush() and time.monotonic() < deadline:
                time.sleep(0.01)
            return not any(self.pending.values())
        except OSError:
            return False
        finally:
            for descriptor, blocking in self.blocking.items():
                os.set_blocking(descriptor, blocking)


def supervise(command, timeout):
    stop = [0]
    process = None
    output = None
    reader = selectors.DefaultSelector()
    status, reason = 125, None
    try:
        install_custody(stop)
        output = Output()
        if stop[0]:
            raise Refusal("COMPONENT_PROCESS_PARENT_GONE", 128 + stop[0])
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin"},
            close_fds=True,
            start_new_session=True,
        )
        for pipe, destination in ((process.stdout, 1), (process.stderr, 2)):
            os.set_blocking(pipe.fileno(), False)
            reader.register(pipe, selectors.EVENT_READ, destination)
        deadline = time.monotonic() + timeout
        finished_at = None
        while True:
            if stop[0]:
                raise Refusal("COMPONENT_PROCESS_INTERRUPTED", 128 + stop[0])
            if time.monotonic() >= deadline:
                raise Refusal("COMPONENT_PROCESS_TIMEOUT", 124)
            for key, _ in reader.select(0.02):
                data = os.read(key.fd, 65536)
                if data:
                    output.add(key.data, data)
                else:
                    reader.unregister(key.fileobj)
            drained = output.flush()
            result = process.poll()
            if result is None:
                continue
            if children():
                raise Refusal("COMPONENT_PROCESS_RESIDUAL_CHILDREN")
            if not reader.get_map() and drained:
                status = result if result >= 0 else 128 - result
                break
            if finished_at is None:
                finished_at = time.monotonic()
            if time.monotonic() - finished_at >= 1:
                raise Refusal("COMPONENT_PROCESS_OUTPUT_UNDRAINED")
    except Refusal as error:
        status, reason = error.status, str(error)
    except (OSError, ValueError):
        status, reason = 125, "COMPONENT_PROCESS_SUPERVISION_FAILED"
    finally:
        reader.close()
        if not cleanup():
            status, reason = 125, "COMPONENT_PROCESS_CHILDREN_UNCLEARED"
        if process is not None:
            process.poll()
            process.stdout.close()
            process.stderr.close()
        if output is not None:
            if not output.finish(reason):
                status = 125
        elif reason:
            os.write(2, (reason + "\n").encode("ascii"))
    return status


def main(arguments):
    if len(arguments) < 4 or arguments[0] != "--timeout-seconds" or arguments[2] != "--":
        raise Refusal("COMPONENT_PROCESS_ARGUMENTS_INVALID")
    try:
        timeout = float(arguments[1])
    except ValueError as error:
        raise Refusal("COMPONENT_PROCESS_TIMEOUT_INVALID") from error
    if not math.isfinite(timeout) or not 0 < timeout <= 700:
        raise Refusal("COMPONENT_PROCESS_TIMEOUT_INVALID")
    if not os.path.isabs(arguments[3]):
        raise Refusal("COMPONENT_PROCESS_ABSOLUTE_COMMAND_REQUIRED")
    return supervise(arguments[3:], timeout)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Refusal as refusal:
        print(str(refusal), file=sys.stderr)
        raise SystemExit(refusal.status) from None
