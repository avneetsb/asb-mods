#!/usr/bin/env python3
"""Fidelity canary for the pi observation/compaction pipeline.

Measures what fraction of structured output survives from emission to the
model turn AFTER the tool call (the late boundary where compaction/observation
corruption lands; early-pipeline compressors are upstream of this metric).

Seed material is synthetic (random hex + structured records). Real secrets are
never written here by design: a store that can be probed with fakes can also
be probed for real leaks — keep it fakes-only.

Usage:
  canary.py seed            # emit a fresh canary batch (stdout), save expected
  canary.py verify          # compare a pasteable/observed transcript against expected
  canary.py --status        # last verdict + survival history
  canary.py forget          # clear expected state (keeps metrics history)

Exit codes: seed 0 | verify all-ok 0, partial 1, fail 2 | status/forget 0
"""
import hashlib
import json
import os
import re
import secrets
import sys
import time

STATE_DIR = os.path.expanduser("~/.agents/canary")
EXPECTED = os.path.join(STATE_DIR, "expected.json")
METRICS = os.path.join(STATE_DIR, "metrics.jsonl")
WORDS = ["ember", "quartz", "harbor", "ledger", "signal", "meadow",
         "cobalt", "fathom", "tundra", "wisp"]


def cmd_seed():
    os.makedirs(STATE_DIR, exist_ok=True)
    batch = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "seq": secrets.randbelow(900000) + 100000,
        "fields": {},
    }
    t0 = secrets.token_hex(3)
    t1 = secrets.token_hex(3)
    batch["fields"]["alpha_hex"] = t0 + "-" + t1
    batch["fields"]["beta_int"] = secrets.randbelow(9000000) + 1000000
    batch["fields"]["gamma_word"] = WORDS[secrets.randbelow(len(WORDS))]
    batch["fields"]["delta_path"] = "/srv/canary/%06d/%s.conf" % (
        batch["seq"], secrets.token_hex(2))
    batch["sha256"] = hashlib.sha256(
        json.dumps(batch["fields"], sort_keys=True).encode()).hexdigest()
    with open(EXPECTED, "w") as f:
        json.dump(batch, f, indent=2)

    # Emitted payload — this is the text whose survival we measure.
    print("CANARY-SEED seq=%s" % batch["seq"])
    print("alpha_hex: %s" % batch["fields"]["alpha_hex"])
    print("beta_int: %s" % batch["fields"]["beta_int"])
    print("gamma_word: %s" % batch["fields"]["gamma_word"])
    print("delta_path: %s" % batch["fields"]["delta_path"])
    print("sha256: %s" % batch["sha256"])
    return 0


def _grade(expected, observed):
    """present | mutated | missing for one expected value."""
    res = {}
    for k, v in expected["fields"].items():
        sv = str(v)
        if re.search(r"%s\s*:?\s*%s" % (re.escape(k), re.escape(sv)), observed):
            res[k] = "present"
        elif sv in observed or k in observed:
            res[k] = "mutated"
        else:
            res[k] = "missing"
    return res


def cmd_verify(observed_text=""):
    if not os.path.exists(EXPECTED):
        print("no expected canary — run: canary.py seed")
        return 2
    with open(EXPECTED) as f:
        expected = json.load(f)
    if not observed_text:
        print("paste the transcript/observation region to verify as argument:")
        print("  canary.py verify \"<text>\"")
        print("(expected values remain in %s)" % EXPECTED)
        return 2
    grades = _grade(expected, observed_text)
    ok = sum(1 for g in grades.values() if g == "present")
    total = len(grades)
    verdict = ("OK" if ok == total else
               "PARTIAL" if any(g == "present" for g in grades.values()) else "FAIL")
    rec = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "seq": expected["seq"],
        "verdict": verdict,
        "survival": round(ok / total, 3),
        "fields": grades,
    }
    with open(METRICS, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print("VERIFY seq=%s -> %s (%d/%d)" % (expected["seq"], verdict, ok, total))
    for k, g in grades.items():
        if g != "present":
            print("  %s: %s (expected %s)" % (k, g, expected["fields"][k]))
    return 0 if verdict == "OK" else (1 if verdict == "PARTIAL" else 2)


def cmd_status():
    history = []
    if os.path.exists(METRICS):
        with open(METRICS) as f:
            history = [json.loads(l) for l in f if l.strip()]
    print("expected: %s" % ("seq %s (%s)" % (json.load(open(EXPECTED))["seq"],
                                             json.load(open(EXPECTED))["ts"])
                            if os.path.exists(EXPECTED) else "none"))
    print("verifications: %d" % len(history))
    for rec in history[-5:]:
        print("  %s seq=%s %s survival=%.2f" % (rec["ts"], rec["seq"],
                                                 rec["verdict"], rec["survival"]))
    if history:
        avg = sum(r["survival"] for r in history) / len(history)
        print("last round-trip survival: %.0f%% | mean %.0f%%"
              % (history[-1]["survival"] * 100, avg * 100))
    return 0


def cmd_forget():
    if os.path.exists(EXPECTED):
        os.remove(EXPECTED)
        print("expected canary cleared (metrics history kept)")
    else:
        print("nothing to clear")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "--status":
        sys.exit(cmd_status())
    if args[0] == "seed":
        sys.exit(cmd_seed())
    if args[0] == "verify":
        rest = " ".join(args[1:])
        if rest.startswith("@"):  # @path: read observed text from file
            fp = os.path.expanduser(rest[1:])
            try:
                with open(fp) as f:
                    rest = f.read()
            except OSError as e:
                print("cannot read %s: %s" % (fp, e))
                sys.exit(2)
        sys.exit(cmd_verify(rest))
    if args[0] == "forget":
        sys.exit(cmd_forget())
    print(__doc__)
    sys.exit(2)
