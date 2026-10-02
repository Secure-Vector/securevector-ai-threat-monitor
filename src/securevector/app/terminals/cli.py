"""`sv-monitor session ...`: the Agent Sessions board from a terminal.

Every command here is a thin client over the same loopback API the page uses,
so there is exactly one implementation of spawn, link and stop and the CLI
cannot acquire powers the UI does not have. In particular the CLI never builds
argv, never chooses an environment, and never starts a process itself: it names
a harness and a folder, and the host decides what that becomes.

Actions are recorded on the task's event trail as `cli` rather than `ui`, so an
audit shows which surface asked.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

from securevector.app.terminals.client import ApiError, AppNotRunning, TerminalsClient

# Anything longer is a title someone pasted a paragraph into; the API caps it
# at 120 too, so refusing here just makes the error local and legible.
TITLE_MAX = 120


def _print_table(rows: Sequence[Sequence[str]], headers: Sequence[str]) -> None:
    """Left-aligned columns sized to their content, with no borders.

    Deliberately not a box-drawing table: the output is meant to be readable
    with `grep` and `awk`, and a column of pipes gets in the way of both.
    """
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    print(line.rstrip())
    for row in rows:
        print("  ".join(c.ljust(widths[i]) for i, c in enumerate(row)).rstrip())


def _short(value: Optional[str], n: int) -> str:
    v = value or ""
    return v if len(v) <= n else v[: n - 1] + "…"


def _emit(payload: Any, as_json: bool) -> None:
    if as_json:
        json.dump(payload, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")


def cmd_list(client: TerminalsClient, args: argparse.Namespace) -> int:
    data = client.tasks()
    items = data.get("items") or []
    if args.json:
        _emit(data, True)
        return 0
    if not items:
        print("No sessions on the board.")
        return 0
    rows = []
    for t in items:
        rows.append(
            [
                t.get("id") or "",
                t.get("executor_id") or "",
                t.get("status") or "",
                # Same three states the board shows, in a word a terminal can
                # print: a live row backed by a recent governed call, one
                # standing only on the transcript file, and an ended row that
                # claims nothing about now. A surface that disagreed with the
                # page about whether a session is watched would be worse than
                # one that stayed silent.
                {True: "yes", False: "NO", None: "-"}.get(t.get("verified"), "-"),
                t.get("origin") or "",
                # A flat slice, not _short: the page shows eight characters
                # and the two must agree, or the same session reads as two
                # different ids depending on where you looked.
                (t.get("session_id") or "")[:8],
                _short(t.get("workspace"), 48),
            ]
        )
    _print_table(rows, ["ID", "HARNESS", "STATUS", "WATCHED", "ORIGIN", "SESSION", "FOLDER"])
    unwatched = sum(1 for t in items if t.get("verified") is False)
    print(f"\n{len(items)} session(s), {data.get('running', 0)} running here.")
    if unwatched:
        # Named rather than left to be spotted in a column: an unwatched live
        # session is the one thing on this board worth acting on.
        print(
            f"{unwatched} live session(s) are NOT reporting governed calls. "
            "Check the Guard plugin for that harness."
        )
    return 0


def cmd_executors(client: TerminalsClient, args: argparse.Namespace) -> int:
    data = client.executors()
    if args.json:
        _emit(data, True)
        return 0
    rows = []
    for e in data.get("items") or []:
        rows.append(
            [
                e.get("id") or "",
                "yes" if e.get("installed") else "no",
                "yes" if e.get("governed") else "no",
                "yes" if e.get("supports_resume") else "no",
                _short(e.get("hint"), 60),
            ]
        )
    _print_table(rows, ["HARNESS", "INSTALLED", "GOVERNED", "RESUME", "NOTE"])
    return 0


def cmd_unlinked(client: TerminalsClient, args: argparse.Namespace) -> int:
    data = client.unlinked()
    items = data.get("items") or []
    if args.json:
        _emit(data, True)
        return 0
    if not items:
        print("No unreported sessions in the last 24 hours.")
        return 0
    rows = [
        [
            (r.get("session_id") or "")[:8],
            r.get("executor_id") or "",
            str(r.get("calls") or 0),
            _short(r.get("workspace") or "folder not reported", 48),
        ]
        for r in items
    ]
    _print_table(rows, ["SESSION", "HARNESS", "CALLS", "FOLDER"])
    print("\nPut one on the board with:  sv-monitor session link <harness> <session>")
    return 0


def cmd_launch(client: TerminalsClient, args: argparse.Namespace) -> int:
    # Resolved here so `.` and `~/x` mean what they mean in THIS shell. The
    # host resolves again and refuses anything that is not a real directory;
    # this only makes the common case work and the error name a real path.
    folder = str(Path(args.folder).expanduser().resolve())
    task = client.launch(
        args.harness,
        folder,
        title=args.title,
        resume_session_id=args.resume,
    )
    if args.json:
        _emit(task, True)
        return 0
    print(f"Launched {task.get('executor_id')} in {task.get('workspace')}")
    print(f"  id      {task.get('id')}")
    if args.resume:
        print(f"  resumed {args.resume}")
    return 0


def cmd_link(client: TerminalsClient, args: argparse.Namespace) -> int:
    folder = str(Path(args.folder).expanduser().resolve()) if args.folder else None
    task = client.link(args.harness, args.session, workspace=folder, title=args.title)
    if args.json:
        _emit(task, True)
        return 0
    print(f"Linked {task.get('executor_id')} session {task.get('session_id')}")
    print(f"  id     {task.get('id')}")
    print(f"  folder {task.get('workspace')}")
    return 0


def cmd_stop(client: TerminalsClient, args: argparse.Namespace) -> int:
    if args.all:
        client.stop_all()
        print("Stopped every session this app owns.")
        return 0
    if not args.task_id:
        print("Name a session id, or pass --all.", file=sys.stderr)
        return 2
    client.stop(args.task_id)
    print(f"Stopped {args.task_id}.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sv-monitor session",
        description="Launch, link and stop governed agent sessions.",
    )
    # `--json` lives on each action, never before one. Reaching this parser
    # through `sv-monitor session` goes via argparse.REMAINDER, which does not
    # reliably capture a leading option, so a top-level `--json` would parse
    # here and still be rejected by the outer parser. One working form beats
    # two documented ones where only the second works.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="Machine readable output")
    sub = parser.add_subparsers(dest="action", metavar="ACTION")

    sub.add_parser("list", help="Sessions on the board", parents=[common])
    sub.add_parser(
        "harnesses",
        help="Which harnesses can be launched, and whether they are governed",
        parents=[common],
    )
    sub.add_parser(
        "unlinked",
        help="Sessions reporting in that the board does not hold yet",
        parents=[common],
    )

    p_launch = sub.add_parser(
        "launch", help="Start a governed session in a folder", parents=[common]
    )
    p_launch.add_argument("harness", help="claude-code, codex, copilot-cli or opencode")
    p_launch.add_argument("folder", nargs="?", default=".", help="Working folder (default: here)")
    p_launch.add_argument("--title", help="A name for the board", default=None)
    p_launch.add_argument(
        "--resume",
        metavar="SESSION_ID",
        default=None,
        help="Reopen this harness session instead of starting a fresh one",
    )

    p_link = sub.add_parser(
        "link", help="Put a session you started yourself on the board", parents=[common]
    )
    p_link.add_argument("harness", help="claude-code, codex, copilot-cli or opencode")
    p_link.add_argument("session", help="The harness session id")
    p_link.add_argument("--folder", default=None, help="Its working folder, if it never reported one")
    p_link.add_argument("--title", default=None)

    p_stop = sub.add_parser(
        "stop", help="Stop a session this app owns", parents=[common]
    )
    p_stop.add_argument("task_id", nargs="?", default=None)
    p_stop.add_argument("--all", action="store_true", help="Stop every session this app owns")
    return parser


ACTIONS = {
    "list": cmd_list,
    "harnesses": cmd_executors,
    "unlinked": cmd_unlinked,
    "launch": cmd_launch,
    "link": cmd_link,
    "stop": cmd_stop,
}


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.action:
        parser.print_help()
        return 2
    if getattr(args, "title", None) and len(args.title) > TITLE_MAX:
        print(f"Title is longer than {TITLE_MAX} characters.", file=sys.stderr)
        return 2
    try:
        client = TerminalsClient()
        return ACTIONS[args.action](client, args)
    except AppNotRunning as exc:
        # Not a traceback: this is the everyday case of running the command
        # before opening the app, and the message already says what to do.
        print(str(exc), file=sys.stderr)
        return 3
    except ApiError as exc:
        print(f"{exc.detail}", file=sys.stderr)
        return 4


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
