#!/usr/bin/env python3
"""Report installation readiness for generated ASD-STE100 references."""

from __future__ import annotations

from ste_data import run_reference_readiness_entry_point


def print_plain(result: dict) -> None:
    print(f"READY: {result['generated_data_location']}")
    print(
        f"Dictionary: {result['dictionary_rows']} rows, "
        f"SHA-256 {result['dictionary_sha256']}"
    )


def main() -> int:
    return run_reference_readiness_entry_point("validate_references.py", "ready", print_plain)


if __name__ == "__main__":
    raise SystemExit(main())
