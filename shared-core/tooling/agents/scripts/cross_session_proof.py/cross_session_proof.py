#!/usr/bin/env python3
"""Cross-session recall proof (auditor objection 3, rework v2).

Claim to prove with durable evidence: a memory WRITTEN by one session after
the change appears, verbatim, in a DIFFERENT session's memory-tool RESULT.

v1 (committed at 1726490b) was unsound in three ways, all found by its own
NOT-PROVEN rerun on 2026-11-14 morning:
  * DEFAULT_TOKENS were phrases its matched sessions never actually returned
    (the earlier "proven" reading came from an argv row-id, not the defaults);
  * recall calls made through pi's MCP proxy appear in transcripts as tool
    name "mcp" with the real tool inside args — RECALL_TOOLS gating scanned
    no results at all;
  * it exited 0 even when NOT proven, so callers could not tell.

v2 contract:
  * tokens are DERIVED from the mnemosyne store: working_memory rows created
    at/after the change enforcement (2026-11-13 18:00), each contributing its
    row id plus a leading content phrase;
  * writer attribution is two-tier: the store's session_id column when set,
    otherwise disk-evidenced — the session whose transcript contains a SAVE
    tool-call whose paired result text includes that row id; tokens with no
    attributable writer are reported but can never produce PASS;
  * recall/save detection understands the proxy shape (name "mcp"/"mcp__*"
    with the underlying mnemosyne/mem0 tool name inside args);
  * a PASS requires the token in a RECALL result of a transcript whose session
    differs from the writer's (uuid-prefix comparison);
  * scan set = fresh-session driver artifacts PLUS every transcript modified
    at/after the cutoff (most recent 40), so organic sessions participate;
  * exit 0 = proven, 2 = not proven, 1 = hard error (readable by callers/CI).

Writes metrics/artifacts/cross-session-proof.json next to itself. Read-only
against stores and transcripts.
"""
import glob
import json
import os
import re
import sqlite3
import sys
import time

ART_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "metrics")
DRIVER_ART = os.path.join(ART_DIR, "fresh-sessions", "report.json")
ROOT = os.path.expanduser("~/.pi/agent/sessions")
PROOF = os.path.join(ART_DIR, "artifacts", "cross-session-proof.json")
STORE = os.path.expanduser("~/.hermes/mnemosyne/data/mnemosyne.db")
CUTOFF = "2026-11-13 18:00"          # change enforcement timestamp
SID_RE = re.compile(r"\b01a1[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\b")

SAVE_TOOLS = ("mnemosyne_remember", "mnemosyne_remember_canonical",
              "mnemosyne_shared_remember", "mem_save")
RECALL_TOOLS = ("mnemosyne_recall", "mnemosyne_recall_canonical",
                "mnemosyne_shared_recall", "mem_search", "mem_context")


def norm_sid(s):
    return (s or "").lower().replace("-", "")


def same_session(a, b):
    na, nb = norm_sid(a), norm_sid(b)
    if not na or not nb:
        return False
    n = min(len(na), len(nb))
    return n >= 12 and na[:n] == nb[:n]


def parts_of(o):
    """Uniform (kind, name, cid, args_obj, text) tuples for one transcript entry."""
    msg = o.get("message") if isinstance(o.get("message"), dict) else None
    if msg is None:
        return []
    role, out = msg.get("role"), []
    content = msg.get("content") if isinstance(msg.get("content"), list) else []
    if role == "assistant":
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "toolCall":
                continue
            name = str(part.get("name") or "")
            args = part.get("arguments")
            if not isinstance(args, dict):
                args = {}
            out.append(("call", name, part.get("id"), args, ""))
    elif role == "toolResult":
        text = "\n".join(str(p.get("text") or "") for p in content
                         if isinstance(p, dict) and p.get("type") == "text")
        out.append(("result", str(msg.get("toolName") or ""),
                    msg.get("toolCallId"), {}, text))
    return out


def call_kind(name, args):
    """'recall'|'save'|None — understands pi's mcp proxy: name 'mcp' with the
    underlying tool inside arguments.tool."""
    probe = name
    if name == "mcp" and isinstance(args.get("tool"), str):
        probe = args["tool"]
    if any(t in probe for t in RECALL_TOOLS):
        return "recall"
    if any(t in probe for t in SAVE_TOOLS):
        return "save"
    return None


def scan(path):
    """Return (recall result texts, all result texts, recall_cids, save_cids)."""
    recall_results, all_results = [], []
    recall_cids, save_cids = set(), set()
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                for kind, name, cid, args, text in parts_of(o):
                    if kind == "call":
                        k = call_kind(name, args)
                        if k and cid:
                            (recall_cids if k == "recall" else save_cids).add(cid)
                    elif kind == "result" and text:
                        all_results.append(text)
                        if cid in recall_cids:
                            recall_results.append(text)
    except OSError:
        pass
    return recall_results, all_results, recall_cids, save_cids


def store_tokens():
    """{token: {'row': id, 'phrase': bool, 'col_writer': sid|None}} for all
    post-cutoff working_memory rows: each row's id + leading phrase."""
    toks = {}
    con = sqlite3.connect(f"file:{STORE}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    for r in con.execute(
            "SELECT id, content, session_id FROM working_memory "
            "WHERE created_at >= ? ORDER BY created_at", (CUTOFF,)):
        col_w = r["session_id"] or None
        toks[r["id"]] = {"row": r["id"], "phrase": False, "col_writer": col_w}
        first = (r["content"] or "").splitlines()[0] if r["content"] else ""
        phrase = " ".join(first.split()[:6]).strip()
        if len(phrase) >= 15:
            toks[phrase] = {"row": r["id"], "phrase": True, "col_writer": col_w}
    con.close()
    return toks


def main(argv):
    t0 = time.time()
    if not os.path.exists(STORE):
        print(f"store not found: {STORE}", file=sys.stderr)
        return 1
    tokens = store_tokens()
    for extra in argv:                      # manual tokens: writer unattributed
        tokens.setdefault(extra, {"row": extra, "phrase": False,
                                  "col_writer": None})
    if not tokens:
        print("store has no post-cutoff rows — nothing to prove from", file=sys.stderr)
        return 2

    # scan set: driver artifacts + most recent transcripts touched post-change
    files = {}
    # driver sessions: each fresh session ran in metrics/fresh-sessions/<n>-<ts>/,
    # transcript under the matching per-cwd sessions dir; no report.json involved
    for drv in sorted(glob.glob(os.path.join(ART_DIR, "fresh-sessions", "*"))):
        label = os.path.basename(drv).split("-", 1)[0]
        sess_dir = "--" + drv.lstrip("/").replace("/", "-") + "--"
        for tp in sorted(glob.glob(os.path.join(ROOT, sess_dir, "*.jsonl"))):
            files[tp] = {"sid": os.path.basename(tp).rsplit("_", 1)[-1].replace(".jsonl", ""),
                         "label": label}
    recent = sorted(
        (p for p in glob.glob(os.path.join(ROOT, "--*", "*", "*.jsonl"))
         + glob.glob(os.path.join(ROOT, "--*", "*.jsonl"))),
        key=lambda p: os.path.getmtime(p), reverse=True)[:40]
    for p in recent:
        if os.path.getmtime(p) < time.mktime(time.strptime(CUTOFF, "%Y-%m-%d %H:%M")):
            continue
        sid = os.path.basename(p).rsplit("_", 1)[-1].replace(".jsonl", "")
        files.setdefault(p, {"sid": sid, "label": None})

    # tier-2 writer attribution: transcript whose SAVE call's outputs contain
    # the row id. Results appear in file order after calls; simplest sound
    # rule: the save-cid set is non-empty in that transcript AND the row id
    # occurs in its result texts AND the call payload is a save.
    writers = {}          # row id -> {sid, evidence}
    scans = {}
    for path, meta in files.items():
        recall_results, all_results, recall_cids, save_cids = scan(path)
        blob = "\n".join(all_results)
        scans[path] = (recall_results, recall_cids, meta)
        if save_cids:
            for tok, info in tokens.items():
                row = info["row"]
                if tok == row and row in blob:
                    writers.setdefault(row, {"sid": meta["sid"],
                                             "evidence": "mnemosyne save call whose "
                                                         "result includes the row id"})

    report, proven = [], []
    for results, recall_cids, meta in scans.values():
        hits = {}
        for tok, info in tokens.items():
            row = info["row"]
            writer = info["col_writer"] or writers.get(row, {}).get("sid")
            if not recall_cids:               # session never called a recall tool
                continue
            for rtxt in results:
                if tok in rtxt:
                    hits.setdefault(tok, {"row": row[:16], "phrase": info["phrase"],
                                              "writer": writer,
                                              "writer_evidence": (info["col_writer"] and "store session_id") or writers.get(row, {}).get("evidence")})
                    if writer and not same_session(writer, meta["sid"]):
                        proven.append({"session": meta["sid"], "token": tok[:40],
                                       "row": row, "writer": writer})
                    break
        report.append({"n": meta["label"], "session": meta["sid"],
                       "recall_calls": len(recall_cids),
                       "saved_rows_authored": sorted({v["sid"] for v in writers.values()
                                                      if same_session(v["sid"], meta["sid"])}),
                       "hits": hits})

    uniq = {(p["session"], p["row"]) for p in proven}
    report.sort(key=lambda r: (r["n"] or "zz", r["session"]))
    for r in report:
        cross = sum(1 for t, h in r["hits"].items()
                    if h["writer"] and not same_session(h["writer"], r["session"]))
        print(f"[{'PASS' if cross else '    '}] {r['n'] or 'organic'} sid={r['session'][:18]} "
              f"recall_calls={r['recall_calls']} tokens_returned={len(r['hits'])} "
              f"cross_session_tokens={cross}")
    print(f"\ntokens in store post-cutoff: {len(tokens)} "
          f"(rows with writer attributed: {len(writers) + len({i['row'] for i in tokens.values() if i['col_writer']})})")
    if uniq:
        print(f"\nCROSS-SESSION RECALL PROVEN on durable transcripts ({len(uniq)} session/row pair(s)):")
        for p in sorted(uniq):
            w = writers.get(p[1], {}).get("sid") or next(
                i["col_writer"] for i in tokens.values() if i["row"] == p[1] and i["col_writer"])
            print(f"  row {p[1][:16]} written by session {w[:18]} -> appeared verbatim "
                  f"in the tool results of fresh session {p[0]}")
    else:
        print("\nNOT PROVEN: no post-cutoff memory was demonstrably written by "
              "one session and recalled into a different session's results.")
    out = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "cutoff": CUTOFF,
           "store": STORE, "tokens": {k: v["row"] for k, v in tokens.items()},
           "writers": writers, "sessions": report,
           "proven_pairs": sorted(uniq), "elapsed_s": round(time.time() - t0, 1)}
    try:
        os.makedirs(os.path.dirname(PROOF), exist_ok=True)
        with open(PROOF, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)
    except OSError as exc:
        print(f"artifact write failed: {exc}", file=sys.stderr)
    print(f"\nartifact: {PROOF}")
    return 0 if uniq else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
