#!/usr/bin/env python3
"""Look up an ASD-STE100 Issue 9 dictionary word."""

from __future__ import annotations

import argparse
import json
from ste_data import (
    SOURCE_ASD,
    ReferencesError,
    VALID_PARTS,
    ensure_references_ready,
    load_dictionary,
    load_software_terms,
    merge_layers,
    report_reference_error,
)


def main() -> int:
    parser = argparse.ArgumentParser(prog="ste_lookup.py")
    parser.add_argument("word")
    parser.add_argument("--part-of-speech", choices=sorted(VALID_PARTS))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        ensure_references_ready()
    except ReferencesError as error:
        report_reference_error(error, args.json)
        return 2
    try:
        software_entries = load_software_terms()
    except (OSError, UnicodeError, ValueError) as error:
        report_reference_error(
            ReferencesError("references_invalid", f"software terminology loading could not complete: {error}"),
            args.json,
        )
        return 2
    dictionary = merge_layers(load_dictionary(), software_entries, ("asd", "software"))
    key = args.word.casefold()
    matches = list(dictionary.by_headword.get(key, []))
    if not matches:
        matches = list(dictionary.approved_forms.get(key, []))
    if not matches:
        matches = list(dictionary.unapproved.get(key, []))
    if args.part_of_speech:
        matches = [entry for entry in matches if entry["part_of_speech"] == args.part_of_speech]
    unique = {
        (entry["display"], entry["part_of_speech"], entry.get("source"), entry.get("standard_page")): entry
        for entry in matches
    }
    matches = list(unique.values())
    if args.json:
        print(json.dumps({"query": args.word, "matches": matches}, ensure_ascii=False, indent=2, sort_keys=True))
    elif not matches:
        print(f"No dictionary or software-terminology entry for {args.word!r}.")
    else:
        for index, entry in enumerate(matches):
            if index:
                print()
            print(f"{entry['display']} ({entry['part_of_speech']}): {entry['status']}")
            print(f"Forms: {', '.join(entry['forms'])}")
            label = "Meaning" if entry["status"] == "approved" else "Alternatives"
            for value in entry["meaning_or_alternatives"]:
                print(f"{label}: {value}")
            for value in entry["ste_examples"]:
                print(f"STE example: {value}")
            for value in entry["non_ste_examples"]:
                print(f"Non-STE example: {value}")
            if entry.get("source") == SOURCE_ASD:
                print(f"Source: Issue 9, PDF page {entry['pdf_page']}, standard page {entry['standard_page']}")
            else:
                print(f"Source: software terminology, observed {entry['observed']} in {', '.join(entry['models'])}")
                print(f"Attestation: {entry['attestation']}")
    return 0 if matches else 1


if __name__ == "__main__":
    raise SystemExit(main())
