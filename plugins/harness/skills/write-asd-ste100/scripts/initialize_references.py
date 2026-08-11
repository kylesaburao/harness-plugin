#!/usr/bin/env python3
"""Build and install the local ASD-STE100 generated reference bundle."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from collections import Counter
from pathlib import Path

from ste_data import (
    GENERATED,
    SOURCE_CONFIG,
    ReferencesError,
    load_source_config,
    read_jsonl,
    sha256_file,
    validate_bundle,
)

SCRIPT_ROOT = Path(__file__).resolve().parent


class InitializationError(Exception):
    """An expected initialization failure without a traceback."""


def download_pdf(url: str, output: Path) -> None:
    print(f"Downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "write-asd-ste100-reference-initializer/1"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, output.open("wb") as target:
            shutil.copyfileobj(response, target)
    except (OSError, urllib.error.URLError) as error:
        raise InitializationError(f"download failed for {url}: {error}") from error


def verify_pdf_hash(path: Path, expected: str) -> None:
    try:
        actual = sha256_file(path)
    except OSError as error:
        raise InitializationError(f"cannot read source PDF {path}: {error}") from error
    if actual != expected:
        raise InitializationError(f"source PDF SHA-256 is {actual}, expected {expected}")


def run_command(command: list[str], phase: str) -> None:
    try:
        result = subprocess.run(command, text=True, capture_output=True, check=False)
    except OSError as error:
        raise InitializationError(f"{phase} could not start: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit status {result.returncode}"
        raise InitializationError(f"{phase} failed: {detail}")
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")


def check_extractor_dependency() -> None:
    try:
        import pypdfium2  # noqa: F401
    except ImportError as error:
        raise InitializationError(
            "the 'pypdfium2' package is required for extraction and is not installed "
            f"({error}). Install it with: python3 -m pip install pypdfium2"
        ) from error


def run_extractor(pdf: Path, geometry: Path, config_path: Path) -> None:
    check_extractor_dependency()
    run_command(
        [sys.executable, str(SCRIPT_ROOT / "extract_dictionary.py"), str(pdf), str(geometry), str(config_path)],
        "PDF extraction",
    )


def run_builder(geometry: Path, dictionary: Path) -> None:
    run_command(
        [sys.executable, str(SCRIPT_ROOT / "build_dictionary.py"), str(geometry), str(dictionary)],
        "dictionary build",
    )


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_bundle_metadata(stage: Path, config: dict, config_path: Path) -> None:
    dictionary_path = stage / "dictionary.jsonl"
    try:
        entries = list(read_jsonl(dictionary_path))
    except (OSError, UnicodeError, ValueError) as error:
        raise InitializationError(f"generated dictionary is malformed: {error}") from error
    counts = Counter(entry.get("status") for entry in entries)
    expected = config["dictionary"]
    digest = sha256_file(dictionary_path)
    actual_counts = (len(entries), counts["approved"], counts["unapproved"])
    expected_counts = (
        expected["part_of_speech_rows"], expected["approved_rows"], expected["unapproved_rows"]
    )
    if digest != expected["sha256"]:
        raise InitializationError(f"generated dictionary SHA-256 is {digest}, expected {expected['sha256']}")
    if actual_counts != expected_counts:
        raise InitializationError(f"generated dictionary row counts are {actual_counts}, expected {expected_counts}")
    config_digest = sha256_file(config_path)
    validation = {
        "schema_version": 1,
        "source": config["source"],
        "source_config_sha256": config_digest,
        "dictionary_sha256": digest,
        "part_of_speech_rows": expected["part_of_speech_rows"],
        "approved_rows": expected["approved_rows"],
        "unapproved_rows": expected["unapproved_rows"],
        "declared_approved_words": expected["declared_approved_words"],
        "declared_unapproved_words": expected["declared_unapproved_words"],
        "reconciliation": expected["reconciliation"],
        "known_source_cases": expected["known_source_cases"],
    }
    validation_path = stage / "dictionary-validation.json"
    write_json(validation_path, validation)
    manifest = {
        "schema_version": 1,
        "source": config["source"],
        "source_config_sha256": config_digest,
        "files": {
            path.name: {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
            for path in (dictionary_path, validation_path)
        },
    }
    write_json(stage / "manifest.json", manifest)


def replace_generated(stage: Path, generated: Path) -> None:
    backup = generated.parent / f".generated-backup-{uuid.uuid4().hex}"
    moved_existing = False
    try:
        if generated.exists():
            os.replace(generated, backup)
            moved_existing = True
        os.replace(stage, generated)
    except OSError as error:
        if moved_existing and backup.exists() and not generated.exists():
            os.replace(backup, generated)
        raise InitializationError(f"cannot install the validated generated bundle: {error}") from error
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)


def initialize(
    pdf: Path | None,
    force: bool,
    config_path: Path = SOURCE_CONFIG,
    generated: Path = GENERATED,
) -> dict:
    config_path = config_path.resolve()
    generated = generated.resolve()
    try:
        config = load_source_config(config_path)
    except ReferencesError as error:
        raise InitializationError(error.condition) from error
    if not force:
        try:
            return validate_bundle(generated, config_path)
        except ReferencesError:
            pass
    generated.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="write-asd-ste100-") as temporary:
        temporary_path = Path(temporary)
        if pdf is None:
            source_pdf = temporary_path / "ASD-STE100_ISSUE9.pdf"
            download_pdf(config["source"]["url"], source_pdf)
        else:
            source_pdf = pdf.expanduser().resolve()
            if not source_pdf.is_file():
                raise InitializationError(f"local source PDF does not exist: {source_pdf}")
        verify_pdf_hash(source_pdf, config["source"]["pdf_sha256"])
        stage = Path(tempfile.mkdtemp(prefix=".generated-stage-", dir=generated.parent))
        try:
            geometry = temporary_path / "dictionary-geometry.jsonl"
            run_extractor(source_pdf, geometry, config_path)
            run_builder(geometry, stage / "dictionary.jsonl")
            write_bundle_metadata(stage, config, config_path)
            try:
                result = validate_bundle(stage, config_path)
            except ReferencesError as error:
                raise InitializationError(f"staged bundle validation failed: {error.condition}") from error
            replace_generated(stage, generated)
            return {**result, "generated_data_location": str(generated)}
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="initialize_references.py")
    parser.add_argument("--pdf", type=Path, metavar="FILE")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = initialize(args.pdf, args.force)
    except InitializationError as error:
        print(f"ERROR [initialization_failed]: {error}", file=sys.stderr)
        return 1
    except (KeyError, OSError, ReferencesError, TypeError, UnicodeError, ValueError) as error:
        print(f"ERROR [initialization_failed]: initialization could not complete: {error}", file=sys.stderr)
        return 1
    print(f"READY: {result['generated_data_location']}")
    print(f"Dictionary: {result['dictionary_rows']} rows, SHA-256 {result['dictionary_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
