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
    REQUIRED_FILES,
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


class InitializationInputError(Exception):
    """An initialization request that did not start work."""

    def __init__(self, code: str, condition: str, remedy: str):
        super().__init__(condition)
        self.code = code
        self.condition = condition
        self.remedy = remedy


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise InitializationInputError(
            "invalid_arguments",
            message,
            f"{initialization_command()} --help",
        )


def initialization_command() -> str:
    return f"python3 {(SCRIPT_ROOT / 'initialize_references.py').resolve()}"


def load_initialization_config(config_path: Path) -> dict:
    try:
        return load_source_config(config_path)
    except ReferencesError as error:
        raise InitializationInputError(
            "source_config_invalid",
            error.condition,
            initialization_command(),
        ) from error


def download_pdf(url: str, output: Path) -> None:
    print(f"Downloading {url}", file=sys.stderr)
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
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n", file=sys.stderr)


def check_extractor_dependency() -> None:
    try:
        import pypdfium2  # noqa: F401
    except ImportError as error:
        raise InitializationError(
            "the 'pypdfium2' package is required for extraction and is not installed "
            f"({error}). Install it with: python3 -m pip install pypdfium2"
        ) from error


def prepare_source(
    pdf: Path | None,
    import_from: Path | None,
    config_path: Path,
) -> tuple[str, Path | None]:
    if import_from is not None:
        return "import", validate_import_source(import_from, config_path)
    try:
        check_extractor_dependency()
    except InitializationError as error:
        raise InitializationInputError(
            "dependency_missing",
            str(error),
            "python3 -m pip install pypdfium2",
        ) from error
    if pdf is None:
        return "download", None
    source_pdf = pdf.expanduser().resolve()
    if not source_pdf.is_file():
        raise InitializationInputError(
            "source_pdf_missing",
            f"local source PDF does not exist: {source_pdf}",
            initialization_command(),
        )
    config = load_source_config(config_path)
    try:
        verify_pdf_hash(source_pdf, config["source"]["pdf_sha256"])
    except InitializationError as error:
        raise InitializationInputError(
            "source_pdf_invalid",
            str(error),
            initialization_command(),
        ) from error
    return "pdf", source_pdf


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


def validate_import_source(source: Path, config_path: Path) -> Path:
    source = source.expanduser().resolve()
    try:
        validate_bundle(source, config_path)
    except (OSError, ReferencesError) as error:
        condition = error.condition if isinstance(error, ReferencesError) else str(error)
        raise InitializationInputError(
            "import_invalid",
            f"legacy generated bundle is not valid for the current source configuration: {condition}",
            initialization_command(),
        ) from error
    return source


def import_bundle(source: Path, generated: Path, config_path: Path) -> dict:
    stage = Path(tempfile.mkdtemp(prefix=".generated-stage-", dir=generated.parent))
    try:
        for name in REQUIRED_FILES:
            shutil.copy2(source / name, stage / name)
        try:
            result = validate_bundle(stage, config_path)
        except ReferencesError as error:
            raise InitializationError(f"staged import validation failed: {error.condition}") from error
        replace_generated(stage, generated)
        return {**result, "generated_data_location": str(generated)}
    except OSError as error:
        raise InitializationError(f"cannot import the validated generated bundle: {error}") from error
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def initialize(
    pdf: Path | None,
    force: bool,
    config_path: Path = SOURCE_CONFIG,
    generated: Path = GENERATED,
    import_from: Path | None = None,
) -> dict:
    config_path = config_path.resolve()
    generated = generated.resolve()
    config = load_initialization_config(config_path)
    if not force:
        try:
            return validate_bundle(generated, config_path)
        except ReferencesError:
            pass
    _, prepared_source = prepare_source(pdf, import_from, config_path)
    if import_from is not None:
        generated.parent.mkdir(parents=True, exist_ok=True)
        return import_bundle(prepared_source, generated, config_path)
    generated.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="write-asd-ste100-") as temporary:
        temporary_path = Path(temporary)
        if pdf is None:
            source_pdf = temporary_path / "ASD-STE100_ISSUE9.pdf"
            download_pdf(config["source"]["url"], source_pdf)
        else:
            source_pdf = prepared_source
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


def preflight(
    pdf: Path | None,
    import_from: Path | None,
    config_path: Path = SOURCE_CONFIG,
    generated: Path = GENERATED,
    force: bool = False,
) -> dict:
    config_path = config_path.resolve()
    generated = generated.resolve()
    config = load_initialization_config(config_path)
    if not force:
        try:
            validate_bundle(generated, config_path)
            return {
                "source_mode": "existing",
                "generated_data_location": str(generated),
                "source": config["source"],
            }
        except ReferencesError:
            pass
    source_mode, _ = prepare_source(pdf, import_from, config_path)
    return {
        "source_mode": source_mode,
        "generated_data_location": str(generated),
        "source": config["source"],
    }


def report_error(code: str, condition: str, remedy: str, json_output: bool) -> None:
    if json_output:
        print(json.dumps({"error": {
            "code": code,
            "condition": condition,
            "remedy": remedy,
        }}, ensure_ascii=False, indent=2, sort_keys=True), file=sys.stderr)
        return
    print(f"ERROR [{code}]: {condition}", file=sys.stderr)
    print(f"Remedy: {remedy}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    json_output = "--json" in argv
    parser = Parser(prog="initialize_references.py")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--pdf", type=Path, metavar="FILE")
    source.add_argument("--import-from", type=Path, metavar="DIRECTORY")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--json", action="store_true")
    try:
        args = parser.parse_args(argv)
        if args.preflight:
            result = preflight(args.pdf, args.import_from, force=args.force)
        else:
            result = initialize(args.pdf, args.force, import_from=args.import_from)
    except InitializationInputError as error:
        report_error(error.code, error.condition, error.remedy, json_output)
        return 2
    except InitializationError as error:
        report_error(
            "preflight_failed" if args.preflight else "initialization_failed",
            str(error),
            initialization_command(),
            json_output,
        )
        return 2 if args.preflight else 1
    except (KeyError, OSError, ReferencesError, TypeError, UnicodeError, ValueError) as error:
        report_error(
            "preflight_failed" if args.preflight else "initialization_failed",
            f"initialization could not complete: {error}",
            initialization_command(),
            json_output,
        )
        return 2 if args.preflight else 1
    if args.preflight:
        if args.json:
            print(json.dumps({"status": "ready", "preflight": True, **result}, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            print(f"READY: initialization preflight passed ({result['source_mode']})")
            print(f"Generated data: {result['generated_data_location']}")
        return 0
    if args.json:
        print(json.dumps({"status": "ready", **result}, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    print(f"READY: {result['generated_data_location']}")
    print(f"Dictionary: {result['dictionary_rows']} rows, SHA-256 {result['dictionary_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
