#!/usr/bin/env python3
"""Validate the generated ASD-STE100 Issue 9 dictionary bundle."""

from __future__ import annotations

from ste_data import run_reference_readiness_entry_point


def print_plain(result: dict) -> None:
    print(
        f"PASS: {result['dictionary_rows']} dictionary rows; "
        f"SHA-256 {result['dictionary_sha256']}"
    )
    print("PASS: generated manifest, source identity, hashes, schema, and row reconciliation")


def main() -> int:
    return run_reference_readiness_entry_point("validate_dictionary.py", "valid", print_plain)


if __name__ == "__main__":
    raise SystemExit(main())
