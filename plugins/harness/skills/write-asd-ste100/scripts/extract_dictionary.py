#!/usr/bin/env python3
"""Extract per-glyph dictionary geometry from the ASD-STE100 PDF.

Portable, initialization-only replacement for extract_dictionary.swift (Swift +
PDFKit, macOS-only). Reads the same tracked page geometry from source-config.json,
isolates the four dictionary columns, and emits the same GeometryLine JSONL schema
that build_dictionary.py already consumes, so nothing downstream changes.

Requires the pypdfium2 package (initialization-only; runtime lookup and checking
stay standard-library only). pypdfium2's loose char box (FPDFText_GetLooseCharBox)
is the structural analog of PDFKit's PDFSelection.bounds(for:): an advance-width
box, uniform across a visual line. That is what lets glyph_space_threshold and the
y-rounding in build_dictionary.py work unchanged.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path
from typing import NoReturn

PAGE_ANCHOR = re.compile(r"Page 2-1-([A-Z][0-9]+)")


def fail(message: str) -> NoReturn:
    raise SystemExit(f"error: {message}")


def load_pdfium():
    """Import pypdfium2 on demand, with an install hint instead of a traceback.

    Deferred so the rest of this module - the pure geometry and text logic -
    stays importable and unit-testable without the dependency installed.
    Runtime lookup and checking never import this module, so this is the only
    place in the skill that needs pypdfium2 at all.
    """
    try:
        import pypdfium2
    except ImportError as error:
        fail(
            "the 'pypdfium2' package is required for extraction: "
            f"{error}. Install it with: python3 -m pip install pypdfium2"
        )
    return pypdfium2


def load_config(config_path: Path) -> dict:
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read extraction configuration at {config_path}: {error}")
    try:
        extraction = data["extraction"]
        offsets = extraction["column_offsets"]
    except (KeyError, TypeError):
        fail(f"cannot read extraction configuration at {config_path}: incomplete schema")
    if not isinstance(offsets, list) or len(offsets) != 5:
        fail("extraction configuration must contain five column offsets")
    return extraction


def page_anchor(full_text: str, physical_page: int) -> str:
    match = PAGE_ANCHOR.search(full_text)
    if not match:
        fail(f"missing dictionary source-page anchor on physical page {physical_page}")
    return "2-1-" + match.group(1)


# The PDF's dictionary font encodes discretionary line-wrap hyphens (e.g.
# "COUNTERCLOCK-" / "WISE") with a glyph that has no ToUnicode entry.
# PDFKit's font-name fallback resolves it to a literal hyphen-minus;
# pypdfium2 has no equivalent fallback and reports it as this exact
# noncharacter codepoint. Verified as the only "Cn" (unassigned) or "Cf"
# (format) character anywhere in physical pages 149-433 of the pinned PDF.
DISCRETIONARY_HYPHEN_FALLBACK = "￾"


def normalize_char(character: str, physical_page: int) -> str | None:
    """Map one extracted character to what PDFKit would have produced.

    Any other formatting or noncharacter codepoint is unexpected for this
    PDF: fail loudly rather than silently drop or mis-map content that a
    future edition of the source document might introduce.
    """
    if character == "" or character.isspace():
        return None
    if character == DISCRETIONARY_HYPHEN_FALLBACK:
        return "-"
    category = unicodedata.category(character)
    if category in ("Cf", "Cn"):
        fail(
            f"unexpected formatting character {character!r} (category {category}) "
            f"on physical page {physical_page}"
        )
    return character


def assign_column(min_x: float, starts: list[float], tolerance: float) -> int | None:
    for candidate in range(4):
        if starts[candidate] - tolerance <= min_x < starts[candidate + 1] - tolerance:
            return candidate
    return None


# pypdfium2's loose char box is usually uniform across a visual line, mirroring
# PDFKit's line-box selection bounds, but a narrow glyph (observed here for a
# trailing period) can report a min_y up to ~0.4pt off from the rest of the
# line. The smallest true line-to-line gap measured across this document is
# 6pt, so clustering glyphs within this tolerance of a line's topmost glyph
# absorbs that noise without ever merging two distinct lines.
LINE_Y_CLUSTER_TOLERANCE = 1.5


def cluster_column_lines(glyphs: list[tuple[str, float, float, float]]) -> list[list[tuple[str, float, float, float]]]:
    """Group one column's glyphs (character, min_x, max_x, min_y) into visual lines."""
    ordered = sorted(glyphs, key=lambda glyph: (-glyph[3], glyph[1]))
    lines: list[list[tuple[str, float, float, float]]] = []
    reference_y = None
    for glyph in ordered:
        y = glyph[3]
        if lines and abs(y - reference_y) <= LINE_Y_CLUSTER_TOLERANCE:
            lines[-1].append(glyph)
        else:
            lines.append([glyph])
            reference_y = y
    return lines


def line_text(glyphs: list[tuple[str, float, float, float]], space_threshold: float) -> str:
    """Join one visual line's glyphs (already sorted by min_x), inserting spaces at gaps."""
    line = ""
    previous_max_x = None
    for character, min_x, max_x, _min_y in glyphs:
        if previous_max_x is not None and min_x - previous_max_x > space_threshold:
            line += " "
        line += character
        previous_max_x = max(previous_max_x, max_x) if previous_max_x is not None else max_x
    return re.sub(r"\s+", " ", line).strip()


def page_glyph_lines(page, config: dict, physical_page: int) -> list[dict]:
    """One GeometryLine dict per (column, visual-line) group on this physical page."""
    textpage = page.get_textpage()
    char_count = textpage.count_chars()
    full_text = textpage.get_text_range(0, char_count)
    standard_page = page_anchor(full_text, physical_page)

    left = config["even_left_margin"] if physical_page % 2 == 0 else config["odd_left_margin"]
    starts = [left + offset for offset in config["column_offsets"]]
    tolerance = config["column_boundary_tolerance"]
    y_min = config["content_y_min"]
    y_max = config["content_y_max"]
    space_threshold = config["glyph_space_threshold"]

    by_column: dict[int, list[tuple[str, float, float, float]]] = {0: [], 1: [], 2: [], 3: []}
    for index in range(char_count):
        character = normalize_char(textpage.get_text_range(index, 1), physical_page)
        if character is None:
            continue
        box = textpage.get_charbox(index, loose=True)
        if box is None:
            continue
        min_x, min_y, max_x, max_y = box
        width = max_x - min_x
        if min_y < y_min or min_y > y_max or width <= 0:
            continue
        column = assign_column(min_x, starts, tolerance)
        if column is None:
            fail(f"unassigned glyph {character!r} at x={min_x} on physical page {physical_page}")
        by_column[column].append((character, min_x, max_x, min_y))

    records = []
    for column, glyphs in by_column.items():
        for line_glyphs in cluster_column_lines(glyphs):
            line_glyphs.sort(key=lambda glyph: (glyph[1], glyph[2]))
            text = line_text(line_glyphs, space_threshold)
            if not text:
                continue
            records.append(
                {
                    "physicalPage": physical_page,
                    "standardPage": standard_page,
                    "column": column + 1,
                    "x": line_glyphs[0][1],
                    "y": round(line_glyphs[0][3] * 10.0) / 10.0,
                    "text": text,
                }
            )

    records.sort(key=lambda record: (record["column"], -record["y"], record["x"]))
    return records


def extract(pdf_path: Path, output_path: Path, config_path: Path) -> None:
    config = load_config(config_path)
    pdfium = load_pdfium()
    try:
        document = pdfium.PdfDocument(str(pdf_path))
    except pdfium.PdfiumError as error:
        fail(f"cannot open {pdf_path}: {error}")
    page_count = len(document)
    if page_count != config["page_count"]:
        fail(f"expected {config['page_count']} physical pages, got {page_count}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(output_path.name + ".tmp")
    with temp_path.open("w", encoding="utf-8") as target:
        for physical_page in range(config["physical_page_start"], config["physical_page_end"] + 1):
            try:
                page = document[physical_page - 1]
            except IndexError:
                fail(f"missing physical page {physical_page}")
            for record in page_glyph_lines(page, config, physical_page):
                target.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
                target.write("\n")
    temp_path.replace(output_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="extract_dictionary.py",
        usage="%(prog)s PDF OUTPUT_GEOMETRY_JSONL SOURCE_CONFIG_JSON",
    )
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("config", type=Path)
    args = parser.parse_args(argv)
    extract(args.pdf, args.output, args.config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
