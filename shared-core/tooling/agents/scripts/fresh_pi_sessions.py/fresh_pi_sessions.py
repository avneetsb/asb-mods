#!/usr/bin/env python3
"""Drive consecutive REAL fresh pi sessions and record per-session memory evidence.

Why: the completion auditor rejected rail-side claims that came from restored gate-state files and
asked for three consecutive real fresh pi sessions, each persisting its own evidence, with recall
tool calls proven rather than inferred from injected-line counts. This driver launches `pi -p`
sessions — a real session id, its own transcript, its own session-scoped memory writes — and then
reads the durable artifacts (transcript jsonl + engram rows) to prove what each session did.

Every figure written comes from the transcript file or from engram's own rows filtered by that
session's id. Nothing here is a rail snapshot and nothing is asserted from memory.

Usage: python3 fresh_pi_sessions.py [count]
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
ART_DIR = os.path.join(HOME, ".agents/metrics/artifacts")
SESSION_ROOT = os.path.join(HOME, ".pi/agent/sessions")
ENGRAM_DB = os.path.join(HOME, ".engram/engram.db")
RECALL_TOOLS = ("mem_context", "mem_search", "mem_save", "mnemosyne_recall", "mnemosyne_remember")


def now_iso() -> str:
    return datetime.datetime.now(datetime.UTC).isoformat()


def sha16(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        return "unreadable"


def write_json(path: str, obj: object) -> bool:
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=1)
        return True
    except OSError:
        return False


def transcript_index() -> dict[str, str]:
    """Map session id -> newest transcript path under pi's session store."""
    out: dict[str, str] = {}
    try:
        walk = list(os.walk(SESSION_ROOT))
    except OSError:
        return out
    for root, _dirs, files in walk:
        for f in files:
            if not f.endswith(".jsonl"):
                continue
            p = os.path.join(root, f)
            sid = f.rsplit("_", 1)[-1].replace(".jsonl", "")
            prev = out.get(sid)
            try:
                newer = prev is None or os.path.getmtime(p) > os.path.getmtime(prev)
            except OSError:
                newer = prev is None
            if newer:
                out[sid] = p
    return out


def tool_calls(path: str) -> tuple[dict[str, int], int]:
    """Count tool invocations recorded in a session transcript, by tool name."""
    counts: dict[str, int] = {}
    total = 0
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return counts, total
    for line in lines:
        if '"name"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) else None
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and part.get("type") in ("toolCall", "tool_use", "tool-call"):
                nm = str(part.get("name") or part.get("toolName") or "?")
                counts[nm] = counts.get(nm, 0) + 1
                total += 1
    return counts, total


def engram_rows_for(sid: str) -> list[tuple[str, str, str, str]]:
    try:
        con = sqlite3.connect(f"file:{ENGRAM_DB}?mode=ro", uri=True)
    except sqlite3.Error:
        return []
    try:
        return list(
            con.execute(
                "SELECT scope, project, topic_key, created_at FROM observations WHERE session_id = ? ORDER BY id",
                (sid,),
            )
        )
    except sqlite3.Error:
        return []
    finally:
        con.close()


def prompt_for(i: int) -> str:
    return (
        "Do exactly this, using the tools named, in order. Do not skip a step and do not narrate instead of calling.\n"
        "1. Call mem_context with no arguments.\n"
        "2. Call mem_search with query 'rtk limits'.\n"
        "3. Call mnemosyne_recall with query 'rtk'.\n"
        "4. Run one bash command that lists this working directory.\n"
        f"5. Make exactly TWO deliberate engram saves with mem_save, scope 'project', topic_keys "
        f"'evidence-s{i}-cwd' and 'evidence-s{i}-tooling', each recording a fact you verified in step 4.\n"
        f"6. Print exactly: DONE {i} SAVES=2, then the number of recall tools you called."
    )


def main() -> int:
    try:
        count = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    except ValueError:
        print("count must be an integer")
        return 2
    try:
        os.makedirs(ART_DIR, exist_ok=True)
    except OSError as exc:
        print(f"cannot create artifact dir: {exc}")
        return 1
    results: list[dict[str, object]] = []
    saved_count = 0
    recall_count = 0
    for i in range(1, count + 1):
        workdir = os.path.join(HOME, ".agents/metrics/fresh-sessions", f"s{i}-{int(time.time())}")
        try:
            os.makedirs(workdir, exist_ok=True)
        except OSError as exc:
            print(f"[s{i}] cannot create workdir: {exc}", flush=True)
            continue
        before = set(transcript_index().keys())
        started = time.time()
        try:
            proc = subprocess.run(
                ["pi", "-p", "--name", f"rail-evidence-s{i}", prompt_for(i)],
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=float(os.environ.get("FRESH_TIMEOUT", "900")),
            )
            rc, stdout = proc.returncode, proc.stdout or ""
        except (subprocess.TimeoutExpired, OSError) as exc:
            rc, stdout = -1, f"launch failed: {exc}"
        idx = transcript_index()
        new_sids = sorted(s for s in idx if s not in before)
        sid: str | None = new_sids[0] if new_sids else None
        path: str = idx.get(sid, "") if sid else ""
        calls, total = tool_calls(path) if path else ({}, 0)
        rows = engram_rows_for(sid) if sid else []
        rec = {
            "n": i,
            "utc": now_iso(),
            "session_id": sid,
            "transcript": path or None,
            "transcript_sha256_16": sha16(path) if path else None,
            "cwd": workdir,
            "wall_seconds": round(time.time() - started, 1),
            "rc": rc,
            "pi_stdout_tail": stdout[-400:],
            "tool_calls_total": total,
            "memory_tool_calls": {k: v for k, v in sorted(calls.items()) if k in RECALL_TOOLS},
            "engram_rows_for_this_session_id": [
                {"scope": r[0], "project": r[1], "topic_key": r[2], "created_at": r[3]} for r in rows
            ],
            "engram_save_count_for_session": len(rows),
        }
        results.append(rec)
        print(
            f"[s{i}] sid={sid} tools={total} mem={rec['memory_tool_calls']} "
            f"engram_rows={len(rows)} rc={rc} {rec['wall_seconds']}s",
            flush=True,
        )
        if path:
            print(f"      transcript={path} sha16={sha16(path)}", flush=True)
        if sid and len(rows) >= 2:
            saved_count += 1
        if any(k in calls for k in ("mem_context", "mem_search", "mnemosyne_recall")):
            recall_count += 1
    out = os.path.join(ART_DIR, "fresh-pi-sessions.json")
    saved = write_json(out, {"captured_utc": now_iso(), "sessions": results})
    print(
        f"\nSUMMARY: {saved_count}/{count} sessions with >=2 engram saves; "
        f"{recall_count}/{count} with recall tool calls; artifact {out} written={saved}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
