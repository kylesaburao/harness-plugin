#!/usr/bin/env python3
"""Report installation readiness for generated ASD-STE100 references."""

from __future__ import annotations

import argparse
import json

from ste_data import ReferencesError, ensure_references_ready, report_reference_error


def main() -> int:
    parser = argparse.ArgumentParser(prog="validate_references.py")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = ensure_references_ready()
    except ReferencesError as error:
        report_reference_error(error, args.json)
        return 2
    if args.json:
        print(json.dumps({"status": "ready", **result}, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"READY: {result['generated_data_location']}")
        print(f"Dictionary: {result['dictionary_rows']} rows, SHA-256 {result['dictionary_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
