#!/usr/bin/env python3
"""Load and validate local ASD-STE100 reference data."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, NoReturn

SKILL_ROOT = Path(__file__).resolve().parent.parent
SOURCE_CONFIG = SKILL_ROOT / "references" / "source-config.json"
SOFTWARE_TERMS = SKILL_ROOT / "references" / "software-terminology.jsonl"
VALID_PARTS = {"art", "adj", "adv", "conj", "n", "prep", "pron", "v"}
REQUIRED_FILES = ("dictionary.jsonl", "dictionary-validation.json", "manifest.json")
REQUIRED_ENTRY_FIELDS = {
    "headword", "display", "status", "part_of_speech", "forms",
    "meaning_or_alternatives", "ste_examples", "non_ste_examples",
    "issue", "pdf_page", "standard_page",
}
REQUIRED_SOFTWARE_ENTRY_FIELDS = {
    "term", "status", "part_of_speech", "flagged_sense", "alternatives",
    "rationale", "observed", "models", "attestation",
}
# Stable strings stamped onto every loaded dictionary entry as "source", identifying
# which vocabulary layer produced it. These appear in every finding and lookup match
# indefinitely. Do not rename them without a coordinated documentation update.
SOURCE_ASD = "asd_ste_terms"
SOURCE_SOFTWARE = "software_terms"
SOURCE_PROJECT = "project_terms"
LAYERS = ("asd", "software", "project")


@dataclass(frozen=True)
class ReferencesError(Exception):
    """A deterministic generated-reference readiness failure."""

    code: str
    condition: str

    def __str__(self) -> str:
        return self.condition


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def generated_bundle_path(config_path: Path = SOURCE_CONFIG, home: Path | None = None) -> Path:
    """Return the user-level bundle selected by the tracked source configuration."""
    user_home = Path.home() if home is None else home
    try:
        config_digest = sha256_file(config_path)
    except OSError:
        # Keep imports safe. The normal readiness path validates the tracked
        # configuration and reports its precise error before it uses this path.
        config_digest = "unresolved-source-config"
    return (
        user_home
        / ".harness-plugin"
        / "write-asd-ste100"
        / "bundles"
        / config_digest
    )


GENERATED = generated_bundle_path()
DICTIONARY = GENERATED / "dictionary.jsonl"
VALIDATION = GENERATED / "dictionary-validation.json"
MANIFEST = GENERATED / "manifest.json"


def _invalid(condition: str) -> NoReturn:
    raise ReferencesError("references_invalid", condition)


def _load_json(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        _invalid(f"{label} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _invalid(f"{label} must contain one JSON object")
    return value


def load_source_config(path: Path = SOURCE_CONFIG) -> dict:
    """Load the tracked source configuration.

    This is a hand-edited, git-tracked file, so validation is light: the keys the
    runtime and the extractor read must exist, and the two SHA-256 fields must be
    well formed. `extract_dictionary.load_config` re-checks page geometry before it
    is used, and `_validate_dictionary` re-checks row counts against the real
    dictionary, so this does not duplicate either.
    """
    if not path.is_file():
        _invalid(f"tracked source configuration is missing: {path.resolve()}")
    config = _load_json(path, "tracked source configuration")
    try:
        source = config["source"]
        dictionary = config["dictionary"]
        digests = (("source.pdf_sha256", source["pdf_sha256"]), ("dictionary.sha256", dictionary["sha256"]))
        _ = (
            config["schema_version"], source["title"], source["issue"], source["issue_date"], source["url"],
            config["extraction"], dictionary["reconciliation"],
            dictionary["required_source_anchors"], dictionary["known_source_cases"],
            dictionary["part_of_speech_rows"], dictionary["approved_rows"],
            dictionary["unapproved_rows"],
        )
    except (KeyError, TypeError) as error:
        _invalid(f"tracked source configuration has an incomplete schema: {error}")
    for label, value in digests:
        if not (isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)):
            _invalid(f"tracked source configuration has an invalid {label}")
    return config


def read_jsonl(path: Path):
    try:
        source = path.open(encoding="utf-8")
    except OSError as error:
        raise ValueError(f"{path}: {error}") from error
    with source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: {error}") from error
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: each row must be one JSON object")
            yield value


def _validate_dictionary(path: Path, validation: dict, config: dict) -> tuple[int, str]:
    digest = sha256_file(path)
    expected = config["dictionary"]
    if digest != expected["sha256"]:
        _invalid(f"dictionary SHA-256 is {digest}, expected {expected['sha256']}")
    if validation.get("dictionary_sha256") != digest:
        _invalid("dictionary validation metadata has the wrong dictionary SHA-256")
    try:
        entries = list(read_jsonl(path))
    except (OSError, UnicodeError, ValueError) as error:
        _invalid(f"dictionary JSONL is malformed: {error}")
    counts = Counter(entry.get("status") for entry in entries)
    actual = (len(entries), counts["approved"], counts["unapproved"])
    configured = (
        expected["part_of_speech_rows"], expected["approved_rows"], expected["unapproved_rows"]
    )
    metadata = (
        validation.get("part_of_speech_rows"),
        validation.get("approved_rows"),
        validation.get("unapproved_rows"),
    )
    if actual != configured:
        _invalid(f"dictionary row counts are {actual}, expected {configured}")
    if metadata != configured:
        _invalid(f"dictionary validation row counts are {metadata}, expected {configured}")
    seen_sources = set()
    page_start = config["extraction"]["physical_page_start"]
    page_end = config["extraction"]["physical_page_end"]
    for number, entry in enumerate(entries, 1):
        missing = REQUIRED_ENTRY_FIELDS - entry.keys()
        if missing:
            _invalid(f"dictionary row {number} is missing fields: {sorted(missing)}")
        if entry["status"] not in {"approved", "unapproved"}:
            _invalid(f"dictionary row {number} has an invalid status")
        if entry["part_of_speech"] not in VALID_PARTS:
            _invalid(f"dictionary row {number} has an invalid part of speech")
        if entry["issue"] != config["source"]["issue"]:
            _invalid(f"dictionary row {number} has the wrong issue identity")
        if not isinstance(entry["pdf_page"], int) or not page_start <= entry["pdf_page"] <= page_end:
            _invalid(f"dictionary row {number} has an invalid PDF page")
        if not isinstance(entry["standard_page"], str) or not re.fullmatch(
            r"2-1-[A-Z][0-9]+", entry["standard_page"]
        ):
            _invalid(f"dictionary row {number} has an invalid standard page")
        for field in ("forms", "meaning_or_alternatives", "ste_examples", "non_ste_examples"):
            if not isinstance(entry[field], list) or not all(isinstance(item, str) for item in entry[field]):
                _invalid(f"dictionary row {number} has an invalid {field} value")
        if not entry["forms"] or not entry["meaning_or_alternatives"] or not entry["ste_examples"]:
            _invalid(f"dictionary row {number} has incomplete content")
        seen_sources.add(entry["standard_page"])
    for anchor in expected["required_source_anchors"]:
        if anchor not in seen_sources:
            _invalid(f"dictionary is missing required source anchor {anchor}")
    approved_extra = expected["approved_rows"] - expected["declared_approved_words"]
    unapproved_extra = expected["unapproved_rows"] - expected["declared_unapproved_words"]
    reconciliation = expected["reconciliation"]
    if approved_extra != len(reconciliation["approved_multi_word_rows_not_in_word_count"]):
        _invalid("approved row-count reconciliation is incomplete")
    if unapproved_extra != len(reconciliation["unapproved_multi_word_rows_not_in_word_count"]):
        _invalid("unapproved row-count reconciliation is incomplete")
    return len(entries), digest


def validate_bundle(
    generated: Path = GENERATED,
    config_path: Path = SOURCE_CONFIG,
) -> dict:
    """Validate one complete generated bundle and return its identity."""
    generated = generated.resolve()
    config = load_source_config(config_path)
    if not generated.is_dir():
        raise ReferencesError("references_missing", f"generated directory does not exist: {generated}")
    for name in REQUIRED_FILES:
        path = generated / name
        if not path.is_file():
            raise ReferencesError("references_missing", f"required generated file is missing: {path}")
    validation = _load_json(generated / "dictionary-validation.json", "dictionary validation metadata")
    manifest = _load_json(generated / "manifest.json", "generated manifest")
    config_digest = sha256_file(config_path)
    expected_source = config["source"]
    for label, document in (("dictionary validation metadata", validation), ("generated manifest", manifest)):
        if document.get("schema_version") != 1:
            _invalid(f"{label} has an unsupported schema version")
        if document.get("source") != expected_source:
            _invalid(f"{label} has the wrong source identity")
        if document.get("source_config_sha256") != config_digest:
            _invalid(f"{label} is stale for the tracked source configuration")
    files = manifest.get("files")
    if not isinstance(files, dict):
        _invalid("generated manifest has an incomplete files object")
    for name in ("dictionary.jsonl", "dictionary-validation.json"):
        record = files.get(name)
        path = generated / name
        if not isinstance(record, dict) or set(record) != {"bytes", "sha256"}:
            _invalid(f"generated manifest has an incomplete record for {name}")
        actual_bytes = path.stat().st_size
        if record["bytes"] != actual_bytes:
            _invalid(f"generated manifest byte count for {name} is {record['bytes']}, actual byte count is {actual_bytes}")
        actual_digest = sha256_file(path)
        if record["sha256"] != actual_digest:
            _invalid(f"generated manifest SHA-256 for {name} is {record['sha256']}, actual SHA-256 is {actual_digest}")
    rows, dictionary_digest = _validate_dictionary(generated / "dictionary.jsonl", validation, config)
    return {
        "generated_data_location": str(generated),
        "dictionary_rows": rows,
        "dictionary_sha256": dictionary_digest,
        "source": expected_source,
    }


def ensure_references_ready() -> dict:
    """Fail deterministically unless the installed generated bundle is valid."""
    try:
        return validate_bundle()
    except ReferencesError:
        raise
    except (KeyError, OSError, TypeError, UnicodeError, ValueError) as error:
        raise ReferencesError(
            "references_invalid",
            f"reference validation could not complete: {error}",
        ) from error


def report_reference_error(error: ReferencesError, json_output: bool = False) -> None:
    try:
        source = load_source_config()["source"]
        source_url = source["url"]
        issue_identity = f"{source['title']}, Issue {source['issue']} ({source['issue_date']})"
    except ReferencesError:
        source_url = "unavailable because the tracked source configuration is invalid"
        issue_identity = "ASD-STE100 Issue 9"
    details = {
        "code": error.code,
        "condition": error.condition,
        "generated_data_location": str(GENERATED.resolve()),
        "initialization_command": f"python3 {(SKILL_ROOT / 'scripts' / 'initialize_references.py').resolve()}",
        "requires_online_download": True,
        "source_url": source_url,
        "issue_identity": issue_identity,
    }
    if json_output:
        print(json.dumps({"error": details}, ensure_ascii=False, indent=2, sort_keys=True), file=sys.stderr)
        return
    print(f"ERROR [{details['code']}]: {details['condition']}", file=sys.stderr)
    print(f"Generated data: {details['generated_data_location']}", file=sys.stderr)
    print(f"Initialization command: {details['initialization_command']}", file=sys.stderr)
    print("Online download required: yes", file=sys.stderr)
    print(f"Pinned source: {details['source_url']}", file=sys.stderr)
    print(f"Source identity: {details['issue_identity']}", file=sys.stderr)


def plural(base: str) -> str:
    if base.endswith(("s", "x", "z", "ch", "sh")):
        return base + "es"
    if base.endswith("y") and len(base) > 1 and base[-2] not in "aeiou":
        return base[:-1] + "ies"
    return base + "s"


def inflections(base: str) -> list:
    """Regular English inflections of one single-word headword."""
    forms = [plural(base)]
    if base.endswith("e"):
        forms += [base + "d", base[:-1] + "ing"]
    elif base.endswith("y") and len(base) > 1 and base[-2] not in "aeiou":
        forms += [base[:-1] + "ied", base + "ing"]
    else:
        forms += [base + "ed", base + "ing"]
    return forms


class DictionaryData(NamedTuple):
    entries: list
    by_headword: dict
    approved_forms: dict
    unapproved: dict


def load_dictionary(path: Path = DICTIONARY) -> DictionaryData:
    entries = list(read_jsonl(path))
    by_headword = defaultdict(list)
    approved_forms = defaultdict(list)
    unapproved = defaultdict(list)
    for entry in entries:
        entry["source"] = SOURCE_ASD
        by_headword[entry["headword"].casefold()].append(entry)
        if entry["status"] == "approved":
            for form in entry["forms"]:
                approved_forms[form.casefold()].append(entry)
            if entry["part_of_speech"] == "n":
                base = entry["headword"].casefold()
                if " " not in base:
                    approved_forms[plural(base)].append(entry)
        else:
            base = entry["headword"].casefold()
            unapproved[base].append(entry)
            if " " not in base:
                for form in inflections(base):
                    if form != base:
                        unapproved[form].append(entry)
    return DictionaryData(entries, by_headword, approved_forms, unapproved)


def load_terms(path: Path | None):
    forms = {}
    if path is None:
        return forms
    for entry in read_jsonl(path):
        term = entry.get("term")
        part = entry.get("part_of_speech")
        if not isinstance(term, str) or not term.strip():
            raise ValueError(f"{path}: each term must have a nonempty string 'term'")
        if not isinstance(part, str) or part not in {"technical_noun", "technical_verb"}:
            raise ValueError(f"{path}: {term!r} has invalid part_of_speech")
        extra_forms = entry.get("forms", [])
        if not isinstance(extra_forms, list):
            raise ValueError(f"{path}: {term!r} has invalid forms, expected a list")
        values = [term] + extra_forms
        if not all(isinstance(value, str) and value.strip() for value in values):
            raise ValueError(f"{path}: {term!r} has an invalid form")
        entry["source"] = SOURCE_PROJECT
        for value in values:
            forms[value.casefold()] = entry
    return forms


def _nonempty_string_list(value) -> bool:
    return isinstance(value, list) and bool(value) and all(
        isinstance(item, str) and item.strip() for item in value
    )


def load_software_terms(path: Path = SOFTWARE_TERMS) -> list:
    """Load the hand-curated, git-committed AI-tic denylist.

    Unlike `load_dictionary`, this file is not a pinned download, so validation is
    schema and internal consistency, not a SHA-256 match. Each row is normalized
    into the same shape as a base-dictionary entry so `dictionary_candidates` and
    `ste_lookup` need no source-specific branching beyond checking `source`.
    """
    entries = []
    seen_keys: dict = {}
    for entry in read_jsonl(path):
        missing = REQUIRED_SOFTWARE_ENTRY_FIELDS - entry.keys()
        if missing:
            raise ValueError(f"{path}: entry is missing fields: {sorted(missing)}")
        term = entry["term"]
        if not isinstance(term, str) or not term.strip():
            raise ValueError(f"{path}: 'term' must be a nonempty string")
        if entry["status"] != "unapproved":
            raise ValueError(f"{path}: {term!r} must have status 'unapproved'")
        if entry["part_of_speech"] not in VALID_PARTS:
            raise ValueError(f"{path}: {term!r} has an invalid part_of_speech")
        for field in ("flagged_sense", "rationale", "observed", "attestation"):
            if not isinstance(entry[field], str) or not entry[field].strip():
                raise ValueError(f"{path}: {term!r} must have a nonempty string {field!r}")
        if not _nonempty_string_list(entry["alternatives"]):
            raise ValueError(f"{path}: {term!r} must have a nonempty 'alternatives' list of strings")
        if not _nonempty_string_list(entry["models"]):
            raise ValueError(f"{path}: {term!r} must have a nonempty 'models' list of strings")
        extra_forms = entry.get("forms", [])
        if not isinstance(extra_forms, list) or not all(
            isinstance(item, str) and item.strip() for item in extra_forms
        ):
            raise ValueError(f"{path}: {term!r} has an invalid 'forms' value")
        examples = entry.get("examples", [])
        if not isinstance(examples, list) or not all(isinstance(item, str) for item in examples):
            raise ValueError(f"{path}: {term!r} has an invalid 'examples' value")
        rule = entry.get("rule", "1.1")
        if not isinstance(rule, str) or not rule.strip():
            raise ValueError(f"{path}: {term!r} has an invalid 'rule' value")
        forms = [term] + extra_forms
        for form in forms:
            key = form.casefold()
            if key in seen_keys:
                raise ValueError(
                    f"{path}: {form!r} is claimed by both {seen_keys[key]!r} and {term!r}"
                )
            seen_keys[key] = term
        entries.append({
            "headword": term.casefold(),
            "display": term,
            "status": "unapproved",
            "part_of_speech": entry["part_of_speech"],
            "forms": forms,
            "meaning_or_alternatives": entry["alternatives"],
            "ste_examples": examples,
            "non_ste_examples": [],
            "source": SOURCE_SOFTWARE,
            "flagged_sense": entry["flagged_sense"],
            "rationale": entry["rationale"],
            "observed": entry["observed"],
            "models": entry["models"],
            "attestation": entry["attestation"],
            "rule": rule,
        })
    return entries


def merge_layers(dictionary: DictionaryData, software_entries: list, layers) -> DictionaryData:
    """Combine the ASD base dictionary and the software-terminology layer.

    `layers` is an iterable drawn from `LAYERS`. The `"project"` value is not
    consumed here: the per-project `--terms` layer is merged by `check_file`
    itself, which already treats it as highest precedence over everything this
    function builds. This function only decides whether the ASD base dictionary
    and the software layer each contribute to the merged `by_headword` /
    `approved_forms` / `unapproved` structures.

    Precedence for a headword or form claimed by both layers: the software
    layer's entry replaces the ASD entry for that key in `unapproved`. A lookup
    on that key never mixes entries from two sources. `approved_forms` stays
    untouched by the software layer, which has no approved vocabulary.
    """
    active = set(layers)
    entries: list = []
    by_headword: dict = defaultdict(list)
    approved_forms: dict = defaultdict(list)
    unapproved: dict = defaultdict(list)

    if "asd" in active:
        entries.extend(dictionary.entries)
        for key, values in dictionary.by_headword.items():
            by_headword[key].extend(values)
        for key, values in dictionary.approved_forms.items():
            approved_forms[key].extend(values)
        for key, values in dictionary.unapproved.items():
            unapproved[key].extend(values)

    if "software" in active:
        entries.extend(software_entries)
        for entry in software_entries:
            by_headword[entry["headword"]].append(entry)
            for form in entry["forms"]:
                unapproved[form.casefold()] = [entry]

    return DictionaryData(entries, by_headword, approved_forms, unapproved)
