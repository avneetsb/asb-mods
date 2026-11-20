#!/usr/bin/env python3
"""Measure rtk savings on a sample of real commands recorded in rtk's own history.

Why this exists
---------------
`~/.config/rtk/filters.toml` and `~/Library/Application Support/rtk/filters.toml` accept
`[filters.<name>]` blocks with `match_command`, and writing them looks like the fix for the
53.5% of commands that save zero tokens. It is not, on this machine, and the reason is
mechanical: pi-rtk-optimizer decides what runs through rtk by shelling out to `rtk rewrite`
(src/rtk-rewrite-provider.ts:55) and never reads filters.toml. Verified 2026-11-13:

    rtk rewrite "python3 -c 'print(1)'"          -> rc=1, empty stdout  (custom filter ignored)
    rtk run "python3 -c print(A/blank/blank/B)"  -> blank lines survive (filter not applied)
    rtk rewrite "bd ready"                        -> rc=1, empty stdout
    rtk rewrite "git status"                      -> rc=3, "rtk git status"  (built-in, works)

So the only filters that ever run are the ones `rtk rewrite` emits, i.e. rtk's built-in
subcommands. Improving savings means routing more real command shapes through those, and
proving it with numbers rtk records itself — not by eyeballing filtered output (rtk rewrites
its own display, which makes proxied echoes untrustworthy per ~/.pi/agent/AGENTS.md).

What it does
------------
1. Reads rtk history and picks the recorded commands that burned the most input tokens while
   saving zero, restricted to read-only shapes.
2. Re-runs each one through rtk, mapping `bd <sub>` to `rtk beads <sub>` — the one genuine
   gap found: `bd show`/`bd list` were 89 of 870 zero-savers, `bd` gets no rewrite, while
   `rtk beads` exists and runs.
3. Reads back the rows rtk just wrote and prints boolean verdicts against the goal thresholds.

Usage: python3 rtk_savings_sample.py [--limit N] [--dry-run]
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys

RTK_BIN = shutil.which("rtk") or "/opt/homebrew/bin/rtk"
RTK_DB = os.path.expanduser("~/Library/Application Support/rtk/history.db")

# Goal contract thresholds.
TARGET_AVG_SAVINGS_PCT = 2.6
TARGET_ZERO_SAVED_SHARE_PCT = 54.0

# Read-only shapes only: this script re-runs recorded commands, so anything that writes,
# deletes, installs, or reaches the network is excluded outright.
ALLOWED_PREFIXES = (
    "grep ",
    "git status",
    "git log",
    "git diff",
    "git rev-parse",
    "git branch",
    "ls ",
    "cat ",
    "tail ",
    "head ",
    "sed -n",
    "ruff check",
    "bd list",
    "bd show ",
    "bd ready",
    "wc ",
)

# Recorded binary -> the rtk invocation that actually reaches a filter (checked via rtk rewrite).
RTK_ROUTE = {"bd": "beads"}


def recorded_waste(limit: int) -> list[tuple[int, str, str]]:
    """Recorded commands with the largest input and zero saved tokens, read-only shapes only.

    A command only qualifies if the project directory it ran in still exists. The recorded
    giants mostly grep `/opt/homebrew/Cellar/pi-coding-agent/1.4.0/...`, which is gone (this
    machine runs 1.5.2), so re-running them emits nothing and measures 0% savings while
    proving nothing — 25 such commands totalled 963 input tokens.
    """
    con = sqlite3.connect(RTK_DB)
    rows = con.execute(
        "select input_tokens, original_cmd, project_path from commands "
        "where coalesce(saved_tokens,0)=0 and input_tokens > 200 "
        "order by input_tokens desc limit 600"
    ).fetchall()
    con.close()
    picked: list[tuple[int, str, str]] = []
    seen: set[str] = set()
    dropped_missing_cwd = 0
    dropped_missing_target = 0
    for tokens, cmd, project in rows:
        text = (cmd or "").strip()
        cwd = (project or "").strip()
        if not text or text in seen:
            continue
        if not text.startswith(ALLOWED_PREFIXES):
            continue
        if any(ch in text for ch in (";", ">", "<", "`", "$(")):
            continue
        if not cwd or not os.path.isdir(cwd):
            dropped_missing_cwd += 1
            continue
        # The command's own target must still exist too: the recorded giants grep a pi 1.4.0
        # install path that 1.5.2 replaced, so a live cwd alone still yields empty output.
        if not any(
            os.path.exists(os.path.expanduser(token))
            for token in text.split()
            if "/" in token and not token.startswith("-")
        ):
            dropped_missing_target += 1
            continue
        seen.add(text)
        picked.append((int(tokens), text, cwd))
        if len(picked) >= limit:
            break
    print(f"candidates dropped: {dropped_missing_cwd} vanished cwd, {dropped_missing_target} vanished target path")
    return picked


def to_rtk(cmd: str) -> list[str]:
    """Build the rtk argv for a recorded command, preserving its shell quoting.

    Splitting the recorded text on whitespace (the first attempt) destroyed that quoting, so a
    grep pattern arrived broken, matched nothing, and recorded in=0/out=0 — a number that
    measures nothing. shlex.split restores the original argv, and passing a list keeps the call
    parameterized: nothing here is ever re-parsed by a shell, so a stored command string cannot
    become an injection sink.
    """
    head, _, rest = cmd.partition(" ")
    route = RTK_ROUTE.get(head)
    if route:
        return [RTK_BIN, route, *shlex.split(rest)]
    return [RTK_BIN, *shlex.split(cmd)]


def run_sample(picked: list[tuple[int, str, str]]) -> int:
    ran = 0
    for _tokens, cmd, cwd in picked:
        try:
            subprocess.run(
                to_rtk(cmd), capture_output=True, text=True, timeout=90, cwd=cwd
            )
            ran += 1
        except (subprocess.TimeoutExpired, OSError) as exc:
            print(f"  skip {cmd[:60]!r}: {type(exc).__name__}")
    print(f"re-ran {ran} recorded commands")
    return ran


def measure_since(started_utc: dt.datetime) -> dict[str, float | int]:
    """Read back what rtk recorded for the re-runs. rtk stores UTC ISO timestamps."""
    con = sqlite3.connect(RTK_DB)
    cutoff = started_utc.strftime("%Y-%m-%d %H:%M:%S")
    rows = con.execute(
        "select input_tokens, saved_tokens, savings_pct from commands "
        "where datetime(timestamp) >= datetime(?)",
        (cutoff,),
    ).fetchall()
    con.close()
    if not rows:
        return {}
    count = len(rows)
    zero = sum(1 for row in rows if row[1] == 0)
    avg = sum(row[2] for row in rows) / count
    return {
        "sample_commands": count,
        "sample_avg_savings_pct": round(avg, 3),
        "sample_zero_saved_rows": zero,
        "sample_zero_saved_share_pct": round(100.0 * zero / count, 1),
        "sample_input_tokens": sum(row[0] for row in rows),
        "sample_saved_tokens": sum(row[1] for row in rows),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--dry-run", action="store_true", help="print the sample, run nothing")
    args = parser.parse_args()

    picked = recorded_waste(args.limit)
    print(f"sample of recorded zero-saving commands ({len(picked)}):")
    for tokens, cmd, cwd in picked:
        print(f"  {tokens:6d} tok  [{cwd[:22]:22}]  {cmd[:70]}")
    if args.dry_run:
        return 0
    if not picked:
        print("no eligible recorded commands")
        return 1

    started = dt.datetime.now(dt.UTC)
    run_sample(picked)
    print(f"window start (UTC): {started.isoformat(timespec='seconds')}")

    stats = measure_since(started)
    if not stats:
        print("FAIL no rtk rows recorded during the sample window")
        return 1

    print("\nmeasured from rtk history:")
    for key, value in stats.items():
        print(f"  {key:<28} {value}")

    avg = float(stats["sample_avg_savings_pct"])
    share = float(stats["sample_zero_saved_share_pct"])
    checks = [
        (avg > TARGET_AVG_SAVINGS_PCT, "sample_avg_above_2.6_pct",
         f"{avg} vs target > {TARGET_AVG_SAVINGS_PCT}"),
        (share < TARGET_ZERO_SAVED_SHARE_PCT, "sample_zero_share_below_54_pct",
         f"{share} vs target < {TARGET_ZERO_SAVED_SHARE_PCT}"),
    ]
    print("\nverdicts:")
    for ok, name, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'} {name} ({detail})")
    return 0 if all(ok for ok, _, _ in checks) else 2


if __name__ == "__main__":
    sys.exit(main())
