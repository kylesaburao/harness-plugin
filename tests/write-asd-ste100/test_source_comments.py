#!/usr/bin/env python3
"""Comment-only checking of Python, JavaScript, and TypeScript source inputs.

Expected positions are written out by hand or located with str.index on the
fixture text, never obtained from the extractor under test.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest import mock

from plugin_paths import SCRIPTS
from test_ste_tools import (
    RUNTIME_MODULES,
    SKILL_PACKAGE_FILES,
    checker_entries,
    dictionary_bytes,
    make_bundle,
    run_result,
    software_terminology_bytes,
)

ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import ste_check
import ste_source
from ste_cli import InvocationError
from ste_data import generated_bundle_path, load_dictionary

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "source-comments"
# Captured before any test points HOME at a temporary directory.
REAL_DEPENDENCY_ROOT = Path.home() / ".harness-plugin" / "write-asd-ste100"
NODE = shutil.which("node")


def parser_ready() -> bool:
    if NODE is None or not ste_source.JS_HELPER.is_file():
        return False
    probe = subprocess.run(
        [NODE, str(ste_source.JS_HELPER), "--preflight", "--json"], capture_output=True, text=True, check=False,
    )
    return probe.returncode == 0


PARSER_READY = parser_ready()
requires_parser = unittest.skipUnless(
    PARSER_READY, "the JavaScript comment parser is not installed; run npm run test:setup",
)


class Vocabulary:
    temporary = tempfile.TemporaryDirectory()
    path = Path(temporary.name) / "dictionary.jsonl"
    path.write_bytes(dictionary_bytes(checker_entries()))
    dictionary = load_dictionary(path)


def source_result(text: str, path: str, mode: str = "descriptive", input_format: str = "auto",
                  report_unknown_terms: bool = False) -> dict:
    spec = ste_source.resolve_inputs([path], input_format)[0]
    [analysis] = ste_source.prepare_sources([(spec, text)])
    dictionary = Vocabulary.dictionary
    return ste_check.check_source(
        text, analysis, mode, dictionary.by_headword, dictionary.approved_forms, dictionary.unapproved, {},
        report_unknown_terms=report_unknown_terms,
    )


def prose_result(text: str, mode: str = "descriptive") -> dict:
    dictionary = Vocabulary.dictionary
    return ste_check.check_file(
        text, mode, dictionary.by_headword, dictionary.approved_forms, dictionary.unapproved, {},
        report_unknown_terms=False,
    )


def summary(result: dict) -> list[tuple[str, str, int, int]]:
    return [
        (item["category"], item["source"]["text"], item["source"]["start"]["line"], item["source"]["start"]["column"])
        for item in result["findings"]
    ]


def categories(result: dict) -> list[str]:
    return [item["category"] for item in result["findings"]]


def analysis_of(text: str, path: str) -> ste_source.SourceAnalysis:
    spec = ste_source.resolve_inputs([path], "auto")[0]
    [analysis] = ste_source.prepare_sources([(spec, text)])
    return analysis


def marked_comment_characters(text: str, markers: tuple[str, ...]) -> set[int]:
    """Comment offsets of a fixture whose comment markers appear nowhere else.

    A line marker runs to the end of its line, and "/*" runs through "*/".
    This deliberately simple scan is independent of the extractor under test.
    """
    characters: set[int] = set()
    index = 0
    while index < len(text):
        starts = [(text.find(marker, index), marker) for marker in markers]
        starts = [(start, marker) for start, marker in starts if start >= 0]
        if not starts:
            break
        start, marker = min(starts)
        end = text.index("*/", start) + 2 if marker == "/*" else text.find("\n", start)
        end = len(text) if end < 0 else end
        characters.update(range(start, end))
        index = end
    return characters


class InputRoutingTests(unittest.TestCase):
    def resolve(self, path: str, requested: str = "auto") -> ste_source.InputSpec:
        [spec] = ste_source.resolve_inputs([path], requested)
        return spec

    def test_every_supported_suffix_selects_its_format_and_profile(self):
        def profile(typescript=False, jsx=False, source_type="unambiguous", declaration=False, disallow=False):
            return {"typescript": typescript, "jsx": jsx, "sourceType": source_type,
                    "declaration": declaration, "disallowAmbiguousJsxLike": disallow}

        expected = {
            "a.py": ("python", None),
            "a.pyi": ("python", None),
            "a.js": ("javascript", profile()),
            "a.mjs": ("javascript", profile(source_type="module")),
            "a.cjs": ("javascript", profile(source_type="commonjs")),
            "a.jsx": ("jsx", profile(jsx=True)),
            "a.ts": ("typescript", profile(typescript=True)),
            "a.mts": ("typescript", profile(typescript=True, source_type="module", disallow=True)),
            "a.cts": ("typescript", profile(typescript=True, disallow=True)),
            "a.tsx": ("tsx", profile(typescript=True, jsx=True)),
            "a.d.ts": ("typescript", profile(typescript=True, declaration=True)),
            "a.d.mts": ("typescript", profile(typescript=True, source_type="module", declaration=True, disallow=True)),
            "a.d.cts": ("typescript", profile(typescript=True, declaration=True, disallow=True)),
            "A.D.TS": ("typescript", profile(typescript=True, declaration=True)),
            "dir.py/notes.md": ("prose", None),
            "a.markdown": ("prose", None),
            "a.TXT": ("prose", None),
        }
        for path, (input_format, parser_profile) in expected.items():
            with self.subTest(path=path):
                spec = self.resolve(path)
                self.assertEqual((spec.input_format, spec.profile), (input_format, parser_profile))

    def test_unknown_names_and_standard_input_require_an_explicit_format(self):
        with self.assertRaises(InvocationError) as raised:
            ste_source.resolve_inputs(["a.md", "Makefile", "a.rs", "-"], "auto")
        error = raised.exception
        self.assertEqual(error.code, "input_format_required")
        self.assertEqual([item["path"] for item in error.inputs], ["Makefile", "a.rs", "-"])
        self.assertIn("--input-format", error.remedy)

    def test_explicit_formats_override_and_keep_same_family_hints(self):
        self.assertEqual(self.resolve("a.js", "jsx").profile["jsx"], True)
        self.assertEqual(self.resolve("a.mjs", "jsx").profile["sourceType"], "module")
        module = self.resolve("a.mts", "tsx").profile
        self.assertEqual((module["sourceType"], module["jsx"], module["disallowAmbiguousJsxLike"]), ("module", True, False))
        self.assertEqual(self.resolve("a.mts", "javascript").profile["sourceType"], "unambiguous")
        self.assertEqual(self.resolve("Makefile", "python").input_format, "python")
        self.assertEqual(self.resolve("-", "typescript").profile["typescript"], True)
        self.assertEqual(self.resolve("-", "prose").input_format, "prose")
        self.assertEqual(self.resolve("notes", "prose").input_format, "prose")
        self.assertEqual(self.resolve("a.md", "prose").input_format, "prose")

    def test_explicit_prose_is_rejected_for_a_recognized_source_file(self):
        for path in ("a.py", "a.ts", "a.d.cts"):
            with self.subTest(path=path), self.assertRaises(InvocationError) as raised:
                ste_source.resolve_inputs([path], "prose")
            self.assertEqual(raised.exception.code, "usage_error")


class PythonExtractionTests(unittest.TestCase):
    def test_only_the_real_comment_reaches_the_rules(self):
        text = (
            'utilize = "Utilize it; don\'t."  # Utilize it; don\'t.\n'
            "def utilize_data(): return utilize\n"
        )
        result = source_result(text, "a.py")
        comment = text.index("# ")
        self.assertEqual(summary(result), [
            ("unapproved_word", "Utilize", 1, comment + 3),
            ("semicolon", ";", 1, comment + 13),
            ("contraction", "don't", 1, comment + 15),
        ])
        self.assertEqual([item["source"]["start"]["offset"] for item in result["findings"]],
                         [comment + 2, comment + 12, comment + 14])
        self.assertEqual(result["analysis"], {
            "inputFormat": "python", "scope": "comments", "commentCount": 1, "regionCount": 1, "skipped": [],
        })

    def test_strings_docstrings_and_literal_hashes_are_excluded(self):
        text = (
            '"""Utilize the module; don\'t."""\n'
            "def f():\n"
            "    '''Utilize the function.'''\n"
            "    a = r'# utilize; raw'\n"
            "    b = b'# utilize; bytes'\n"
            '    c = """\n'
            "    # utilize; multiline\n"
            '    """\n'
            "    d = 'escaped \\' # utilize; quote'\n"
            "    return a  # Use the tool"
        )
        result = source_result(text, "a.py")
        self.assertEqual(result["findings"], [])
        self.assertEqual((result["analysis"]["commentCount"], result["analysis"]["regionCount"]), (1, 1))

    @unittest.skipUnless(sys.version_info >= (3, 12), "PEP 701 comments need Python 3.12")
    def test_f_string_text_is_excluded_and_replacement_comments_are_included(self):
        text = (
            'value = f"""Utilize; {\n'
            "    1  # Utilize the value.\n"
            '} utilize; text"""\n'
        )
        result = source_result(text, "a.py")
        self.assertEqual(summary(result), [("unapproved_word", "Utilize", 2, 10)])

    def test_malformed_python_fails_without_partial_results_or_warnings(self):
        cases = {
            "unclosed string": 'x = "abc\n# Utilize.\n',
            "unclosed bracket": "x = (1,\n# Utilize.\n",
            "bad indentation": "if x:\nprint(1)\n# Utilize.\n",
            "nul": "x = 1\x00\n# Utilize.\n",
            "newer grammar": "match = 1\nx = (yield) from\n",
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                spec = ste_source.resolve_inputs(["bad.py"], "auto")[0]
                with warnings.catch_warnings(record=True) as caught, \
                        mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                    warnings.simplefilter("always")
                    with self.assertRaises(InvocationError) as raised:
                        ste_source.prepare_sources([(spec, text)])
                self.assertEqual(raised.exception.code, "source_parse_failed")
                self.assertEqual(raised.exception.status, 2)
                [failure] = raised.exception.inputs
                self.assertEqual((failure["path"], failure["inputFormat"]), ("bad.py", "python"))
                self.assertEqual(stderr.getvalue(), "")
                self.assertEqual(caught, [])

    def test_invalid_escape_warnings_do_not_leak(self):
        text = 'x = "\\d"  # Use the tool.\n'
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = source_result(text, "a.py")
        self.assertEqual(caught, [])
        self.assertEqual(result["findings"], [])

    def test_source_mode_requires_python_3_12(self):
        ste_source.check_python_runtime((3, 12, 0))
        with self.assertRaises(InvocationError) as raised:
            ste_source.check_python_runtime((3, 11, 9))
        error = raised.exception
        self.assertEqual(error.code, "python_version_unsupported")
        self.assertEqual(error.details, {"requiredVersion": "3.12", "foundVersion": "3.11.9"})

    def test_checker_rejects_python_source_on_an_old_interpreter_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "a.py"
            source.write_text("# Use the tool.\n", encoding="utf-8")
            with mock.patch.object(ste_check, "ensure_references_loaded", return_value=({}, [])), \
                    mock.patch.object(ste_check, "load_dictionary", return_value=Vocabulary.dictionary), \
                    mock.patch.object(ste_check, "load_software_terms", return_value=[]), \
                    mock.patch.object(ste_source, "MINIMUM_PYTHON", (99, 0)), \
                    mock.patch.object(ste_source, "python_comment_spans") as extract, \
                    mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                status = ste_check.main([str(source), "--mode", "procedural", "--json"])
        self.assertEqual(status, 2)
        extract.assert_not_called()
        self.assertEqual(json.loads(stderr.getvalue())["error"]["code"], "python_version_unsupported")


class RegionBoundaryTests(unittest.TestCase):
    def sentence(self, count: int) -> str:
        return " ".join(["use"] * count).capitalize()

    def test_comments_separated_by_code_never_form_one_sentence(self):
        half = self.sentence(15)
        text = f"# {half}\nx = 1\n# {half}.\n"
        self.assertNotIn("long_sentence", categories(source_result(text, "a.py")))
        text = f"# {half}\n# {half}.\n"
        self.assertIn("long_sentence", categories(source_result(text, "a.py")))

    def test_trailing_comments_are_never_merged(self):
        half = self.sentence(15)
        text = f"x = 1  # {half}\ny = 2  # {half}.\n"
        self.assertNotIn("long_sentence", categories(source_result(text, "a.py")))
        text = "x = 1  # The unit is\ny = 2  # installed.\n"
        self.assertNotIn("passive_voice", categories(source_result(text, "a.py")))
        self.assertIn("passive_voice", categories(source_result("# The unit is\n# installed.\n", "a.py")))

    def test_runs_need_consecutive_lines_and_the_same_indentation_and_marker(self):
        half = self.sentence(15)
        for text in (
            f"# {half}\n\n# {half}.\n",
            f"# {half}\n    # {half}.\n",
            f"# {half}\n## {half}.\n",
            f"# {half}\n# noqa\n# {half}.\n",
        ):
            with self.subTest(text=text):
                self.assertNotIn("long_sentence", categories(source_result(text, "a.py")))

    @requires_parser
    def test_block_comments_on_one_line_stay_separate(self):
        half = self.sentence(15)
        text = f"/* {half} */ x = 1; /* {half}. */\n"
        result = source_result(text, "a.js")
        self.assertNotIn("long_sentence", categories(result))
        self.assertEqual(result["analysis"]["regionCount"], 2)
        text = "const a = 1; /* The unit is */ /* installed. */\n"
        self.assertNotIn("passive_voice", categories(source_result(text, "a.js")))

    def test_comment_only_blank_lines_separate_paragraphs(self):
        seven = "".join(f"# Use the tool {number}.\n" for number in range(7))
        self.assertIn("long_paragraph", categories(source_result(seven, "a.py")))
        split = seven.replace("# Use the tool 3.\n", "# Use the tool 3.\n#\n")
        self.assertNotIn("long_paragraph", categories(source_result(split, "a.py")))

    def test_an_unclosed_fence_affects_only_its_own_region(self):
        text = "# ```\n# Utilize it.\nx = 1\n# Utilize it.\n"
        self.assertEqual(summary(source_result(text, "a.py")), [("unapproved_word", "Utilize", 4, 3)])

    def assert_only_comments_are_checked(self, path: str, markers: tuple[str, ...]) -> None:
        text = (FIXTURES / path).read_text(encoding="utf-8")
        comments = marked_comment_characters(text, markers)
        # Every nonblank character the rules can see lies inside a comment.
        for region in analysis_of(text, path).regions:
            visible = [region.start + index for index, character in enumerate(region.masked_text)
                       if not character.isspace()]
            self.assertEqual([index for index in visible if index not in comments], [], region)
        result = source_result(text, path, report_unknown_terms=True)
        self.assertGreater(len(result["findings"]), 10)
        for item in result["findings"]:
            covered = range(item["source"]["start"]["offset"], item["source"]["end"]["offset"])
            outside = [index for index in covered if index not in comments and not text[index].isspace()]
            self.assertEqual(outside, [], item)

    def test_python_regions_and_findings_hold_only_comment_text(self):
        self.assert_only_comments_are_checked("mixed.py", ("#",))

    @requires_parser
    def test_typescript_regions_and_findings_hold_only_comment_text(self):
        self.assert_only_comments_are_checked("mixed.ts", ("//", "/*"))

    @requires_parser
    def test_a_line_comment_ended_by_a_unicode_line_separator_never_joins_code(self):
        for separator in ("\u2028", "\u2029"):
            with self.subTest(separator=hex(ord(separator))):
                text = f"// Use the unit{separator} utilize(); x = 1;\n// Use the tool.\n"
                result = source_result(text, "a.js")
                self.assertEqual(categories(result), [])
                regions = analysis_of(text, "a.js").regions
                self.assertEqual([region.masked_text.strip() for region in regions], ["Use the unit", "Use the tool."])

    @requires_parser
    def test_unusual_indentation_still_forms_a_run(self):
        for indent in ("\u00a0\u00a0", "\v"):
            with self.subTest(indent=repr(indent)):
                text = f"{indent}// The unit is\n{indent}// installed.\n"
                self.assertIn("passive_voice", categories(source_result(text, "a.js")))

    def test_a_byte_order_mark_does_not_split_the_first_run(self):
        self.assertIn("passive_voice", categories(source_result("\ufeff# The unit is\n# installed.\n", "a.py")))
        self.assertEqual(len(analysis_of("\ufeff# The unit is\n# installed.\n", "a.py").regions), 1)
        if PARSER_READY:
            self.assertIn("passive_voice", categories(source_result("\ufeff// The unit is\n// installed.\n", "a.js")))


class DirectiveTests(unittest.TestCase):
    def test_python_directives_are_skipped_whole(self):
        text = (
            "#!/usr/bin/env python3\n"
            "# -*- coding: utf-8 -*-\n"
            "x = 1  # type: ignore  utilize\n"
            "y = 2  # noqa: E501 utilize\n"
            "z = 3  # NOQA\n"
            "# ruff: noqa: F401 utilize\n"
            "# pylint: disable=invalid-name utilize\n"
            "# mypy: ignore-errors utilize\n"
            "# pyright: basic utilize\n"
            "# fmt: off utilize\n"
            "# isort: skip_file utilize\n"
            "# SPDX-License-Identifier: MIT utilize\n"
        )
        result = source_result(text, "a.py")
        self.assertEqual(result["findings"], [])
        analysis = result["analysis"]
        self.assertEqual((analysis["commentCount"], analysis["regionCount"]), (12, 0))
        self.assertEqual([item["reason"] for item in analysis["skipped"]], ["tool_directive"] * 11 + ["license"])

    def test_encoding_declarations_follow_pep_263_placement(self):
        for text in ("# vim: set fileencoding=utf-8 : utilize\n", "#!/usr/bin/env python3\n# coding=utf-8 utilize\n",
                     "\n# -*- coding: latin-1 -*- utilize\n"):
            with self.subTest(text=text):
                result = source_result(text, "a.py")
                self.assertEqual(result["findings"], [])
                self.assertEqual(result["analysis"]["regionCount"], 0)

    def test_a_directive_name_in_an_ordinary_sentence_stays_checkable(self):
        for text in ("# noqa markers utilize the linter.\n", "# Use the type: utilize it.\n",
                     "x = 1\ny = 2\n# -*- coding: utf-8 -*- utilize\n",
                     "x = 1  # -*- coding: utf-8 -*- utilize\n",
                     "x = 1\n# -*- coding: utf-8 -*- utilize\n",
                     "# The decoding: step and encoding: step utilize it.\n"):
            with self.subTest(text=text):
                self.assertIn("unapproved_word", categories(source_result(text, "a.py")))

    @requires_parser
    def test_javascript_family_directives_are_skipped_whole(self):
        text = (
            "#!/usr/bin/env node\n"
            "// @ts-check utilize\n"
            "/// <reference types=\"node\" /> utilize\n"
            "/// <amd-module name=\"utilize\" />\n"
            "// eslint-disable-next-line no-console -- utilize\n"
            "/* eslint-disable utilize */\n"
            "/* eslint no-console: off */\n"
            "// prettier-ignore utilize\n"
            "/* istanbul ignore next utilize */\n"
            "/* c8 ignore next 3 */\n"
            "const a = /* @__PURE__ */ f(); // @ts-expect-error utilize\n"
            "const b = /*#__PURE__*/ f(); // @ts-ignore utilize\n"
            "// @ts-nocheck\n"
            "//# sourceMappingURL=utilize.js.map\n"
            "/*# sourceURL=utilize.js */\n"
        )
        result = source_result(text, "a.ts")
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["analysis"]["regionCount"], 0)
        self.assertEqual({item["reason"] for item in result["analysis"]["skipped"]}, {"tool_directive"})
        self.assertEqual(len(result["analysis"]["skipped"]), result["analysis"]["commentCount"])

    @requires_parser
    def test_todo_labels_are_masked_and_their_explanation_is_checked(self):
        result = source_result("// TODO: Utilize the cache.\n// FIXME utilize it.\n", "a.js")
        self.assertEqual(summary(result), [("unapproved_word", "Utilize", 1, 10), ("unapproved_word", "utilize", 2, 10)])


@requires_parser
class DocumentationCommentTests(unittest.TestCase):
    def test_descriptions_are_checked_and_scaffolding_is_preserved(self):
        lines = [
            "/**",
            " * Utilize the cache.",
            " * @param {Utilize<string>} utilize - Utilize the name.",
            " * @param [utilize=\"x}\"] Utilize the default.",
            " * @returns {Utilize} Utilize the result.",
            " * @deprecated Utilize the new function.",
            " */",
            "function utilize(utilize) { return utilize; }",
        ]
        result = source_result("\n".join(lines) + "\n", "a.js")
        expected = [
            ("unapproved_word", "Utilize", number, lines[number - 1].index("Utilize the") + 1)
            for number in range(2, 7)
        ]
        self.assertEqual(summary(result), expected)
        self.assertEqual(result["analysis"]["regionCount"], 5)

    def test_tag_sections_never_form_one_sentence(self):
        half = " ".join(["use"] * 15)
        text = f"/**\n * @param a - {half}\n * @param b - {half}.\n */\nfunction f(a, b) {{}}\n"
        self.assertNotIn("long_sentence", categories(source_result(text, "a.js")))

    def test_examples_unknown_tags_and_malformed_scaffolding_are_skipped_visibly(self):
        text = (
            "/**\n"
            " * Use the tool.\n"
            " * @example\n"
            " * utilize(); // utilize\n"
            " * @since 1.0 utilize\n"
            " * @param {string name - utilize\n"
            " * @license MIT utilize\n"
            " */\n"
            "function f() {}\n"
        )
        result = source_result(text, "a.js")
        self.assertEqual(result["findings"], [])
        skipped = [(item["reason"], item["source"]["start"]["line"], item["source"]["end"]["line"])
                   for item in result["analysis"]["skipped"]]
        self.assertEqual(skipped, [
            ("doc_example", 3, 4),
            ("unsupported_doc_tag", 5, 5),
            ("unsupported_doc_structure", 6, 6),
            ("license", 7, 7),
        ])
        self.assertEqual(result["analysis"]["skipped"][0]["source"]["end"]["column"], 25)

    def test_tag_looking_lines_inside_fences_do_not_open_sections(self):
        text = (
            "/**\n"
            " * Use the tool:\n"
            " * ```js\n"
            " * @param utilize\n"
            " * ```\n"
            " * Utilize the cache.\n"
            " */\n"
            "function f() {}\n"
        )
        result = source_result(text, "a.js")
        self.assertEqual(summary(result), [("unapproved_word", "Utilize", 6, 4)])
        self.assertEqual(result["analysis"]["skipped"], [])

    def test_inline_documentation_links_are_preserved(self):
        result = source_result("/** Use {@link utilize the utilize} with the tool. */\nconst x = 1;\n", "a.js")
        self.assertEqual(result["findings"], [])

    def test_an_apostrophe_in_link_text_keeps_the_section_checkable(self):
        text = "/**\n * See {@link Foo|the parser's options} to utilize it.\n */\nconst x = 1;\n"
        result = source_result(text, "a.js")
        self.assertEqual(summary(result), [("unapproved_word", "utilize", 2, text.splitlines()[1].index("utilize") + 1)])
        self.assertEqual(result["analysis"]["skipped"], [])


@requires_parser
class JavaScriptFamilyExtractionTests(unittest.TestCase):
    def test_lexical_boundaries(self):
        text = (
            "const a = 'utilize; // no', b = \"/* utilize; */\";\n"
            "const r = /\\/\\/ utilize; [/*]/g, d = a / 2 / 1; // Utilize it.\n"
            "const t = `utilize; // ${`nested ${/* Utilize this. */ 1} // no`} \\` // no`;\n"
        )
        result = source_result(text, "a.js")
        lines = text.splitlines()
        self.assertEqual(summary(result), [
            ("unapproved_word", "Utilize", 2, lines[1].index("Utilize it") + 1),
            ("unapproved_word", "Utilize", 3, lines[2].index("Utilize this") + 1),
        ])

    def test_typescript_profiles(self):
        cases = {
            "a.ts": "const x = <number>y; // Utilize it.\nlet z: Map<string, number[]> = new Map(); // Use it.\n",
            "a.d.ts": "declare const x: number; // Utilize it.\nexport {};\n",
            "a.mts": "import x from 'y'; // Utilize it.\nexport const z = x as number;\n",
            "a.cts": "import x = require('y'); // Utilize it.\nexport = x;\n",
            "b.cts": "import x from 'y'; // Utilize it.\nexport const z = x;\n",
            "a.d.cts": "export declare function f(): void; // Utilize it.\n",
            "a.cjs": "const x = require('y'); // Utilize it.\nreturn;\n",
            "a.js": "module.exports = 1; // Utilize it.\nreturn;\n",
            "a.mjs": "export const x = 1; // Utilize it.\n",
        }
        for path, text in cases.items():
            with self.subTest(path=path):
                self.assertEqual(summary(source_result(text, path))[0][:3], ("unapproved_word", "Utilize", 1))

    def test_jsx_text_and_attributes_are_excluded(self):
        text = (
            "const e = <div title=\"utilize; it\">\n"
            "  utilize; // not a comment\n"
            "  {/* Utilize the value. */}\n"
            "  {value /* Utilize this. */}\n"
            "</div>;\n"
        )
        for path, input_format in (("a.jsx", "auto"), ("a.tsx", "auto"), ("a.js", "jsx")):
            with self.subTest(path=path):
                result = source_result(text, path, input_format=input_format)
                self.assertEqual(summary(result), [("unapproved_word", "Utilize", 3, 7), ("unapproved_word", "Utilize", 4, 13)])

    def test_unsupported_syntax_fails_instead_of_being_guessed(self):
        cases = {
            "a.ts": "@decorator class A {}\n",
            "a.js": "<!-- utilize\nx = 1;\n",
            "a.mts": "const x = <number>y;\n",
            "a.mjs": "return 1;\n",
            "c.ts": "const e = <div />;\n",
            "d.js": "const x: number = 1;\n",
        }
        for path, text in cases.items():
            with self.subTest(path=path):
                spec = ste_source.resolve_inputs([path], "auto")[0]
                with self.assertRaises(InvocationError) as raised:
                    ste_source.prepare_sources([(spec, text)])
                self.assertEqual(raised.exception.code, "source_parse_failed")
                [failure] = raised.exception.inputs
                self.assertEqual(failure["path"], path)
                self.assertIn("line", failure)

    def test_one_helper_process_serves_a_mixed_batch_and_failures_keep_caller_order(self):
        inputs = [
            (ste_source.resolve_inputs(["b.ts"], "auto")[0], "const = ;\n"),
            (ste_source.resolve_inputs(["a.py"], "auto")[0], "x = (\n"),
            (ste_source.resolve_inputs(["c.js"], "auto")[0], "// Use it.\n"),
            (ste_source.resolve_inputs(["d.jsx"], "auto")[0], "<a>\n"),
        ]
        real_run = subprocess.run
        with mock.patch.object(ste_source.subprocess, "run", side_effect=real_run) as run:
            with self.assertRaises(InvocationError) as raised:
                ste_source.prepare_sources(inputs)
        self.assertEqual(run.call_count, 1)
        self.assertEqual([item["path"] for item in raised.exception.inputs], ["b.ts", "a.py", "d.jsx"])

    def test_check_never_executes_or_changes_the_source_in_a_configured_project(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / "babel.config.js").write_text("throw new Error('configuration loaded');\n", encoding="utf-8")
            (project / "package.json").write_text('{"type":"module","babel":{"plugins":["x"]}}\n', encoding="utf-8")
            marker = project / "executed"
            source = project / "a.js"
            source.write_bytes(
                f"require('fs').writeFileSync({json.dumps(str(marker))}, 'x'); // Utilize it.\n".encode()
            )
            before = source.read_bytes()
            spec = ste_source.resolve_inputs([str(source)], "auto")[0]
            previous = os.getcwd()
            os.chdir(project)
            try:
                [analysis] = ste_source.prepare_sources([(spec, source.read_text(encoding="utf-8"))])
            finally:
                os.chdir(previous)
            self.assertEqual(analysis.comment_count, 1)
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse(marker.exists())


class CoordinateTests(unittest.TestCase):
    def test_python_positions_after_tabs_accents_and_astral_characters(self):
        text = "if True:\n\tvalué = '😀😀'  # é Utilize\n"
        [finding] = source_result(text, "a.py")["findings"]
        self.assertEqual(finding["source"], {
            "text": "Utilize",
            "start": {"offset": 28, "line": 2, "column": 20},
            "end": {"offset": 35, "line": 2, "column": 27},
        })

    @requires_parser
    def test_javascript_utf16_offsets_become_python_offsets(self):
        text = "const s = '😀😀\u2028x'; /* 😀 Utilize */ // Use 😀 it; now\n"
        result = source_result(text, "a.js")
        self.assertEqual([item["source"] for item in result["findings"]], [
            {"text": "Utilize", "start": {"offset": 23, "line": 1, "column": 24},
             "end": {"offset": 30, "line": 1, "column": 31}},
            {"text": ";", "start": {"offset": 45, "line": 1, "column": 46},
             "end": {"offset": 46, "line": 1, "column": 47}},
        ])

    @requires_parser
    def test_byte_order_mark_before_a_hashbang(self):
        text = "\ufeff#!/usr/bin/env node\n// Utilize it.\n"
        [finding] = source_result(text, "a.js")["findings"]
        self.assertEqual(finding["source"]["start"], {"offset": 24, "line": 2, "column": 4})
        python = "\ufeff# Utilize it.\n"
        [finding] = source_result(python, "a.py")["findings"]
        self.assertEqual(finding["source"]["start"], {"offset": 3, "line": 1, "column": 4})

    def test_final_line_without_a_newline(self):
        [finding] = source_result("x = 1\n# Utilize", "a.py")["findings"]
        self.assertEqual(finding["source"]["start"], {"offset": 8, "line": 2, "column": 3})

    def test_utf16_conversion(self):
        text = "a😀b"
        self.assertEqual(ste_source.utf16_to_code_points(text, [0, 1, 3, 4]), {0: 0, 1: 1, 3: 2, 4: 3})
        for invalid in (2, 5):
            with self.subTest(offset=invalid), self.assertRaises(ValueError):
                ste_source.utf16_to_code_points(text, [invalid])

    def test_cross_language_invariance(self):
        prose = "The unit is installed. Utilize the tool; don't run it.\n"
        expected = [(item["category"], item["severity"], item["action"]) for item in prose_result(prose)["findings"]]
        python = "".join(f"# {line}\n" for line in prose.splitlines())
        actual = [(item["category"], item["severity"], item["action"])
                  for item in source_result(python, "a.py")["findings"]]
        self.assertEqual(actual, expected)
        self.assertTrue(expected)


class EmptyCoverageTests(unittest.TestCase):
    def test_counts_for_inputs_without_checkable_prose(self):
        for text, counts in (("", (0, 0, 0)), ("x = 1\n", (0, 0, 0)), ("# noqa\nx = 1  # type: int\n", (2, 0, 2)),
                             ("#\n", (1, 0, 0))):
            with self.subTest(text=text):
                result = source_result(text, "a.py")
                analysis = result["analysis"]
                self.assertEqual((analysis["commentCount"], analysis["regionCount"], len(analysis["skipped"])), counts)
                self.assertEqual((result["outcome"], result["findings"]), ("pass", []))

    @requires_parser
    def test_only_skipped_documentation_sections(self):
        result = source_result("/** @example\n * utilize()\n */\nconst x = 1;\n", "a.js")
        self.assertEqual((result["analysis"]["commentCount"], result["analysis"]["regionCount"]), (1, 0))
        self.assertEqual(result["findings"], [])


class HelperProtocolTests(unittest.TestCase):
    def setUp(self):
        self.spec = ste_source.resolve_inputs(["a.js"], "auto")[0]

    def run_with_stdout(self, payload, returncode=0, stderr=b""):
        completed = subprocess.CompletedProcess([], returncode, payload if isinstance(payload, bytes) else json.dumps(payload).encode(), stderr)
        with mock.patch.object(ste_source, "node_executable", return_value="node"), \
                mock.patch.object(ste_source, "helper_path", return_value=Path("helper.js")), \
                mock.patch.object(ste_source.subprocess, "run", return_value=completed):
            with self.assertRaises(InvocationError) as raised:
                ste_source.prepare_sources([(self.spec, "x // é😀\n")])
        return raised.exception

    def result(self, files):
        return {"result": {"protocolVersion": 1, "offsetEncoding": "utf16", "files": files}}

    def test_malformed_results_are_operational_failures(self):
        for name, payload in {
            "not json": b"{",
            "wrong version": {"result": {"protocolVersion": 2, "offsetEncoding": "utf16", "files": []}},
            "unexpected result entry": {"result": {"protocolVersion": 1, "offsetEncoding": "utf16",
                                                   "files": [{"id": 0, "comments": []}], "extra": True}},
            "missing id": self.result([]),
            "duplicate id": self.result([{"id": 0, "comments": []}, {"id": 0, "comments": []}]),
            "unexpected key": self.result([{"id": 0, "comments": [], "extra": 1}]),
            "bad kind": self.result([{"id": 0, "comments": [{"kind": "doc", "start": 2, "end": 4}]}]),
            "out of range": self.result([{"id": 0, "comments": [{"kind": "line", "start": 2, "end": 40}]}]),
            "surrogate split": self.result([{"id": 0, "comments": [{"kind": "line", "start": 2, "end": 7}]}]),
            "overlap": self.result([{"id": 0, "comments": [{"kind": "line", "start": 2, "end": 5},
                                                            {"kind": "line", "start": 4, "end": 6}]}]),
        }.items():
            with self.subTest(name=name):
                error = self.run_with_stdout(payload)
                self.assertEqual((error.code, error.status), ("source_parser_failed", 1))
                self.assertEqual(error.details["task"], ste_source.JS_TASK)

    def test_helper_startup_diagnoses_are_relayed_and_crashes_are_bounded(self):
        diagnosis = {"error": {"code": "dependency_missing", "condition": "missing", "remedy": "install it",
                               "dependencyRoot": "/home/x"}}
        error = self.run_with_stdout(b"", 2, json.dumps(diagnosis).encode())
        self.assertEqual((error.code, error.status, error.remedy), ("dependency_missing", 2, "install it"))
        self.assertEqual(error.details["dependencyRoot"], "/home/x")
        crash = self.run_with_stdout(b"", 134, b"Segmentation fault: source text utilize\n")
        self.assertEqual((crash.code, crash.status), ("source_parser_failed", 1))
        self.assertEqual(crash.details, {"task": ste_source.JS_TASK, "childStatus": 134})

    @unittest.skipUnless(NODE, "Node.js is not on PATH")
    def test_a_stalled_helper_times_out(self):
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory) / "stall.js"
            helper.write_text("setTimeout(() => {}, 60000);\n", encoding="utf-8")
            with mock.patch.object(ste_source, "JS_HELPER", helper), \
                    mock.patch.object(ste_source, "JS_HELPER_TIMEOUT_SECONDS", 0.5), \
                    mock.patch.object(ste_source, "node_executable", return_value=NODE or "node"):
                with self.assertRaises(InvocationError) as raised:
                    ste_source.prepare_sources([(self.spec, "// x\n")])
        error = raised.exception
        self.assertEqual((error.code, error.status), ("source_parser_failed", 1))
        self.assertEqual(error.details["timeoutSeconds"], 0.5)
        self.assertEqual(error.details["inputPaths"], ["a.js"])


class SourceCliTests(unittest.TestCase):
    """The public checker on a synthetic installation, as test_ste_tools builds one."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.scripts = self.root / "skill" / "scripts"
        self.scripts.mkdir(parents=True)
        for name in ("ste_check.py", *RUNTIME_MODULES):
            shutil.copy2(SCRIPTS / name, self.scripts / name)
        for name in SKILL_PACKAGE_FILES:
            shutil.copy2(ROOT / name, self.root / "skill" / name)
        config, generated, _ = make_bundle(self.root / "skill")
        bundle = generated_bundle_path(config, self.home)
        bundle.parent.mkdir(parents=True)
        shutil.move(generated, bundle)
        (self.root / "skill" / "references" / "software-terminology.jsonl").write_bytes(software_terminology_bytes())
        self.env = {**os.environ, "HOME": str(self.home)}

    def link_parser(self):
        root = self.home / ".harness-plugin" / "write-asd-ste100"
        root.mkdir(parents=True, exist_ok=True)
        for name in SKILL_PACKAGE_FILES:
            shutil.copy2(self.root / "skill" / name, root / name)
        (root / "node_modules").symlink_to(REAL_DEPENDENCY_ROOT / "node_modules", target_is_directory=True)
        return root

    def write(self, name: str, text: str) -> Path:
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def check(self, *arguments, env=None, input_bytes=None):
        return subprocess.run(
            [sys.executable, str(self.scripts / "ste_check.py"), *arguments],
            input=input_bytes, capture_output=True, env=env or self.env, check=False,
        )

    def error(self, completed) -> dict:
        self.assertEqual(completed.stdout, b"")
        self.assertEqual(completed.stderr.count(b"\n"), 1, completed.stderr)
        return json.loads(completed.stderr)["error"]

    def node_free_env(self) -> dict:
        bin_directory = self.root / "bin-without-node"
        bin_directory.mkdir(exist_ok=True)
        return {**self.env, "PATH": str(bin_directory)}

    def test_python_and_prose_need_no_node(self):
        python = self.write("a.py", "utilize = 1  # Utilize it.\n")
        document = self.write("a.md", "Use.\n")
        completed = self.check(str(python), str(document), "--mode", "procedural", "--json", env=self.node_free_env())
        self.assertEqual(completed.returncode, 1, completed.stderr)
        payload = run_result(completed.stdout)
        self.assertEqual([item["path"] for item in payload["files"]], [str(python), str(document)])
        self.assertEqual(payload["files"][0]["analysis"]["inputFormat"], "python")
        self.assertNotIn("analysis", payload["files"][1])
        self.assertEqual(payload["files"][0]["findings"][0]["source"]["text"], "Utilize")

    def test_unresolved_inputs_fail_before_reading(self):
        for arguments in ((str(self.root / "Makefile"),), ("-",)):
            with self.subTest(arguments=arguments):
                completed = self.check(*arguments, "--mode", "procedural", "--json", input_bytes=b"\xff")
                self.assertEqual(completed.returncode, 2)
                error = self.error(completed)
                self.assertEqual(error["code"], "input_format_required")
                self.assertIn("--input-format", error["remedy"])

    def test_prose_override_of_a_source_file_is_a_usage_error(self):
        python = self.write("a.py", "# Use.\n")
        completed = self.check(str(python), "--input-format", "prose", "--mode", "procedural", "--json")
        self.assertEqual((completed.returncode, self.error(completed)["code"]), (2, "usage_error"))
        completed = self.check(str(python), "--input-format", "rust", "--mode", "procedural", "--json")
        self.assertEqual((completed.returncode, self.error(completed)["code"]), (2, "usage_error"))

    def test_source_standard_input_normalizes_line_endings(self):
        completed = self.check("-", "--input-format", "python", "--mode", "procedural", "--json",
                               input_bytes=b"x = 1\r\n# Utilize.\ry = 2\r\n")
        self.assertEqual(completed.returncode, 1, completed.stderr)
        [finding] = run_result(completed.stdout)["files"][0]["findings"]
        self.assertEqual(finding["source"]["start"], {"offset": 8, "line": 2, "column": 3})

    def test_crlf_source_files_use_canonical_positions(self):
        path = self.root / "a.py"
        path.write_bytes(b"x = 1\r\n\r\n# Utilize.\r\n")
        completed = self.check(str(path), "--mode", "procedural", "--json")
        [finding] = run_result(completed.stdout)["files"][0]["findings"]
        self.assertEqual(finding["source"]["start"], {"offset": 9, "line": 3, "column": 3})

    def test_malformed_source_beside_valid_inputs_fails_the_whole_batch(self):
        valid = self.write("a.md", "Utilize.\n")
        broken = self.write("b.py", "x = (\n")
        also = self.write("c.py", "if x:\nprint()\n")
        completed = self.check(str(valid), str(broken), str(also), "--mode", "procedural", "--json")
        self.assertEqual(completed.returncode, 2)
        error = self.error(completed)
        self.assertEqual(error["code"], "source_parse_failed")
        self.assertEqual([item["path"] for item in error["inputs"]], [str(broken), str(also)])
        plain = self.check(str(valid), str(broken), "--mode", "procedural")
        self.assertEqual(plain.stdout, b"")
        self.assertIn(f"ERROR [source_parse_failed]: {broken}: ".encode(), plain.stderr)

    def test_unreadable_source_prevents_extraction(self):
        valid = self.write("a.ts", "// Use.\n")
        missing = self.root / "missing.py"
        with mock.patch.object(ste_check, "ensure_references_loaded", return_value=({}, [])), \
                mock.patch.object(ste_check, "load_dictionary") as dictionary, \
                mock.patch.object(ste_check, "prepare_sources") as prepare, \
                mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            status = ste_check.main([str(valid), str(missing), "--mode", "procedural", "--json"])
        self.assertEqual(status, 2)
        dictionary.assert_not_called()
        prepare.assert_not_called()
        self.assertEqual(json.loads(stderr.getvalue())["error"]["code"], "input_read_failed")

    def test_plain_output_reports_comment_scope(self):
        python = self.write("a.py", "# noqa\nx = 1\n")
        completed = self.check(str(python), "--mode", "procedural")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(
            b"  Scope: python comments only; 1 comments, 0 prose regions checked, 1 sections skipped\n",
            completed.stdout,
        )

    def test_help_documents_the_input_format_and_needs_no_dependencies(self):
        completed = self.check("--help", env=self.node_free_env())
        self.assertEqual(completed.returncode, 0)
        self.assertIn(b"--input-format", completed.stdout)

    def test_preflight_checks_the_routes_it_is_given_without_reading_input(self):
        ready = self.check("--preflight", "--json", env=self.node_free_env())
        self.assertEqual((ready.returncode, ready.stdout), (0, b'{"status": "ready"}\n'))
        python = self.check("-", "--preflight", "--input-format", "python", "--json", input_bytes=b"\xff",
                            env=self.node_free_env())
        self.assertEqual((python.returncode, python.stdout), (0, b'{"status": "ready"}\n'), python.stderr)
        missing_node = self.check("--preflight", "--input-format", "typescript", "--json", env=self.node_free_env())
        self.assertEqual(self.error(missing_node)["code"], "node_missing")
        missing = self.check("--preflight", "--input-format", "tsx", "--json")
        error = self.error(missing)
        self.assertEqual(error["code"], "dependency_missing")
        self.assertIn(str(self.root / "skill" / "package-lock.json"), error["remedy"])
        suffix = self.check(str(self.root / "absent.ts"), "--preflight", "--json")
        self.assertEqual(self.error(suffix)["code"], "dependency_missing")

    def test_javascript_family_dependency_failures(self):
        script = self.write("a.ts", "// Utilize it.\n")
        missing = self.check(str(script), "--mode", "procedural", "--json")
        self.assertEqual((missing.returncode, self.error(missing)["code"]), (2, "dependency_missing"))
        no_node = self.check(str(script), "--mode", "procedural", "--json", env=self.node_free_env())
        self.assertEqual(self.error(no_node)["code"], "node_missing")
        (self.scripts / "extract-js-comments.js").unlink()
        absent = self.check(str(script), "--mode", "procedural", "--json")
        error = self.error(absent)
        self.assertEqual(error["code"], "source_parser_missing")
        self.assertEqual(error["helperPath"], str(self.scripts / "extract-js-comments.js"))

    @requires_parser
    def test_stale_parser_install_is_rejected(self):
        root = self.link_parser()
        lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
        lock["name"] = "stale"
        (root / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        script = self.write("a.ts", "// Utilize it.\n")
        completed = self.check(str(script), "--mode", "procedural", "--json")
        self.assertEqual((completed.returncode, self.error(completed)["code"]), (2, "dependency_invalid"))

    @requires_parser
    def test_mixed_batch_order_ids_and_aggregate_terms(self):
        self.link_parser()
        inputs = [
            self.write("a.ts", "const widget = 1; // Widget utilize.\n/* Widget. */\n"),
            self.write("b.md", "Widget.\n"),
            self.write("c.py", "widget = 1  # Widget.\n"),
        ]
        completed = self.check(*map(str, inputs), "--mode", "procedural", "--json")
        self.assertEqual(completed.returncode, 1, completed.stderr)
        payload = run_result(completed.stdout)
        self.assertEqual([item["path"] for item in payload["files"]], list(map(str, inputs)))
        self.assertEqual([item["findings"][0]["id"] for item in payload["files"]], ["F001"] * 3)
        self.assertEqual([item["id"] for item in payload["files"][0]["findings"]], ["F001", "F002", "F003"])
        self.assertEqual(payload["files"][0]["summary"]["unique_unknown_terms"], 1)
        self.assertEqual(payload["summary"]["unique_unknown_terms"], 1)
        self.assertEqual(payload["files"][0]["analysis"]["regionCount"], 2)
        self.assertNotIn("analysis", payload["files"][1])


if __name__ == "__main__":
    unittest.main()
