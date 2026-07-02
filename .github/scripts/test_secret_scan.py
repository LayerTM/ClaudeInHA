#!/usr/bin/env python3
"""Self-test for secret_scan.scan_text — keeps the scanner from silently rotting.

Run: python .github/scripts/test_secret_scan.py   (exit 0 = pass, 1 = fail)
No test framework required. Synthetic vectors only — no real secrets.
"""

from __future__ import annotations

import sys

from secret_scan import scan_text

# Each must be DETECTED (at least one hit).
SHOULD_FLAG = [
    "ANTHROPIC_API_KEY=sk-ant-api03-abcDEF123456_7890ghijkl",
    "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwxyz012345",
    "aws = AKIAZ2XQ4NP7RSTUV3WK",  # AKIA + 16 upper/digit, no placeholder word
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    'auth: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcd1234"',
    "X-API-Key: 0123456789abcdefABCDEF",
    'password: "hunter2xyz"',
    "cwd = /Users/someone/project",
    "contact me at johndoe@gmail.com",
    "router at 192.168.1.20",
    "db host 10.0.0.56",
]

# Each must be IGNORED (no hits) — placeholders, vars, sanitized docs.
SHOULD_PASS = [
    'api_key: "password"',            # HA schema type, not a hardcoded password
    "export HA_TOKEN=\"${ha_token}\"",  # shell variable
    "Authorization: Bearer $SUPERVISOR_TOKEN",  # env var reference
    "e.g. sk-ant-... (paste your key here)",     # placeholder
    "GITHUB_TOKEN=your-token-here",              # placeholder
    "Example IP like 192.168.x.x in docs",       # 'example' allow + no real octet run
    "email: you@example.com",                     # not gmail
    "SUPERVISOR_TOKEN environment variable",      # no TOKEN= literal
    "aws docs key AKIAIOSFODNN7EXAMPLE",          # canonical AWS example → allowed
]


def run() -> int:
    failures = []
    for s in SHOULD_FLAG:
        if not scan_text(s):
            failures.append(f"MISSED (should flag): {s!r}")
    for s in SHOULD_PASS:
        hits = scan_text(s)
        if hits:
            failures.append(f"FALSE POSITIVE: {s!r} -> {hits}")
    if failures:
        print("test_secret_scan: FAIL")
        for f in failures:
            print("  " + f)
        return 1
    print(f"test_secret_scan: pass ({len(SHOULD_FLAG)} flagged, {len(SHOULD_PASS)} clean)")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
