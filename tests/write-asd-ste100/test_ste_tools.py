#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2] / "plugins" / "harness" / "skills" / "write-asd-ste100"
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import extract_dictionary
import initialize_references
import ste_check
import ste_data
from ste_check import check_file, count_words
from ste_data import (
    DictionaryData,
    ReferencesError,
    generated_bundle_path,
    load_dictionary,
    load_software_terms,
    load_terms,
    merge_layers,
    validate_bundle,
)


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def dictionary_bytes(entries: list[dict]) -> bytes:
    return b"".join(
        (json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
        for entry in entries
    )


def entry(
    headword: str,
    display: str,
    status: str,
    part: str,
    forms: list[str],
    page: int,
    standard_page: str,
) -> dict:
    return {
        "headword": headword,
        "display": display,
        "status": status,
        "part_of_speech": part,
        "forms": forms,
        "meaning_or_alternatives": ["A test meaning"],
        "ste_examples": ["USE THE TOOL."],
        "non_ste_examples": [],
        "issue": 9,
        "pdf_page": page,
        "standard_page": standard_page,
    }


def small_entries() -> list[dict]:
    return [
        entry("use", "USE", "approved", "v", ["USE", "USES", "USED"], 1, "2-1-A1"),
        entry("utilize", "utilize", "unapproved", "v", ["utilize"], 2, "2-1-U1"),
    ]


class SkillInstructionTests(unittest.TestCase):
    def test_initialization_decision_prefers_ask_user_api_with_plain_chat_fallback(self):
        instructions = (ROOT / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("use the ask-user API of the current harness when it is available", instructions)
        self.assertIn("Do not send a plain chat question before you try the available API.", instructions)
        self.assertIn("If no ask-user API is available, ask the same question through a plain chat message", instructions)
        self.assertIn("Do not mention API availability or the fallback to the user.", instructions)
        self.assertIn("Codex: use `request_user_input`, with the ID `initialize_references`.", instructions)
        self.assertIn("Claude Code: use `AskUserQuestion`, with the header `Initialize`.", instructions)
        self.assertIn("Run the reported initialization command now?", instructions)
        self.assertIn("`Initialize now (Recommended)`", instructions)
        self.assertIn("`Do not initialize`", instructions)
        self.assertNotIn("Offer to run the exact initialization command", instructions)

    def test_skill_frontmatter_description_is_harness_neutral(self):
        instructions = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        frontmatter = instructions.split("---", 2)[1]

        self.assertNotIn("Codex", frontmatter)

    def test_skill_documents_absolute_path_rule(self):
        instructions = (ROOT / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn(
            "Every command path in this skill is relative to the skill directory, "
            "not the current working directory.",
            instructions,
        )

    def test_skill_documents_shared_user_level_references(self):
        instructions = (ROOT / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("`~/.harness-plugin/write-asd-ste100/bundles/`", instructions)
        self.assertIn("plugin version", instructions)


class InstallGuideTests(unittest.TestCase):
    def test_install_guide_documents_reference_initialization(self):
        guide = (ROOT / "INSTALL.md").read_text(encoding="utf-8")

        self.assertIn("initialize_references.py", guide)
        self.assertIn("validate_references.py", guide)
        self.assertIn("--import-from", guide)
        self.assertIn("~/.harness-plugin/write-asd-ste100/bundles/", guide)


class ExtractDictionaryTests(unittest.TestCase):
    """extract_dictionary.py's pure geometry/text logic, with no PDF and no pypdfium2.

    extract_dictionary.load_pdfium() is deferred (imported only inside extract()),
    so this module is importable, and this logic testable, without the
    initialization-only pypdfium2 dependency installed.
    """

    def test_module_does_not_import_pypdfium2_at_module_level(self):
        self.assertNotIn("pypdfium2", vars(extract_dictionary))

    def test_load_pdfium_reports_a_clear_install_hint_when_missing(self):
        with mock.patch.dict(sys.modules, {"pypdfium2": None}):
            with self.assertRaises(SystemExit) as raised:
                extract_dictionary.load_pdfium()
        self.assertIn("pip install pypdfium2", str(raised.exception))

    def test_config_requires_exactly_five_column_offsets(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "source-config.json"
            config_path.write_text(
                json.dumps({"extraction": {"column_offsets": [0.0, 1.0, 2.0]}}),
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit) as raised:
                extract_dictionary.load_config(config_path)
        self.assertIn("five column offsets", str(raised.exception))

    def test_config_requires_the_extraction_key(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "source-config.json"
            config_path.write_text(json.dumps({}), encoding="utf-8")
            with self.assertRaises(SystemExit) as raised:
                extract_dictionary.load_config(config_path)
        self.assertIn("incomplete schema", str(raised.exception))

    def test_page_anchor_extracts_the_standard_page(self):
        self.assertEqual(extract_dictionary.page_anchor("... Page 2-1-A1 ...", 149), "2-1-A1")

    def test_page_anchor_fails_without_a_match(self):
        with self.assertRaises(SystemExit) as raised:
            extract_dictionary.page_anchor("no anchor here", 149)
        self.assertIn("missing dictionary source-page anchor", str(raised.exception))

    def test_normalize_char_known_values(self):
        # U+FFFE: this PDF's unmapped discretionary line-wrap hyphen glyph.
        for value, expected in [("￾", "-"), (" ", None), ("", None), ("A", "A")]:
            with self.subTest(value=value):
                self.assertEqual(extract_dictionary.normalize_char(value, 149), expected)

    def test_normalize_char_fails_loudly_on_an_unexpected_format_character(self):
        with self.assertRaises(SystemExit) as raised:
            extract_dictionary.normalize_char("­", 149)  # soft hyphen, not the known fallback
        self.assertIn("unexpected formatting character", str(raised.exception))
        self.assertIn("physical page 149", str(raised.exception))

    def test_assign_column_uses_the_boundary_tolerance(self):
        starts = [72.0, 180.0, 310.0, 440.0, 580.0]
        self.assertEqual(extract_dictionary.assign_column(72.0, starts, 1.0), 0)
        self.assertEqual(extract_dictionary.assign_column(178.5, starts, 1.0), 0)
        self.assertEqual(extract_dictionary.assign_column(179.5, starts, 1.0), 1)
        self.assertIsNone(extract_dictionary.assign_column(600.0, starts, 1.0))

    def test_cluster_column_lines_groups_a_trailing_glyph_within_tolerance(self):
        # A trailing period reporting a min_y ~0.35pt off the rest of its line
        # (observed with pypdfium2's loose char box) must still join that line,
        # not start a spurious one-glyph line of its own.
        glyphs = [
            ("T", 288.0, 294.0, 491.2),
            ("H", 294.0, 300.0, 491.2),
            ("E", 300.0, 306.0, 491.2),
            (".", 395.5, 398.3, 491.6),
        ]
        lines = extract_dictionary.cluster_column_lines(glyphs)
        self.assertEqual(len(lines), 1)
        self.assertEqual(len(lines[0]), 4)

    def test_cluster_column_lines_keeps_distinct_lines_separate(self):
        glyphs = [
            ("A", 72.0, 78.0, 685.2),
            ("B", 72.0, 78.0, 673.2),
        ]
        lines = extract_dictionary.cluster_column_lines(glyphs)
        self.assertEqual(len(lines), 2)

    def test_line_text_inserts_a_space_at_the_configured_gap(self):
        glyphs = [
            ("a", 72.0, 78.0, 685.2),
            ("b", 78.0, 84.0, 685.2),
            ("(", 90.0, 93.0, 685.2),
        ]
        self.assertEqual(extract_dictionary.line_text(glyphs, space_threshold=1.25), "ab (")


def source_config(raw_dictionary: bytes) -> dict:
    return {
        "schema_version": 1,
        "source": {
            "title": "ASD-STE100 Simplified Technical English, Standard for Technical Documentation",
            "issue": 9,
            "issue_date": "2025-01-15",
            "publisher": "ASD Simplified Technical English Maintenance Group",
            "url": "https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf",
            "pdf_sha256": "a" * 64,
        },
        "extraction": {
            "page_count": 2,
            "physical_page_start": 1,
            "physical_page_end": 2,
            "content_y_min": 80.0,
            "content_y_max": 700.0,
            "even_left_margin": 50.4,
            "odd_left_margin": 72.0,
            "column_offsets": [0.0, 102.7, 237.6, 367.3, 507.0],
            "column_boundary_tolerance": 1.0,
            "glyph_space_threshold": 1.25,
        },
        "dictionary": {
            "sha256": hashlib.sha256(raw_dictionary).hexdigest(),
            "part_of_speech_rows": 2,
            "approved_rows": 1,
            "unapproved_rows": 1,
            "declared_approved_words": 1,
            "declared_unapproved_words": 1,
            "required_source_anchors": ["2-1-A1", "2-1-U1"],
            "reconciliation": {
                "approved_multi_word_rows_not_in_word_count": [],
                "unapproved_multi_word_rows_not_in_word_count": [],
            },
            "known_source_cases": {},
        },
    }


def make_bundle(root: Path, raw_dictionary: bytes | None = None) -> tuple[Path, Path, bytes]:
    raw_dictionary = raw_dictionary if raw_dictionary is not None else dictionary_bytes(small_entries())
    references = root / "references"
    generated = references / "generated"
    generated.mkdir(parents=True)
    config_path = references / "source-config.json"
    config = source_config(raw_dictionary)
    config_path.write_bytes(json_bytes(config))
    dictionary_path = generated / "dictionary.jsonl"
    dictionary_path.write_bytes(raw_dictionary)
    config_digest = hashlib.sha256(config_path.read_bytes()).hexdigest()
    dictionary_digest = hashlib.sha256(raw_dictionary).hexdigest()
    validation = {
        "schema_version": 1,
        "source": dict(config["source"]),
        "source_config_sha256": config_digest,
        "dictionary_sha256": dictionary_digest,
        "part_of_speech_rows": 2,
        "approved_rows": 1,
        "unapproved_rows": 1,
        "declared_approved_words": 1,
        "declared_unapproved_words": 1,
        "reconciliation": config["dictionary"]["reconciliation"],
        "known_source_cases": {},
    }
    validation_path = generated / "dictionary-validation.json"
    validation_path.write_bytes(json_bytes(validation))
    manifest = {
        "schema_version": 1,
        "source": dict(config["source"]),
        "source_config_sha256": config_digest,
        "files": {
            "dictionary.jsonl": {
                "bytes": dictionary_path.stat().st_size,
                "sha256": dictionary_digest,
            },
            "dictionary-validation.json": {
                "bytes": validation_path.stat().st_size,
                "sha256": hashlib.sha256(validation_path.read_bytes()).hexdigest(),
            },
        },
    }
    (generated / "manifest.json").write_bytes(json_bytes(manifest))
    return config_path, generated, raw_dictionary


def software_term(
    term: str,
    part: str = "adv",
    forms: list[str] | None = None,
    alternatives: list[str] | None = None,
    rule: str | None = None,
) -> dict:
    row = {
        "term": term,
        "status": "unapproved",
        "part_of_speech": part,
        "flagged_sense": f"test fixture sense for {term!r}",
        "alternatives": alternatives or ["(state the point directly)"],
        "rationale": "Test fixture entry.",
        "observed": "2026-08",
        "models": ["Claude"],
        "attestation": "https://example.invalid/test-fixture",
    }
    if forms is not None:
        row["forms"] = forms
    if rule is not None:
        row["rule"] = rule
    return row


def software_terminology_bytes(rows: list[dict] | None = None) -> bytes:
    # The contracted form is unreachable as an `overused_term` finding, by design.
    # `check_file` masks contractions out of the vocabulary-matching pass before
    # phrase matching runs. As a result, "you're" is always caught first as a
    # plain `contraction` error (rule 4.2). STE bans contractions outright,
    # regardless of this layer. The uncontracted form registered here is what a
    # caller sees after fixing the contraction. That is when this layer's finding
    # becomes reachable.
    rows = rows if rows is not None else [
        software_term("you're absolutely right", forms=["you are absolutely right"])
    ]
    return b"".join((json.dumps(row, ensure_ascii=False) + "\n").encode() for row in rows)


def checker_entries() -> list[dict]:
    approved = [
        ("use", "USE", "v", ["USE", "USES", "USED"]),
        ("the", "THE", "art", ["THE"]),
        ("tool", "TOOL", "n", ["TOOL"]),
        ("disconnect", "DISCONNECT", "v", ["DISCONNECT", "DISCONNECTS", "DISCONNECTED"]),
        ("unit", "UNIT", "n", ["UNIT"]),
        ("ready", "READY", "adj", ["READY"]),
        ("install", "INSTALL", "v", ["INSTALL", "INSTALLS", "INSTALLED"]),
        ("run", "RUN", "v", ["RUN", "RUNS", "RAN"]),
        ("continue", "CONTINUE", "v", ["CONTINUE", "CONTINUES", "CONTINUED"]),
        ("data", "DATA", "n", ["DATA"]),
        ("utility", "UTILITY", "n", ["UTILITY"]),
        ("will", "WILL", "v", ["WILL"]),
        ("copy", "COPY", "v", ["COPY", "COPIES", "COPIED"]),
        ("source", "SOURCE", "n", ["SOURCE"]),
        ("function", "FUNCTION", "n", ["FUNCTION"]),
        ("with", "WITH", "prep", ["WITH"]),
        ("clearance", "CLEARANCE", "n", ["CLEARANCE"]),
        ("align", "ALIGN", "v", ["ALIGNS", "ALIGNED"]),
    ]
    records = [
        entry(word, display, "approved", part, forms, 1, f"2-1-A{number}")
        for number, (word, display, part, forms) in enumerate(approved, 1)
    ]
    records.extend(
        [
            entry("utilize", "utilize", "unapproved", "v", ["utilize"], 2, "2-1-U1"),
            entry("prior to", "prior to", "unapproved", "prep", ["prior to"], 2, "2-1-U2"),
        ]
    )
    return records


class ReadinessValidationTests(unittest.TestCase):
    def test_valid_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            config, generated, _ = make_bundle(Path(directory))
            result = validate_bundle(generated, config)
        self.assertEqual(result["dictionary_rows"], 2)

    def test_missing_directory_and_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = dictionary_bytes(small_entries())
            config = root / "references" / "source-config.json"
            config.parent.mkdir()
            config.write_bytes(json_bytes(source_config(raw)))
            with self.assertRaisesRegex(ReferencesError, "generated directory does not exist") as caught:
                validate_bundle(root / "references" / "generated", config)
            self.assertEqual(caught.exception.code, "references_missing")
            config, generated, _ = make_bundle(root / "second")
            (generated / "manifest.json").unlink()
            with self.assertRaisesRegex(ReferencesError, "required generated file is missing") as caught:
                validate_bundle(generated, config)
            self.assertEqual(caught.exception.code, "references_missing")

    def test_incomplete_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            config, generated, _ = make_bundle(Path(directory))
            manifest_path = generated / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            del manifest["files"]["dictionary.jsonl"]["bytes"]
            manifest_path.write_bytes(json_bytes(manifest))
            with self.assertRaisesRegex(ReferencesError, "incomplete record for dictionary.jsonl"):
                validate_bundle(generated, config)

    def test_wrong_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            config, generated, _ = make_bundle(Path(directory))
            manifest_path = generated / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["files"]["dictionary.jsonl"]["sha256"] = "0" * 64
            manifest_path.write_bytes(json_bytes(manifest))
            with self.assertRaisesRegex(ReferencesError, "manifest SHA-256 for dictionary.jsonl"):
                validate_bundle(generated, config)

    def test_wrong_byte_count(self):
        with tempfile.TemporaryDirectory() as directory:
            config, generated, _ = make_bundle(Path(directory))
            manifest_path = generated / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["files"]["dictionary.jsonl"]["bytes"] = 0
            manifest_path.write_bytes(json_bytes(manifest))
            with self.assertRaisesRegex(ReferencesError, "manifest byte count for dictionary.jsonl"):
                validate_bundle(generated, config)

    def test_wrong_source_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            config, generated, _ = make_bundle(Path(directory))
            validation_path = generated / "dictionary-validation.json"
            validation = json.loads(validation_path.read_text())
            validation["source"]["issue"] = 8
            validation_path.write_bytes(json_bytes(validation))
            with self.assertRaisesRegex(ReferencesError, "wrong source identity"):
                validate_bundle(generated, config)

    def test_stale_source_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            config, generated, _ = make_bundle(Path(directory))
            value = json.loads(config.read_text())
            value["source"]["title"] += " revised"
            config.write_bytes(json_bytes(value))
            with self.assertRaisesRegex(ReferencesError, "wrong source identity|stale"):
                validate_bundle(generated, config)

    def test_malformed_dictionary(self):
        with tempfile.TemporaryDirectory() as directory:
            config, generated, _ = make_bundle(Path(directory), b"{not json}\n")
            with self.assertRaisesRegex(ReferencesError, "dictionary JSONL is malformed"):
                validate_bundle(generated, config)


class GeneratedBundlePathTests(unittest.TestCase):
    def test_bundle_is_stored_under_the_plugin_user_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, _, _ = make_bundle(root / "skill")
            home = root / "user"
            digest = hashlib.sha256(config.read_bytes()).hexdigest()

            self.assertEqual(
                generated_bundle_path(config, home),
                home / ".harness-plugin" / "write-asd-ste100" / "bundles" / digest,
            )

    def test_plugin_versions_with_the_same_config_share_a_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_config, _, _ = make_bundle(root / "plugin-3.0.1")
            second_config, _, _ = make_bundle(root / "plugin-3.0.2")
            home = root / "user"

            self.assertEqual(
                generated_bundle_path(first_config, home),
                generated_bundle_path(second_config, home),
            )

    def test_changed_source_config_selects_a_separate_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_config, _, _ = make_bundle(root / "first")
            second_config, _, _ = make_bundle(root / "second")
            changed = json.loads(second_config.read_text(encoding="utf-8"))
            changed["source"]["title"] += " revised"
            second_config.write_bytes(json_bytes(changed))
            home = root / "user"

            self.assertNotEqual(
                generated_bundle_path(first_config, home),
                generated_bundle_path(second_config, home),
            )


class RuntimeEntryPointTests(unittest.TestCase):
    public_scripts = ("ste_lookup.py", "ste_check.py", "validate_dictionary.py", "validate_references.py")

    def make_runtime(self, root: Path, valid: bool) -> tuple[Path, Path]:
        home = root / "home"
        home.mkdir()
        previous_home = os.environ.get("HOME")
        os.environ["HOME"] = str(home)

        def restore_home():
            if previous_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = previous_home

        self.addCleanup(restore_home)
        scripts = root / "scripts"
        scripts.mkdir()
        for name in (*self.public_scripts, "ste_data.py"):
            shutil.copy2(SCRIPTS / name, scripts / name)
        config, generated, _ = make_bundle(root)
        shared_generated = generated_bundle_path(config, home)
        shared_generated.parent.mkdir(parents=True)
        shutil.move(generated, shared_generated)
        (root / "references" / "software-terminology.jsonl").write_bytes(software_terminology_bytes())
        if not valid:
            shutil.rmtree(shared_generated)
        self.runtime_generated = shared_generated
        document = root / "input.md"
        document.write_text("Use.", encoding="utf-8")
        return scripts, document

    def run_public(self, scripts: Path, document: Path, name: str, json_output: bool = False, env=None):
        if name == "ste_lookup.py":
            arguments = ["USE"]
        elif name == "ste_check.py":
            arguments = [str(document), "--mode", "procedural"]
        else:
            arguments = []
        if json_output:
            arguments.append("--json")
        return subprocess.run(
            [sys.executable, str(scripts / name), *arguments],
            text=True,
            capture_output=True,
            check=False,
            env=env,
        )

    def test_every_entry_point_validates_automatically(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=False)
            for name in self.public_scripts:
                with self.subTest(name=name):
                    result = self.run_public(scripts, document, name)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("ERROR [references_missing]", result.stderr)
                    self.assertIn("generated directory does not exist", result.stderr)
                    self.assertIn(str(self.runtime_generated.resolve()), result.stderr)
                    self.assertIn("initialize_references.py", result.stderr)
                    self.assertIn("Online download required: yes", result.stderr)
                    self.assertIn("ASD-STE100", result.stderr)
                    self.assertNotIn("Traceback", result.stderr)

    def test_every_entry_point_accepts_a_valid_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            for name in self.public_scripts:
                with self.subTest(name=name):
                    result = self.run_public(scripts, document, name)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_json_initialization_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=False)
            for name in self.public_scripts:
                with self.subTest(name=name):
                    result = self.run_public(scripts, document, name, json_output=True)
                    self.assertEqual(result.returncode, 2)
                    payload = json.loads(result.stderr)
                    error = payload["error"]
                    self.assertEqual(error["code"], "references_missing")
                    self.assertTrue(error["requires_online_download"])
                    self.assertIn("generated directory does not exist", error["condition"])
                    self.assertTrue(Path(error["generated_data_location"]).is_absolute())
                    self.assertIn("initialize_references.py", error["initialization_command"])
                    self.assertIn("ASD-STE100", error["issue_identity"])

    def test_missing_source_config_uses_a_structured_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts, document = self.make_runtime(root, valid=False)
            (root / "references" / "source-config.json").unlink()

            result = self.run_public(scripts, document, "ste_lookup.py", json_output=True)

        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)
        error = json.loads(result.stderr)["error"]
        self.assertEqual(error["code"], "references_invalid")
        self.assertIn("tracked source configuration is missing", error["condition"])

    def test_missing_diagnostic_source_fields_are_structured_at_every_entry_point(self):
        for missing_field in ("title", "issue_date"):
            with self.subTest(field=missing_field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                scripts, document = self.make_runtime(root, valid=True)
                config_path = root / "references" / "source-config.json"
                config = json.loads(config_path.read_text())
                del config["source"][missing_field]
                config_path.write_bytes(json_bytes(config))
                for name in self.public_scripts:
                    with self.subTest(field=missing_field, name=name):
                        result = self.run_public(scripts, document, name, json_output=True)
                        self.assertEqual(result.returncode, 2)
                        self.assertNotIn("Traceback", result.stderr)
                        error = json.loads(result.stderr)["error"]
                        self.assertEqual(error["code"], "references_invalid")
                        self.assertIn("incomplete schema", error["condition"])

    def test_runtime_entry_points_do_not_open_network_sockets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts, document = self.make_runtime(root, valid=True)
            blocker = root / "block-network"
            blocker.mkdir()
            (blocker / "sitecustomize.py").write_text(
                "import socket\n"
                "def blocked(*args, **kwargs):\n"
                "    raise RuntimeError('network access attempted')\n"
                "socket.socket = blocked\n",
                encoding="utf-8",
            )
            environment = dict(os.environ)
            environment["PYTHONPATH"] = str(blocker)
            for name in self.public_scripts:
                with self.subTest(name=name):
                    result = self.run_public(scripts, document, name, env=environment)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotIn("network access attempted", result.stderr)

    def test_one_file_uses_the_batch_json_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            document.write_text("Use.", encoding="utf-8")
            result = self.run_public(scripts, document, "ste_check.py", json_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["outcome"], "pass")
        self.assertEqual(payload["summary"], {
            "files": 1,
            "passed_files": 1,
            "review_files": 0,
            "failed_files": 0,
            "total": 0,
            "errors": 0,
            "warnings": 0,
            "reviews": 0,
            "unique_unknown_terms": 0,
        })
        self.assertEqual(payload["files"], [{
            "path": str(document),
            "outcome": "pass",
            "summary": {
                "total": 0,
                "errors": 0,
                "warnings": 0,
                "reviews": 0,
                "unique_unknown_terms": 0,
            },
            "findings": [],
        }])

    def test_checker_file_outcomes_match_process_statuses(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            for text, outcome, status in (("Utilize.", "fail", 1), ("Widget.", "review", 0)):
                with self.subTest(outcome=outcome):
                    document.write_text(text, encoding="utf-8")
                    result = self.run_public(scripts, document, "ste_check.py", json_output=True)
                    self.assertEqual(result.returncode, status, result.stderr)
                    self.assertEqual(json.loads(result.stdout)["files"][0]["outcome"], outcome)

    def test_multiple_files_have_ordered_reports_and_aggregate_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, first = self.make_runtime(Path(directory), valid=True)
            second = Path(directory) / "second.md"
            third = Path(directory) / "third.md"
            first.write_text("Use.", encoding="utf-8")
            second.write_text("Widget.", encoding="utf-8")
            third.write_text("Utilize.", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(second), str(first), str(third),
                 "--mode", "procedural", "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 1, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual([item["path"] for item in payload["files"]], [str(second), str(first), str(third)])
        self.assertEqual([item["outcome"] for item in payload["files"]], ["review", "pass", "fail"])
        self.assertEqual(payload["summary"], {
            "files": 3,
            "passed_files": 1,
            "review_files": 1,
            "failed_files": 1,
            "total": 2,
            "errors": 1,
            "warnings": 0,
            "reviews": 1,
            "unique_unknown_terms": 1,
        })

    def test_batch_unknown_terms_deduplicate_and_offsets_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, first = self.make_runtime(Path(directory), valid=True)
            second = Path(directory) / "second.md"
            first.write_text("Widget.", encoding="utf-8")
            second.write_text("Widget.", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(first), str(second),
                 "--mode", "procedural", "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["summary"]["unique_unknown_terms"], 1)
        self.assertEqual(
            [item["findings"][0]["source"]["start"]["offset"] for item in payload["files"]], [0, 0]
        )
        self.assertEqual([item["findings"][0]["id"] for item in payload["files"]], ["F001", "F001"])

    def test_unreadable_inputs_are_transactional(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            document.write_text("Utilize.", encoding="utf-8")
            missing = Path(directory) / "missing.md"
            result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(document), str(missing),
                 "--mode", "procedural", "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads(result.stderr), {"error": {
            "code": "input_read_failed",
            "inputs": [{"path": str(missing), "condition": "file does not exist"}],
        }})

    def test_invalid_utf8_and_combined_standard_input_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            invalid = Path(directory) / "invalid.md"
            invalid.write_bytes(b"\xff")
            invalid_result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(invalid),
                 "--mode", "procedural", "--json"],
                text=True, capture_output=True, check=False,
            )
            stdin_result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), "-", str(document),
                 "--mode", "procedural", "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(invalid_result.returncode, 2)
        self.assertEqual(json.loads(invalid_result.stderr)["error"]["inputs"][0]["condition"], "invalid UTF-8")
        self.assertEqual(stdin_result.returncode, 2)
        self.assertEqual(json.loads(stdin_result.stderr)["error"]["code"], "invalid_arguments")

    def test_invalid_arguments_and_terms_use_structured_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            terms = Path(directory) / "terms.jsonl"
            terms.write_text("{not json}\n", encoding="utf-8")
            argument_result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(document), "--json"],
                text=True, capture_output=True, check=False,
            )
            terms_result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(document), "--mode", "procedural",
                 "--terms", str(terms), "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(argument_result.returncode, 2)
        self.assertEqual(json.loads(argument_result.stderr)["error"]["code"], "invalid_arguments")
        self.assertEqual(terms_result.returncode, 2)
        self.assertEqual(json.loads(terms_result.stderr)["error"]["code"], "terms_invalid")

    def test_plain_text_uses_file_sections_and_aggregate_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            second = Path(directory) / "second.md"
            document.write_text("Utilize.", encoding="utf-8")
            second.write_text("Widget.", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(second), str(document),
                 "--mode", "procedural"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"File: {document}\n", result.stdout)
        self.assertLess(result.stdout.index(f"File: {second}"), result.stdout.index(f"File: {document}"))
        self.assertIn("Outcome: fail\n", result.stdout)
        self.assertIn("Outcome: review\n", result.stdout)
        self.assertIn("Aggregate summary:\n", result.stdout)
        self.assertIn("  failed_files: 1\n", result.stdout)

    def test_layers_flag_selects_vocabulary_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            document.write_text("You are absolutely right, the frobnicator is ready.\n", encoding="utf-8")
            default_result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(document), "--mode", "descriptive", "--json"],
                text=True, capture_output=True, check=False,
            )
            software_only = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(document), "--mode", "descriptive",
                 "--layers", "software", "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(default_result.returncode, 0, default_result.stderr)
        self.assertEqual(software_only.returncode, 0, software_only.stderr)
        default_categories = {
            item["category"] for item in json.loads(default_result.stdout)["files"][0]["findings"]
        }
        software_categories = {
            item["category"] for item in json.loads(software_only.stdout)["files"][0]["findings"]
        }
        self.assertIn("unknown_term", default_categories)
        self.assertIn("overused_term", default_categories)
        self.assertNotIn("unknown_term", software_categories)
        self.assertIn("overused_term", software_categories)

    def test_invalid_layers_value_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            result = subprocess.run(
                [sys.executable, str(scripts / "ste_check.py"), str(document), "--mode", "procedural",
                 "--layers", "bogus", "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "invalid_arguments")

    def test_ste_lookup_resolves_a_software_terminology_entry_as_json(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            result = subprocess.run(
                [sys.executable, str(scripts / "ste_lookup.py"), "you're absolutely right", "--json"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(len(payload["matches"]), 1)
        match = payload["matches"][0]
        self.assertEqual(match["source"], "software_terms")
        self.assertNotIn("pdf_page", match)
        self.assertNotIn("standard_page", match)

    def test_ste_lookup_plain_text_for_a_software_entry_has_no_issue_9_line(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts, document = self.make_runtime(Path(directory), valid=True)
            result = subprocess.run(
                [sys.executable, str(scripts / "ste_lookup.py"), "you're absolutely right"],
                text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Issue 9", result.stdout)
        self.assertIn("software terminology", result.stdout)


class CheckerTypingCompatibilityTests(unittest.TestCase):
    def test_checker_import_needs_no_literal_or_typed_dict_at_runtime(self):
        program = "\n".join(
            [
                "import sys",
                f"sys.path.insert(0, {str(SCRIPTS)!r})",
                "import dataclasses",
                "dataclasses.dataclass = lambda cls=None, **kwargs: cls if cls is not None else lambda value: value",
                "import ste_data",
                "import types",
                "typing = types.ModuleType('typing')",
                "typing.Any = object",
                "typing.TYPE_CHECKING = False",
                "sys.modules['typing'] = typing",
                "import ste_check",
            ]
        )
        result = subprocess.run(
            [sys.executable, "-c", program],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)


class BatchOrchestrationTests(unittest.TestCase):
    def test_references_dictionary_and_terms_load_once_per_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.md"
            second = Path(directory) / "second.md"
            first.write_text("Use.", encoding="utf-8")
            second.write_text("Use.", encoding="utf-8")
            result = {
                "mode": "procedural",
                "outcome": "pass",
                "summary": {
                    "total": 0,
                    "errors": 0,
                    "warnings": 0,
                    "reviews": 0,
                    "unique_unknown_terms": 0,
                },
                "findings": [],
            }
            with mock.patch.object(ste_check, "ensure_references_ready") as ready, mock.patch.object(
                ste_check, "load_dictionary", return_value=DictionaryData([], {}, {}, {})
            ) as dictionary, mock.patch.object(
                ste_check, "load_software_terms", return_value=[]
            ) as software, mock.patch.object(ste_check, "load_terms", return_value={}) as terms, mock.patch.object(
                ste_check, "check_file", return_value=result
            ) as analyze, mock.patch("sys.stdout", new_callable=io.StringIO):
                status = ste_check.main([str(first), str(second), "--mode", "procedural", "--json"])
        self.assertEqual(status, 0)
        ready.assert_called_once_with()
        dictionary.assert_called_once_with()
        software.assert_called_once_with()
        terms.assert_called_once_with(None)
        self.assertEqual(analyze.call_count, 2)

    def test_input_failures_prevent_analysis_and_dependency_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            valid = Path(directory) / "valid.md"
            valid.write_text("Use.", encoding="utf-8")
            missing = Path(directory) / "missing.md"
            with mock.patch.object(ste_check, "ensure_references_ready") as ready, mock.patch.object(
                ste_check, "load_dictionary"
            ) as dictionary, mock.patch.object(ste_check, "load_terms") as terms, mock.patch.object(
                ste_check, "check_file"
            ) as analyze, mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                status = ste_check.main([str(valid), str(missing), "--mode", "procedural", "--json"])
        self.assertEqual(status, 2)
        ready.assert_called_once_with()
        dictionary.assert_not_called()
        terms.assert_not_called()
        analyze.assert_not_called()
        self.assertEqual(json.loads(stderr.getvalue())["error"]["code"], "input_read_failed")


class InitializerRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        dependency_patcher = mock.patch.object(initialize_references, "check_extractor_dependency")
        self.dependency_check = dependency_patcher.start()
        self.addCleanup(dependency_patcher.stop)
        self.root = Path(self.temporary.name)
        self.config, generated, self.raw = make_bundle(self.root)
        shutil.rmtree(generated)
        self.generated = generated
        self.generated.mkdir()
        (self.generated / "sentinel.txt").write_text("existing valid bundle", encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def assert_existing_survives(self):
        self.assertEqual(
            (self.generated / "sentinel.txt").read_text(encoding="utf-8"),
            "existing valid bundle",
        )
        self.assertEqual([path.name for path in self.generated.iterdir()], ["sentinel.txt"])

    @staticmethod
    def fake_download(_url: str, output: Path):
        output.write_bytes(b"pdf")

    @staticmethod
    def fake_extract(_pdf: Path, geometry: Path, _config: Path):
        geometry.write_text("{}\n", encoding="utf-8")

    def fake_build(self, _geometry: Path, dictionary: Path):
        dictionary.write_bytes(self.raw)

    def test_existing_bundle_survives_download_failure(self):
        with mock.patch.object(
            initialize_references, "download_pdf", side_effect=initialize_references.InitializationError("download")
        ):
            with self.assertRaises(initialize_references.InitializationError):
                initialize_references.initialize(None, True, self.config, self.generated)
        self.assert_existing_survives()

    def test_existing_bundle_survives_hash_failure(self):
        with mock.patch.object(initialize_references, "download_pdf", self.fake_download), mock.patch.object(
            initialize_references, "verify_pdf_hash", side_effect=initialize_references.InitializationError("hash")
        ):
            with self.assertRaises(initialize_references.InitializationError):
                initialize_references.initialize(None, True, self.config, self.generated)
        self.assert_existing_survives()

    def test_existing_bundle_survives_extraction_failure(self):
        with mock.patch.object(initialize_references, "download_pdf", self.fake_download), mock.patch.object(
            initialize_references, "verify_pdf_hash"
        ), mock.patch.object(
            initialize_references, "run_extractor", side_effect=initialize_references.InitializationError("extract")
        ):
            with self.assertRaises(initialize_references.InitializationError):
                initialize_references.initialize(None, True, self.config, self.generated)
        self.assert_existing_survives()

    def test_existing_bundle_survives_build_failure(self):
        with mock.patch.object(initialize_references, "download_pdf", self.fake_download), mock.patch.object(
            initialize_references, "verify_pdf_hash"
        ), mock.patch.object(initialize_references, "run_extractor", self.fake_extract), mock.patch.object(
            initialize_references, "run_builder", side_effect=initialize_references.InitializationError("build")
        ):
            with self.assertRaises(initialize_references.InitializationError):
                initialize_references.initialize(None, True, self.config, self.generated)
        self.assert_existing_survives()

    def test_existing_bundle_survives_validation_failure(self):
        with mock.patch.object(initialize_references, "download_pdf", self.fake_download), mock.patch.object(
            initialize_references, "verify_pdf_hash"
        ), mock.patch.object(initialize_references, "run_extractor", self.fake_extract), mock.patch.object(
            initialize_references, "run_builder", self.fake_build
        ), mock.patch.object(
            initialize_references,
            "validate_bundle",
            side_effect=ReferencesError("references_invalid", "validation"),
        ):
            with self.assertRaises(initialize_references.InitializationError):
                initialize_references.initialize(None, True, self.config, self.generated)
        self.assert_existing_survives()

    def test_success_replaces_existing_bundle_after_validation(self):
        with mock.patch.object(initialize_references, "download_pdf", self.fake_download), mock.patch.object(
            initialize_references, "verify_pdf_hash"
        ), mock.patch.object(initialize_references, "run_extractor", self.fake_extract), mock.patch.object(
            initialize_references, "run_builder", self.fake_build
        ):
            result = initialize_references.initialize(None, True, self.config, self.generated)
        self.assertEqual(result["dictionary_rows"], 2)
        self.assertFalse((self.generated / "sentinel.txt").exists())
        self.assertEqual(validate_bundle(self.generated, self.config)["dictionary_rows"], 2)

    def test_missing_pypdfium2_fails_before_running_the_extractor(self):
        self.dependency_check.side_effect = initialize_references.InitializationError(
            "the 'pypdfium2' package is required. Install it with: python3 -m pip install pypdfium2"
        )
        with mock.patch.object(initialize_references, "download_pdf", self.fake_download), mock.patch.object(
            initialize_references, "verify_pdf_hash"
        ), mock.patch(
            "initialize_references.subprocess.run"
        ) as run:
            with self.assertRaises(initialize_references.InitializationInputError) as raised:
                initialize_references.initialize(None, True, self.config, self.generated)
        self.assertIn("pip install pypdfium2", str(raised.exception))
        run.assert_not_called()
        self.assert_existing_survives()

    def test_local_pdf_does_not_download(self):
        local_pdf = self.root / "source.pdf"
        local_pdf.write_bytes(b"pdf")
        with mock.patch.object(initialize_references, "download_pdf") as download, mock.patch.object(
            initialize_references, "verify_pdf_hash"
        ), mock.patch.object(initialize_references, "run_extractor", self.fake_extract), mock.patch.object(
            initialize_references, "run_builder", self.fake_build
        ):
            initialize_references.initialize(local_pdf, True, self.config, self.generated)
        download.assert_not_called()

    def test_import_installs_a_valid_legacy_bundle_without_extraction(self):
        legacy_root = self.root / "legacy"
        legacy_config, legacy_generated, _ = make_bundle(legacy_root, self.raw)
        (legacy_generated / "unrelated.txt").write_text("do not import", encoding="utf-8")
        self.config.write_bytes(legacy_config.read_bytes())
        with mock.patch.object(initialize_references, "download_pdf") as download, mock.patch.object(
            initialize_references, "run_extractor"
        ) as extract, mock.patch.object(initialize_references, "run_builder") as build:
            result = initialize_references.initialize(
                None, True, self.config, self.generated, import_from=legacy_generated
            )
        download.assert_not_called()
        extract.assert_not_called()
        build.assert_not_called()
        self.assertEqual(result["dictionary_rows"], 2)
        self.assertEqual(validate_bundle(self.generated, self.config)["dictionary_rows"], 2)
        self.assertFalse((self.generated / "unrelated.txt").exists())

    def test_invalid_import_leaves_the_existing_bundle_unchanged(self):
        legacy_root = self.root / "legacy"
        legacy_config, legacy_generated, _ = make_bundle(legacy_root, self.raw)
        self.config.write_bytes(legacy_config.read_bytes())
        (legacy_generated / "manifest.json").unlink()

        with self.assertRaises(initialize_references.InitializationInputError) as raised:
            initialize_references.initialize(
                None, True, self.config, self.generated, import_from=legacy_generated
            )
        self.assertEqual(raised.exception.code, "import_invalid")
        self.assert_existing_survives()

    def test_import_from_and_pdf_are_mutually_exclusive(self):
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            status = initialize_references.main(
                ["--pdf", "source.pdf", "--import-from", "legacy", "--json"]
            )
        self.assertEqual(status, 2)
        error = json.loads(stderr.getvalue())["error"]
        self.assertEqual(error["code"], "invalid_arguments")
        self.assertIn("not allowed", error["condition"])

    def test_invalid_import_reports_that_work_did_not_start(self):
        failure = initialize_references.InitializationInputError(
            "import_invalid", "legacy bundle is invalid", "python3 initialize_references.py"
        )
        with mock.patch.object(initialize_references, "initialize", side_effect=failure), mock.patch(
            "sys.stderr", new_callable=io.StringIO
        ) as stderr:
            status = initialize_references.main(["--import-from", "legacy", "--force"])
        self.assertEqual(status, 2)
        self.assertEqual(
            stderr.getvalue(),
            "ERROR [import_invalid]: legacy bundle is invalid\n"
            "Remedy: python3 initialize_references.py\n",
        )

    def test_preflight_validates_an_import_without_writing(self):
        legacy_root = self.root / "legacy"
        legacy_config, legacy_generated, _ = make_bundle(legacy_root, self.raw)
        self.config.write_bytes(legacy_config.read_bytes())

        result = initialize_references.preflight(
            None, legacy_generated, self.config, self.generated
        )

        self.assertEqual(result["source_mode"], "import")
        self.assertEqual(result["generated_data_location"], str(self.generated.resolve()))
        self.assert_existing_survives()

    def test_json_preflight_does_not_dispatch_initialization(self):
        result = {
            "source_mode": "download",
            "generated_data_location": str(self.generated),
            "source": {"issue": 9},
        }
        with mock.patch.object(initialize_references, "preflight", return_value=result), mock.patch.object(
            initialize_references, "initialize"
        ) as initialize, mock.patch("sys.stdout", new_callable=io.StringIO) as stdout:
            status = initialize_references.main(["--preflight", "--json"])
        self.assertEqual(status, 0)
        initialize.assert_not_called()
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {"status": "ready", "preflight": True, **result},
        )

    def test_json_success_reports_the_installed_artifact(self):
        result = {
            "generated_data_location": str(self.generated),
            "dictionary_rows": 2,
            "dictionary_sha256": "a" * 64,
            "source": {"issue": 9},
        }
        with mock.patch.object(initialize_references, "initialize", return_value=result), mock.patch(
            "sys.stdout", new_callable=io.StringIO
        ) as stdout:
            status = initialize_references.main(["--json"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"status": "ready", **result})

    def test_child_progress_never_contaminates_success_stdout(self):
        completed = subprocess.CompletedProcess(["builder"], 0, stdout="building\n", stderr="")
        with mock.patch("initialize_references.subprocess.run", return_value=completed), mock.patch(
            "sys.stdout", new_callable=io.StringIO
        ) as stdout, mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            initialize_references.run_command(["builder"], "dictionary build")
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "building\n")

    def test_preflight_matches_a_valid_bundle_no_op_without_dependencies(self):
        shutil.rmtree(self.generated)
        config, valid_generated, _ = make_bundle(self.root / "valid", self.raw)
        self.config.write_bytes(config.read_bytes())
        shutil.copytree(valid_generated, self.generated)
        self.dependency_check.side_effect = initialize_references.InitializationError("missing dependency")

        result = initialize_references.preflight(
            None, None, self.config, self.generated
        )

        self.assertEqual(result["source_mode"], "existing")
        self.dependency_check.assert_not_called()

    def test_preflight_and_real_run_match_for_invalid_source_config(self):
        self.config.unlink()

        for action in (
            lambda: initialize_references.preflight(None, None, self.config, self.generated),
            lambda: initialize_references.initialize(None, False, self.config, self.generated),
        ):
            with self.subTest(action=action):
                with self.assertRaises(initialize_references.InitializationInputError) as raised:
                    action()
                self.assertEqual(raised.exception.code, "source_config_invalid")
        self.dependency_check.assert_not_called()


try:
    validate_bundle()
    HAS_GENERATED_BUNDLE = True
except ReferencesError:
    HAS_GENERATED_BUNDLE = False


@unittest.skipUnless(HAS_GENERATED_BUNDLE, "valid local generated bundle is not installed")
class DictionaryIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries, cls.by_headword, cls.approved_forms, cls.unapproved = load_dictionary()

    def test_declared_structure_and_statuses(self):
        self.assertEqual(len(self.entries), 2195)
        self.assertEqual(sum(e["status"] == "approved" for e in self.entries), 878)
        self.assertEqual(sum(e["status"] == "unapproved" for e in self.entries), 1317)
        self.assertIn("use", self.approved_forms)
        self.assertIn("utilize", self.unapproved)

    def test_multiple_parts_of_speech(self):
        parts = {record["part_of_speech"] for record in self.by_headword["clean"]}
        self.assertTrue({"adj", "v"}.issubset(parts))

    def test_inflected_and_irregular_forms(self):
        self.assertIn("writes", self.approved_forms)
        self.assertIn("written", self.approved_forms)
        self.assertNotIn("writing", self.approved_forms)
        self.assertIn("were", self.approved_forms)

    def test_multiple_meanings(self):
        absorb = next(record for record in self.by_headword["absorb"] if record["part_of_speech"] == "v")
        self.assertGreaterEqual(len(absorb["meaning_or_alternatives"]), 2)

    def test_representative_source_pages(self):
        samples = {(record["standard_page"], record["display"]) for record in self.entries}
        self.assertIn(("2-1-A1", "A"), samples)
        self.assertIn(("2-1-M4", "MATT (or MATTE)"), samples)
        self.assertIn(("2-1-W7", "WRITE"), samples)
        self.assertIn(("2-1-I13", "INTERCHANGEABLE"), samples)


class CheckerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.dictionary = Path(cls.temporary.name) / "dictionary.jsonl"
        cls.dictionary.write_bytes(dictionary_bytes(checker_entries()))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def result(self, text, mode="descriptive", terms=None):
        dictionary = load_dictionary(self.dictionary)
        return check_file(
            text, mode, dictionary.by_headword, dictionary.approved_forms,
            dictionary.unapproved, load_terms(terms),
        )

    def sentence(self, count):
        return " ".join(["use"] * count).capitalize() + "."

    def limit_failures(self, result):
        return [item for item in result["findings"] if item["category"] == "long_sentence"]

    def test_procedural_boundaries(self):
        self.assertFalse(self.limit_failures(self.result(self.sentence(19), "procedural")))
        self.assertFalse(self.limit_failures(self.result(self.sentence(20), "procedural")))
        self.assertEqual(len(self.limit_failures(self.result(self.sentence(21), "procedural"))), 1)

    def test_descriptive_boundaries(self):
        self.assertFalse(self.limit_failures(self.result(self.sentence(24), "descriptive")))
        self.assertFalse(self.limit_failures(self.result(self.sentence(25), "descriptive")))
        self.assertEqual(len(self.limit_failures(self.result(self.sentence(26), "descriptive"))), 1)

    def test_paragraph_limit(self):
        text = " ".join(["Use the tool."] * 7)
        finding = next(item for item in self.result(text)["findings"] if item["category"] == "long_paragraph")
        self.assertEqual(finding["source"]["text"], text)
        self.assertEqual(finding["evidence"], {"sentence_count": 7, "limit": 6})

    def test_unapproved_and_unknown_terms(self):
        result = self.result("Utilize the frobnicator.", "procedural")
        word = next(item for item in result["findings"] if item["category"] == "unapproved_word")
        unknown = next(item for item in result["findings"] if item["category"] == "unknown_term")
        self.assertEqual(word["action"]["candidates"], ["A test meaning"])
        self.assertEqual(unknown["evidence"], {"normalized_term": "frobnicator"})

    def test_technical_term_override(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "STE_TERMS.jsonl"
            path.write_text(json.dumps({"term": "frobnicator", "part_of_speech": "technical_noun"}) + "\n")
            result = self.result("Use the frobnicator.", "procedural", path)
        self.assertFalse(any(item["category"] == "unknown_term" for item in result["findings"]))

    def test_multiword_expression_and_term_override(self):
        result = self.result("Prior to the test, use the tool.", "procedural")
        expression = next(item for item in result["findings"] if item["category"] == "unapproved_expression")
        self.assertEqual(expression["source"]["text"], "Prior to")
        self.assertEqual(expression["action"]["type"], "replace")
        self.assertEqual(expression["action"]["candidates"], ["A test meaning"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "STE_TERMS.jsonl"
            path.write_text(json.dumps({"term": "power supply", "part_of_speech": "technical_noun"}) + "\n")
            result = self.result("Disconnect the power supply.", "procedural", path)
        self.assertFalse(any(item["category"] == "unknown_term" for item in result["findings"]))

    def test_markdown_and_exact_text_exclusions(self):
        text = """> The utility will utilize the data.

`someIdentifier` https://example.com/utilize /tmp/utilize --utilize "utilize this"

```python
def someIdentifier():
    return "utilize"
```

Error: unable to utilize someIdentifier
Use the tool.
"""
        text += "> " + " ".join(["utilize"] * 30) + ".\n"
        result = self.result(text, "mixed")
        self.assertFalse(any(item["rule"] == "1.1" for item in result["findings"]))
        self.assertFalse(any(item["category"] == "long_sentence" for item in result["findings"]))

    def test_comments_and_docstrings_preserve_identifiers(self):
        text = """# Use `copyAtomically` to copy the data.
\"\"\"The `copyAtomically` function copies the source data.\"\"\"
"""
        result = self.result(text, "descriptive")
        self.assertFalse(any(item["severity"] == "error" for item in result["findings"]))
        self.assertFalse(any(item["source"]["text"] == "copyAtomically" for item in result["findings"]))

    def test_semicolon_contraction_passive_and_ing(self):
        result = self.result("The unit isn't ready; it is installed. Running continues.")
        categories = {item["category"] for item in result["findings"]}
        self.assertTrue({"contraction", "semicolon", "passive_voice", "unapproved_ing_form"}.issubset(categories))

    def test_contraction_is_not_also_an_unknown_term(self):
        result = self.result("The unit isn't ready.")

        self.assertEqual([item["category"] for item in result["findings"]], ["contraction"])
        self.assertEqual(result["findings"][0]["action"]["candidates"], ["is not"])
        self.assertEqual(result["outcome"], "fail")
        self.assertEqual(result["summary"], {
            "total": 1,
            "errors": 1,
            "warnings": 0,
            "reviews": 0,
            "unique_unknown_terms": 0,
        })

    def test_repeated_contractions_have_separate_exact_spans(self):
        text = "Isn't isn't."
        findings = self.result(text)["findings"]

        self.assertEqual([item["category"] for item in findings], ["contraction", "contraction"])
        self.assertEqual([item["id"] for item in findings], ["F001", "F002"])
        self.assertEqual([item["source"] for item in findings], [
            {
                "text": "Isn't",
                "start": {"offset": 0, "line": 1, "column": 1},
                "end": {"offset": 5, "line": 1, "column": 6},
            },
            {
                "text": "isn't",
                "start": {"offset": 6, "line": 1, "column": 7},
                "end": {"offset": 11, "line": 1, "column": 12},
            },
        ])

    def test_unknown_term_beside_contraction_remains_a_review(self):
        result = self.result("Frobnicator isn't ready.")
        findings = result["findings"]

        self.assertEqual([item["category"] for item in findings], ["unknown_term", "contraction"])
        self.assertEqual([item["id"] for item in findings], ["F001", "F002"])
        self.assertEqual(result["summary"]["reviews"], 1)
        self.assertEqual(result["summary"]["unique_unknown_terms"], 1)

    def test_protected_contractions_do_not_produce_findings(self):
        text = """`isn't` "can't" https://example.com/isn't
> isn't ready
Use the tool.
"""
        result = self.result(text)

        self.assertEqual(result["outcome"], "pass")
        self.assertFalse(result["findings"])

    def test_complete_shape_and_all_category_actions(self):
        text = (
            "Align isn't ready; it is installed. Running blue control panel module works. "
            "Prior to use, utilize frobnicator. " + self.sentence(26) + "\n\n" +
            " ".join(["Use the tool."] * 7)
        )
        result = self.result(text)
        self.assertEqual(set(result), {"mode", "outcome", "summary", "findings"})
        self.assertEqual(
            set(result["summary"]),
            {"total", "errors", "warnings", "reviews", "unique_unknown_terms"},
        )
        self.assertEqual(result["summary"]["total"], len(result["findings"]))
        self.assertNotIn("schema_version", result)
        self.assertNotIn("value", json.dumps(result))
        expected = {
            "semicolon": "rewrite_without_semicolon",
            "contraction": "expand_contraction",
            "long_sentence": "shorten_sentence",
            "long_paragraph": "split_paragraph",
            "unapproved_word": "replace",
            "unapproved_expression": "replace",
            "unapproved_form": "use_approved_form",
            "passive_voice": "review_active_voice",
            "unapproved_ing_form": "review_word_form",
            "long_multiword_noun": "shorten_noun_phrase",
            "unknown_term": "review_terminology",
        }
        actual = {item["category"]: item["action"]["type"] for item in result["findings"]}
        self.assertEqual(actual, expected)
        for item in result["findings"]:
            self.assertEqual(
                set(item),
                {"id", "severity", "rule", "category", "problem", "source", "action", "evidence"},
            )
            self.assertEqual(set(item["source"]), {"text", "start", "end"})
            self.assertEqual(set(item["action"]), {"type", "instruction", "candidates"})
            self.assertIsInstance(item["action"]["candidates"], list)

    def test_exact_single_line_and_multiline_spans(self):
        text = "Use.\nUtilize the tool.\n\n" + " ".join(["Use the tool."] * 7)
        findings = self.result(text)["findings"]
        word = next(item for item in findings if item["category"] == "unapproved_word")
        self.assertEqual(word["source"], {
            "text": "Utilize",
            "start": {"offset": 5, "line": 2, "column": 1},
            "end": {"offset": 12, "line": 2, "column": 8},
        })
        paragraph = next(item for item in findings if item["category"] == "long_paragraph")
        start = text.index("Use the tool.", text.index("\n\n"))
        self.assertEqual(paragraph["source"]["start"], {"offset": start, "line": 4, "column": 1})
        self.assertEqual(paragraph["source"]["end"]["offset"], len(text))
        self.assertEqual(paragraph["source"]["text"], text[start:])

    def test_source_order_ids_and_shared_position_severity(self):
        result = self.result("Running frobnicator; utilize.")
        offsets = [item["source"]["start"]["offset"] for item in result["findings"]]
        self.assertEqual(offsets, sorted(offsets))
        self.assertEqual([item["id"] for item in result["findings"]], [f"F{n:03d}" for n in range(1, len(offsets) + 1)])
        at_start = [item["severity"] for item in result["findings"] if item["source"]["start"]["offset"] == 0]
        self.assertEqual(at_start, ["warning", "review"])

    def test_repeated_unknown_terms_are_not_deduplicated(self):
        result = self.result("Frobnicator uses frobnicator and widget.")
        unknown = [item for item in result["findings"] if item["category"] == "unknown_term"]
        normalized = [item["evidence"]["normalized_term"] for item in unknown]
        self.assertEqual(normalized.count("frobnicator"), 2)
        self.assertEqual(result["summary"]["reviews"], len(unknown))
        self.assertEqual(result["summary"]["unique_unknown_terms"], len(set(normalized)))

    def test_outcomes(self):
        self.assertEqual(self.result("Utilize.")["outcome"], "fail")
        self.assertEqual(self.result("Frobnicator.")["outcome"], "review")
        self.assertEqual(self.result("Use.")["outcome"], "pass")

    def test_word_count_special_cases(self):
        self.assertEqual(count_words("Use tool ABC-123 (if necessary) with 20 mm clearance."), 7)

    def test_hard_wrapped_sentences_match_unwrapped_sentences(self):
        flat = self.sentence(26)
        wrapped = flat.replace(" ", "\n", 5)
        for label, text in (("flat", flat), ("wrapped", wrapped)):
            with self.subTest(label=label):
                result = self.result(text)
                self.assertEqual(
                    [item["evidence"] for item in self.limit_failures(result)],
                    [{"word_count": 26, "limit": 25}],
                )
                self.assertFalse(
                    any(item["category"] == "long_paragraph" for item in result["findings"])
                )

    def test_project_term_protects_an_unapproved_expression_inside_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "STE_TERMS.jsonl"
            path.write_text(json.dumps({"term": "prior to test", "part_of_speech": "technical_noun"}) + "\n")
            result = self.result("Prior to test, use the tool.", "procedural", path)
        self.assertEqual(result["findings"], [])

    def test_inflected_unapproved_word_is_an_error(self):
        result = self.result("The tool utilizes the data.", "procedural")
        self.assertEqual([item["category"] for item in result["findings"]], ["unapproved_word"])
        self.assertEqual(result["outcome"], "fail")

    def test_possessive_of_an_approved_word_is_not_an_unknown_term(self):
        self.assertEqual(self.result("Use the tool's function.", "procedural")["findings"], [])


class SoftwareTerminologyLayerTests(unittest.TestCase):
    """Covers the software-terminology denylist layer added alongside the ASD base
    dictionary. Covered: source attribution, cross-layer precedence, and
    `--layers` gating of unknown_term. Also covered: absence of inflection
    synthesis and schema validation, for both synthetic fixtures and the real
    committed software-terminology.jsonl."""

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.dictionary_path = Path(cls.temporary.name) / "dictionary.jsonl"
        cls.dictionary_path.write_bytes(dictionary_bytes(checker_entries()))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def merged(self, layers=("asd", "software"), software_rows=None):
        dictionary = load_dictionary(self.dictionary_path)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "software-terminology.jsonl"
            path.write_bytes(software_terminology_bytes(software_rows))
            software_entries = load_software_terms(path)
        return merge_layers(dictionary, software_entries, layers)

    def test_overused_term_is_review_severity_and_never_fails_the_outcome(self):
        merged = self.merged()
        result = check_file(
            "You are absolutely right, use the tool.", "descriptive",
            merged.by_headword, merged.approved_forms, merged.unapproved, {},
        )
        finding = next(item for item in result["findings"] if item["category"] == "overused_term")
        self.assertEqual(finding["severity"], "review")
        self.assertEqual(finding["evidence"], {"source": "software_terms"})
        self.assertEqual(result["outcome"], "review")
        self.assertEqual(result["summary"]["errors"], 0)

    def test_source_attribution_per_layer(self):
        merged = self.merged()
        result = check_file(
            "Utilize the tool. You are absolutely right about it.", "descriptive",
            merged.by_headword, merged.approved_forms, merged.unapproved, {},
        )
        word = next(item for item in result["findings"] if item["category"] == "unapproved_word")
        tic = next(item for item in result["findings"] if item["category"] == "overused_term")
        self.assertEqual(word["evidence"]["source"], "asd_ste_terms")
        self.assertEqual(tic["evidence"]["source"], "software_terms")

    def test_project_term_shields_a_software_tic(self):
        merged = self.merged()
        terms = {"you are absolutely right": {"term": "you are absolutely right", "part_of_speech": "technical_noun"}}
        result = check_file(
            "You are absolutely right is our project's glossary term.", "descriptive",
            merged.by_headword, merged.approved_forms, merged.unapproved, terms,
        )
        self.assertFalse(any(item["category"] == "overused_term" for item in result["findings"]))

    def test_software_entry_outranks_an_asd_entry_on_the_same_key(self):
        merged = self.merged(software_rows=[software_term("utilize", part="v")])
        self.assertEqual(len(merged.unapproved["utilize"]), 1)
        self.assertEqual(merged.unapproved["utilize"][0]["source"], "software_terms")
        result = check_file(
            "Utilize the tool.", "descriptive",
            merged.by_headword, merged.approved_forms, merged.unapproved, {},
        )
        finding = next(item for item in result["findings"] if item["source"]["text"] == "Utilize")
        self.assertEqual(finding["category"], "overused_term")

    def test_layers_software_only_suppresses_unknown_term(self):
        text = "Frobnicate the qux."
        merged_all = self.merged(layers=("asd", "software"))
        merged_software = self.merged(layers=("software",))
        result_all = check_file(
            text, "descriptive", merged_all.by_headword, merged_all.approved_forms, merged_all.unapproved, {},
            report_unknown_terms=True,
        )
        result_software = check_file(
            text, "descriptive", merged_software.by_headword, merged_software.approved_forms,
            merged_software.unapproved, {}, report_unknown_terms=False,
        )
        self.assertTrue(any(item["category"] == "unknown_term" for item in result_all["findings"]))
        self.assertFalse(any(item["category"] == "unknown_term" for item in result_software["findings"]))

    def test_no_inflection_synthesis_for_software_entries(self):
        merged = self.merged(software_rows=[software_term("wire", part="v")])
        self.assertIn("wire", merged.unapproved)
        self.assertNotIn("wiring", merged.unapproved)
        self.assertNotIn("wired", merged.unapproved)
        self.assertNotIn("wires", merged.unapproved)

    def test_by_headword_carries_software_entries_for_lookup(self):
        merged = self.merged()
        self.assertIn("you're absolutely right", merged.by_headword)

    def test_load_software_terms_rejects_a_missing_required_field(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "software-terminology.jsonl"
            row = software_term("delve")
            del row["rationale"]
            path.write_bytes((json.dumps(row) + "\n").encode())
            with self.assertRaises(ValueError):
                load_software_terms(path)

    def test_load_software_terms_rejects_a_non_unapproved_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "software-terminology.jsonl"
            row = software_term("delve")
            row["status"] = "approved"
            path.write_bytes((json.dumps(row) + "\n").encode())
            with self.assertRaises(ValueError):
                load_software_terms(path)

    def test_load_software_terms_rejects_a_form_claimed_by_two_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "software-terminology.jsonl"
            rows = [software_term("delve"), software_term("dig in", forms=["delve"])]
            path.write_bytes(software_terminology_bytes(rows))
            with self.assertRaises(ValueError):
                load_software_terms(path)

    def test_committed_software_terminology_file_is_schema_valid(self):
        entries = load_software_terms()
        self.assertGreater(len(entries), 0)
        seen_keys = set()
        for record in entries:
            self.assertEqual(record["status"], "unapproved")
            self.assertIn(record["part_of_speech"], ste_data.VALID_PARTS)
            self.assertEqual(record["source"], "software_terms")
            self.assertTrue(record["meaning_or_alternatives"])
            self.assertTrue(record["flagged_sense"])
            self.assertTrue(record["rationale"])
            self.assertTrue(record["attestation"])
            self.assertTrue(record["models"])
            for form in record["forms"]:
                key = form.casefold()
                self.assertNotIn(key, seen_keys, f"{form!r} is claimed by more than one entry")
                seen_keys.add(key)


if __name__ == "__main__":
    unittest.main()
