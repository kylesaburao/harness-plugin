#!/usr/bin/env python3
"""Validate the generated ASD-STE100 Issue 9 dictionary bundle."""

from __future__ import annotations

import argparse
import json

from ste_data import ReferencesError, ensure_references_ready, report_reference_error


def main() -> int:
    parser = argparse.ArgumentParser(prog="validate_dictionary.py")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = ensure_references_ready()
    except ReferencesError as error:
        report_reference_error(error, args.json)
        return 2
    if args.json:
        print(json.dumps({"status": "valid", **result}, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"PASS: {result['dictionary_rows']} dictionary rows; SHA-256 {result['dictionary_sha256']}")
        print("PASS: generated manifest, source identity, hashes, schema, and row reconciliation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
