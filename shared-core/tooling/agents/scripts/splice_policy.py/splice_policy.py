#!/usr/bin/env python3
"""Fidelity-policy gate for AGENTS.md.

--check (default action when no args): validate policy_spec.json and
confirm AGENTS.md still contains the spliced policy needles. Exit 0 =
healthy; exit 1 = drift/spec problems (wrapper should skip splicing).

This tool intentionally does NOT rewrite AGENTS.md on this machine:
the policy sections are already durably present, and rewriting them is
only safe from a session whose transport is not lossy. If AGENTS.md is
genuinely missing sections, this check tells you so explicitly.
"""
import json
import os
import sys

HOME = os.path.expanduser("~")
SPEC = os.path.join(HOME, ".agents", "canary", "policy_spec.json")
AG = os.path.join(HOME, ".pi", "agent", "AGENTS.md")
NEEDLES = [
    "Exact-value provenance",
    "Authoritative",
    "/opt/homebrew/bin/rtk",
    "pi-vcc",
]


def check(name, ok):
    print(("PASS" if ok else "FAIL"), name)
    return ok


def main():
    ok = True
    try:
        with open(SPEC, encoding="utf-8") as fh:
            spec = json.load(fh)
        ok &= check("spec-json", True)
        ok &= check("spec-rtk", bool(spec.get("rtk")))
        ok &= check("spec-exact", len(spec.get("exact", [])) >= 4)
        ok &= check("spec-auth", len(spec.get("auth", [])) >= 2)
        ok &= check("spec-last-migration", str(spec.get("last", "")).startswith(
            "If compaction just occurred"
        ))
    except (OSError, ValueError) as exc:
        print("FAIL spec-unreadable:", exc)
        sys.exit(1)
    try:
        with open(AG, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        print("FAIL agents-unreadable:", exc)
        sys.exit(1)
    for needle in NEEDLES:
        ok &= check("agents:" + needle, needle in text)
    print("RESULT", "OK" if ok else "DRIFT")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
