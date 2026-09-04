"""Run MLIA with a parent-process watchdog.

The VS Code extension normally stops MLIA/Model Explorer when the owning webview
is closed, but normal disposables are not a hard lifetime guarantee: the
extension host can be reloaded, killed, or crash before JavaScript cleanup runs.
MLIA's Model Explorer serve mode is intentionally long-running and does not exit
just because its original launcher disappears, so it can otherwise become an
orphaned server process.

Different platforms have different OS-specific solutions for tying process trees
to a parent lifetime (for example Windows Job Objects, process groups, or parent
death signals). A small Python wrapper is the best portable compromise here:
we run MLIA in-process and monitor the VS Code extension host PID from a daemon
thread. If that parent PID exits, the wrapper interrupts MLIA and then exits,
which also brings down the embedded Model Explorer server without needing a
native helper per platform.
"""

from __future__ import annotations

import argparse
import ctypes
import os
import re
import signal
import sys
import threading
import time
import traceback
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from typing import TextIO

_ERROR_SUMMARY_PREFIX = "MLIA_WATCHDOG_ERROR_SUMMARY: "
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_SHUTDOWN_STARTED = threading.Event()


class _CapturedStderr:
    """Forward stderr while retaining text needed to summarize explicit errors."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._parts: list[str] = []

    def write(self, text: str | bytes) -> int:
        """Capture and forward stderr text, including Typer's byte writes."""
        if isinstance(text, bytes):
            encoding = self._stream.encoding or "utf-8"
            decoded = text.decode(encoding, errors="replace")
        else:
            decoded = text
        self._parts.append(decoded)
        return self._stream.write(decoded)

    def flush(self) -> None:
        """Flush the underlying stderr stream."""
        self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        """Delegate stream capabilities such as encoding, fileno and isatty."""
        return getattr(self._stream, name)

    @property
    def text(self) -> str:
        """Return all captured stderr text."""
        return "".join(self._parts)


def main(argv: Sequence[str] | None = None) -> None:
    """Run MLIA and interrupt it if the parent process exits."""
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    mlia_args = list(args.mlia_args)
    if mlia_args and mlia_args[0] == "--":
        mlia_args = mlia_args[1:]

    _configure_mlia_settings(args.config_file)

    threading.Thread(
        target=_watch_parent,
        args=(args.parent_pid,),
        daemon=True,
        name="mlia-parent-watchdog",
    ).start()
    sys.argv = ["mlia", *mlia_args]
    _run_mlia()


def _configure_mlia_settings(config_file: Path) -> None:
    """Point MLIA's in-process settings loader at the extension-managed file."""
    config_path = config_file.expanduser().resolve()
    if not config_path.is_file():
        raise FileNotFoundError(f"MLIA configuration file does not exist: {config_path}")

    import mlia.cli.settings as cli_settings  # pylint: disable=import-outside-toplevel

    cli_settings._CONFIG_PATH = config_path  # pylint: disable=protected-access


def _run_mlia() -> None:
    """Run MLIA and make its final failure summary machine-readable."""
    original_stderr = sys.stderr
    captured_stderr = _CapturedStderr(original_stderr)
    sys.stderr = captured_stderr  # type: ignore[assignment]
    try:
        from mlia.cli.main import main as mlia_main  # pylint: disable=import-outside-toplevel

        mlia_main()
    except SystemExit as error:
        exit_code = _system_exit_code(error)
        if exit_code != 0 and not _SHUTDOWN_STARTED.is_set():
            summary = _explicit_error_summary(captured_stderr.text)
            if summary:
                _emit_error_summary(summary, captured_stderr)
        raise SystemExit(exit_code) from None
    except KeyboardInterrupt:
        raise
    except Exception as error:  # pylint: disable=broad-except
        traceback.print_exception(type(error), error, error.__traceback__, file=captured_stderr)
        if not _SHUTDOWN_STARTED.is_set():
            _emit_error_summary(str(error) or type(error).__name__, captured_stderr)
        raise SystemExit(1) from None
    finally:
        sys.stderr = original_stderr


def _system_exit_code(error: SystemExit) -> int:
    """Convert SystemExit's permissive code value into a process exit code."""
    if error.code is None:
        return 0
    if isinstance(error.code, int):
        return error.code
    return 1


def _explicit_error_summary(stderr: str) -> str | None:
    """Return the final explicit ``Error:`` diagnostic emitted by MLIA."""
    for raw_line in reversed(stderr.splitlines()):
        line = _ANSI_ESCAPE_RE.sub("", raw_line).strip()
        if line.startswith("Error:"):
            summary = _single_line(line.removeprefix("Error:"))
            return summary or None
    return None


def _emit_error_summary(summary: str, stream: TextIO) -> None:
    """Emit the final single-line watchdog protocol marker."""
    normalized = _single_line(summary)
    if normalized:
        print(f"{_ERROR_SUMMARY_PREFIX}{normalized}", file=stream, flush=True)


def _single_line(value: str) -> str:
    """Collapse arbitrary exception text into one stable summary line."""
    return " ".join(value.split())


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run MLIA with a parent-process watchdog."
    )
    parser.add_argument("--parent-pid", type=int, required=True)
    parser.add_argument("--config-file", type=Path, required=True)
    parser.add_argument("mlia_args", nargs=argparse.REMAINDER)
    return parser.parse_args(argv)


def _watch_parent(parent_pid: int) -> None:
    while _parent_is_alive(parent_pid):
        time.sleep(1)
    _interrupt_main_then_exit("Parent process exited; stopping MLIA.")


def _interrupt_main_then_exit(message: str) -> None:
    if not _SHUTDOWN_STARTED.is_set():
        _SHUTDOWN_STARTED.set()
        print(message, file=sys.stderr, flush=True)
        signal.raise_signal(signal.SIGINT)
        time.sleep(5)
    os._exit(0)  # noqa: PLR1722 - the parent is gone, so avoid leaving a server orphaned.


def _parent_is_alive(parent_pid: int) -> bool:
    if os.name == "nt":
        return _windows_process_is_alive(parent_pid)

    try:
        os.kill(parent_pid, 0)
    except OSError:
        return False
    return True


def _windows_process_is_alive(pid: int) -> bool:
    process_query_limited_information = 0x1000
    still_active = 259

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return False

    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


if __name__ == "__main__":
    main()
