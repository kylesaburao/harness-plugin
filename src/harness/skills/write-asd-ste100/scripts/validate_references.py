#!/usr/bin/env python3
"""Report installation readiness for generated ASD-STE100 references."""

from __future__ import annotations

import json
import sys

from ste_cli import InvocationError, Parser, report_invocation_error
from ste_data import ReferencesError, ensure_references_ready, report_reference_error


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = Parser(prog="validate_references.py")
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--preflight", action="store_true",
        help="Validate references; validation is the preflight, so this does the same work as a normal run",
    )
    try:
        args = parser.parse_args(argv)
    except InvocationError as error:
        report_invocation_error(error, "--json" in argv)
        return 2
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
