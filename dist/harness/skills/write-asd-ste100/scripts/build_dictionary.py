#!/usr/bin/env python3
"""Build dictionary.jsonl from glyph geometry produced by extract_dictionary.py."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import NoReturn

from ste_data import read_jsonl

PARTS = ("art", "adj", "adv", "conj", "n", "prep", "pron", "v")
END_POS = re.compile(r"^(.+?)\s+\((%s)\),?$" % "|".join(PARTS))
ONLY_POS = re.compile(r"^\((%s)\)$" % "|".join(PARTS))
FORM_NOTE = re.compile(r"^(?:No other|forms?\.|Do not use|Use this|For |If )", re.I)

# Extraction geometry not covered by references/source-config.json. That
# config's SHA-256 is recorded in the generated bundle. Promoting these to
# config values would require re-running initialization, so named constants
# keep them documented without that cost.
PAGE_ORDER_Y_OFFSET = 700.0  # inverts y so top-of-page text sorts first within a page
LINE_HEIGHT = 12.0  # vertical gap between two lines of the same wrapped headword
LINE_HEIGHT_TOLERANCE = 0.25
PAGE_WRAP_BOTTOM_Y = 230  # a headword continuation line near the bottom of a page
PAGE_WRAP_TOP_Y = 640  # continues on the next page near its top
PARAGRAPH_GAP_THRESHOLD = 15.5  # vertical gap that separates two paragraphs


def fail(message: str) -> NoReturn:
    raise SystemExit(f"error: {message}")


def load_geometry(path: Path) -> list[dict]:
    try:
        records = list(read_jsonl(path))
    except ValueError as error:
        fail(str(error))
    if not records:
        fail("geometry is empty")
    return records


def page_order(record: dict) -> float:
    return record["physicalPage"] * 1000.0 + (PAGE_ORDER_Y_OFFSET - record["y"])


def soft_join(parts: list[str]) -> str:
    result = ""
    for part in parts:
        if result.endswith("-"):
            result = result[:-1] + part
        elif result:
            result += " " + part
        else:
            result = part
    return re.sub(r"\s+", " ", result).strip()


def find_anchors(records: list[dict]) -> tuple[list[dict], set[int]]:
    column = sorted(
        [(index, record) for index, record in enumerate(records) if record["column"] == 1],
        key=lambda item: page_order(item[1]),
    )
    anchors = []
    consumed: set[int] = set()
    for position, (record_index, record) in enumerate(column):
        text = record["text"]
        match = END_POS.match(text)
        only_match = None if match else ONLY_POS.match(text)
        if not match and not only_match:
            continue

        prefix: list[tuple[int, dict]] = []
        if match:
            display_tail = match.group(1)
            part = match.group(2)
        else:
            display_tail = ""
            part = only_match.group(1)

        previous_position = position - 1
        while previous_position >= 0:
            previous_index, previous = column[previous_position]
            if previous_index in consumed or END_POS.match(previous["text"]) or ONLY_POS.match(previous["text"]):
                break
            same_page_wrap = (
                previous["physicalPage"] == record["physicalPage"]
                and abs(previous["y"] - record["y"] - LINE_HEIGHT * (len(prefix) + 1)) < LINE_HEIGHT_TOLERANCE
            )
            page_wrap = (
                previous["physicalPage"] + 1 == record["physicalPage"]
                and previous["text"].endswith("-")
                and previous["y"] < PAGE_WRAP_BOTTOM_Y
                and record["y"] > PAGE_WRAP_TOP_Y
                and not prefix
            )
            if not (same_page_wrap or page_wrap):
                break
            prefix.insert(0, (previous_index, previous))
            previous_position -= 1
            if not previous["text"].endswith("-") and display_tail and not display_tail.startswith("("):
                break

        pieces = [item[1]["text"] for item in prefix]
        if display_tail:
            pieces.append(display_tail)
        display = soft_join(pieces)
        if not display:
            fail(f"empty headword on physical page {record['physicalPage']}")
        for index, _ in prefix:
            consumed.add(index)
        consumed.add(record_index)

        letters = "".join(character for character in display if character.isalpha())
        if display == "MATT (or MATTE)":
            status = "approved"
        elif letters and letters == letters.upper():
            status = "approved"
        elif letters and letters == letters.lower():
            status = "unapproved"
        else:
            fail(f"mixed-case status ambiguity for {display!r} on physical page {record['physicalPage']}")

        anchors.append(
            {
                "record_index": record_index,
                "order": min([page_order(item[1]) for item in prefix] + [page_order(record)]),
                "physical_page": record["physicalPage"],
                "standard_page": record["standardPage"],
                "display": display,
                "part_of_speech": part,
                "status": status,
            }
        )

    anchors.sort(key=lambda item: item["order"])
    if not anchors:
        fail("no part-of-speech anchors found")
    return anchors, consumed


def paragraphs(lines: list[dict]) -> list[str]:
    if not lines:
        return []
    lines = sorted(lines, key=page_order)
    groups: list[list[str]] = []
    current: list[str] = []
    previous = None
    for line in lines:
        gap = None
        if previous is not None and previous["physicalPage"] == line["physicalPage"]:
            gap = previous["y"] - line["y"]
        if current and (gap is None or gap > PARAGRAPH_GAP_THRESHOLD):
            groups.append(current)
            current = []
        current.append(line["text"])
        previous = line
    if current:
        groups.append(current)
    return [soft_join(group) for group in groups if soft_join(group)]


def clean_form(text: str) -> str | None:
    value = text.strip().strip(",")
    if not value or FORM_NOTE.match(value):
        return None
    if value.startswith("(also ") and value.endswith(")"):
        value = value[6:-1]
    if value.startswith("(") and value.endswith(")"):
        value = value[1:-1]
    values = [part.strip(" ,()") for part in value.split(",")]
    if not all(re.fullmatch(r"[A-Z][A-Z -]*", part or "") for part in values):
        return None
    return "|".join(part for part in values if part)


def build(records: list[dict]) -> list[dict]:
    anchors, consumed = find_anchors(records)
    buckets: list[list[dict]] = [[] for _ in anchors]
    anchor_index = -1
    ordered_records = sorted(enumerate(records), key=lambda item: page_order(item[1]))
    next_anchor = 0
    for record_index, record in ordered_records:
        order = page_order(record)
        while next_anchor < len(anchors) and anchors[next_anchor]["order"] <= order + 0.01:
            anchor_index = next_anchor
            next_anchor += 1
        if record_index in consumed:
            continue
        if anchor_index < 0:
            fail(f"unassigned column text before first anchor: {record['text']!r}")
        buckets[anchor_index].append(record)

    entries = []
    for anchor, bucket in zip(anchors, buckets):
        forms = [anchor["display"]]
        for line in bucket:
            if line["column"] != 1:
                continue
            form = clean_form(line["text"])
            if form:
                forms.extend(form.split("|"))
        if anchor["display"] == "MATT (or MATTE)":
            headword = "matt"
            forms = ["MATT", "MATTE"]
        else:
            headword = re.sub(r"\s*\([^)]*\)\s*", " ", anchor["display"]).strip().casefold()
        unique_forms = []
        seen_forms = set()
        for form in forms:
            normalized = form.strip().strip(",")
            folded = normalized.casefold()
            if normalized and folded not in seen_forms:
                unique_forms.append(normalized)
                seen_forms.add(folded)
        entries.append(
            {
                "headword": headword,
                "display": anchor["display"],
                "status": anchor["status"],
                "part_of_speech": anchor["part_of_speech"],
                "forms": unique_forms,
                "meaning_or_alternatives": paragraphs([line for line in bucket if line["column"] == 2]),
                "ste_examples": paragraphs([line for line in bucket if line["column"] == 3]),
                "non_ste_examples": paragraphs([line for line in bucket if line["column"] == 4]),
                "issue": 9,
                "pdf_page": anchor["physical_page"],
                "standard_page": anchor["standard_page"],
            }
        )
    return entries


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("geometry", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    entries = build(load_geometry(args.geometry))
    with args.output.open("w", encoding="utf-8") as target:
        for entry in entries:
            target.write(json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
    approved = sum(entry["status"] == "approved" for entry in entries)
    unapproved = sum(entry["status"] == "unapproved" for entry in entries)
    print(f"wrote {len(entries)} part-of-speech rows ({approved} approved, {unapproved} unapproved)")


if __name__ == "__main__":
    main()
