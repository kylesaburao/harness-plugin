#!/usr/bin/env python3
"""Check technical prose against deterministic and heuristic STE constraints."""

from __future__ import annotations

import argparse
import errno
import json
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from typing import NoReturn

from ste_data import (
    LAYERS,
    SOURCE_SOFTWARE,
    ReferencesError,
    ensure_references_ready,
    load_dictionary,
    load_software_terms,
    load_terms,
    merge_layers,
    report_reference_error,
)

WORD = re.compile(r"[A-Za-z]+(?:-[A-Za-z]+)*(?:'[A-Za-z]+)?")
SENTENCE = re.compile(r"[^.!?]+[.!?]?")
CONTRACTION = re.compile(
    r"\b(?:[A-Za-z]+n't|(?:I|you|we|they|he|she|it|that|there|what|who|where|when|why|how)'(?:m|re|ve|ll|d|s))\b",
    re.I,
)
PASSIVE = re.compile(r"\b(?:am|are|is|was|were|be|been|being)\s+(?:\w+\s+){0,2}\w+(?:ed|en)\b", re.I)
PROTECTED = [
    re.compile(r"`[^`\n]+`"),
    re.compile(r"https?://\S+|www\.\S+", re.I),
    re.compile(r"(?<!\w)(?:~?/|\.\.?/)[^\s,;:()]+"),
    re.compile(r"\b[A-Za-z]:\\[^\s]+"),
    re.compile(r"(?<!\w)--?[A-Za-z][\w-]*(?:=[^\s]+)?"),
    re.compile(r"\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z]+::[A-Za-z_:]+|[A-Za-z]+\.[A-Za-z_][\w.]*)\b"),
    re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\(\)"),
    re.compile(r'"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’'),
]
DIAGNOSTIC = re.compile(r"^\s*(?:error|warning|fatal|traceback|exception|caused by|at )[:\s]", re.I)

# Annotation aliases. The repo configures no type checker, so these are plain runtime
# names kept only to document intent at the annotation sites.
Severity = Category = ActionType = str
Position = SourceSpan = Action = Finding = dict


def mask_span(text: str, start: int, end: int) -> str:
    return text[:start] + " " * (end - start) + text[end:]


def protect_markdown(text: str) -> str:
    masked = text
    protected: list[tuple[int, int]] = []
    in_fence = False
    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        line_start = offset
        line_end = offset + len(line)
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            protected.append((line_start, line_end))
        elif in_fence or stripped.startswith(">") or DIAGNOSTIC.match(line):
            protected.append((line_start, line_end))
        offset = line_end
    for pattern in PROTECTED:
        for match in pattern.finditer(text):
            protected.append(match.span())
    for start, end in sorted(protected, reverse=True):
        masked = mask_span(masked, start, end)
    return masked


def position(text: str, offset: int) -> Position:
    line = text.count("\n", 0, offset) + 1
    last_newline = text.rfind("\n", 0, offset)
    return {"offset": offset, "line": line, "column": offset - last_newline}


def trimmed_span(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def blocks(masked: str) -> list:
    """Spans of text separated by blank lines, with surrounding space trimmed."""
    spans = []
    cursor = 0
    for separator in [*re.finditer(r"\n[ \t]*\n", masked), None]:
        segment_end = separator.start() if separator else len(masked)
        start, end = trimmed_span(masked, cursor, segment_end)
        if start < end:
            spans.append((start, end))
        if separator:
            cursor = separator.end()
    return spans


def make_finding(
    *,
    severity: Severity,
    rule: str,
    category: Category,
    problem: str,
    text: str,
    start: int,
    end: int,
    action_type: ActionType,
    instruction: str,
    candidates: list[str],
    evidence: dict[str, Any],
) -> Finding:
    return {
        "id": "",
        "severity": severity,
        "rule": rule,
        "category": category,
        "problem": problem,
        "source": {
            "text": text[start:end],
            "start": position(text, start),
            "end": position(text, end),
        },
        "action": {
            "type": action_type,
            "instruction": instruction,
            "candidates": candidates,
        },
        "evidence": evidence,
    }


def contraction_candidates(value: str) -> list[str]:
    folded = value.casefold()
    irregular = {"won't": "will not", "can't": "cannot", "shan't": "shall not", "ain't": "is not"}
    if folded in irregular:
        return [irregular[folded]]
    if folded.endswith("n't"):
        return [f"{folded[:-3]} not"]
    base, suffix = folded.rsplit("'", 1)
    expansions = {
        "m": ["am"],
        "re": ["are"],
        "ve": ["have"],
        "ll": ["will"],
        "d": ["had", "would"],
        "s": ["has", "is"],
    }
    return [f"{base} {word}" for word in expansions.get(suffix, [])]


def sentence_limit(mode: str, sentence: str) -> int:
    if mode == "procedural":
        return 20
    if mode == "descriptive":
        return 25
    first = next(iter(WORD.finditer(sentence)), None)
    imperative_starts = {
        "add", "adjust", "apply", "attach", "check", "clean", "close", "connect", "do", "install",
        "make", "move", "open", "put", "remove", "replace", "set", "start", "stop", "turn", "use",
    }
    return 20 if first and first.group(0).casefold() in imperative_starts else 25


def count_words(sentence: str) -> int:
    # Parenthetical text, numbers with units, and hyphenated words count as one.
    # Protected spans (identifiers, URLs, paths, quotes, ...) are already replaced
    # by spaces before this function ever sees the text, so they are excluded from
    # the count entirely: identifiers are not prose.
    collapsed = re.sub(r"\([^()]*\)", " TOKEN ", sentence)
    collapsed = re.sub(r"\b\d+(?:\.\d+)?\s*[A-Za-z°%]+\b", " TOKEN ", collapsed)
    collapsed = re.sub(r"\b\d+(?:\.\d+)?\b", " TOKEN ", collapsed)
    return len(WORD.findall(collapsed))


def dictionary_candidates(records: list[dict]) -> list[str]:
    candidates: list[str] = []
    for record in records:
        for candidate in record["meaning_or_alternatives"]:
            if candidate not in candidates:
                candidates.append(candidate)
    return candidates[:5]


def check_file(
    text: str,
    mode: str,
    by_headword: dict,
    approved_forms: dict,
    unapproved: dict,
    terms: dict,
    report_unknown_terms: bool = True,
) -> dict:
    masked = protect_markdown(text)
    contraction_matches = list(CONTRACTION.finditer(masked))
    findings: list[Finding] = []

    for match in re.finditer(";", masked):
        findings.append(make_finding(
            severity="error", rule="8.1", category="semicolon",
            problem="Natural-language prose contains a semicolon.", text=text,
            start=match.start(), end=match.end(), action_type="rewrite_without_semicolon",
            instruction="Rewrite the text without a semicolon.", candidates=[], evidence={},
        ))
    for match in contraction_matches:
        findings.append(make_finding(
            severity="error", rule="4.2", category="contraction",
            problem="Natural-language prose contains a contraction.", text=text,
            start=match.start(), end=match.end(), action_type="expand_contraction",
            instruction="Expand this contraction.", candidates=contraction_candidates(match.group(0)), evidence={},
        ))

    block_spans = blocks(masked)
    for block_start, block_end in block_spans:
        for match in SENTENCE.finditer(masked, block_start, block_end):
            start, end = trimmed_span(masked, match.start(), match.end())
            if start == end:
                continue
            masked_sentence = masked[start:end]
            total = count_words(masked_sentence)
            limit = sentence_limit(mode, masked_sentence)
            if total > limit:
                rule = "5.1" if limit == 20 else "6.3"
                findings.append(make_finding(
                    severity="error", rule=rule, category="long_sentence",
                    problem=f"The sentence has {total} words. The limit is {limit}.", text=text,
                    start=start, end=end, action_type="shorten_sentence",
                    instruction=f"Shorten the sentence to {limit} words or fewer.", candidates=[],
                    evidence={"word_count": total, "limit": limit},
                ))

    if mode in {"descriptive", "mixed"}:
        for start, end in block_spans:
            count = sum(1 for item in SENTENCE.finditer(masked, start, end) if item.group(0).strip())
            if count > 6:
                findings.append(make_finding(
                    severity="error", rule="6.6", category="long_paragraph",
                    problem=f"The paragraph has {count} sentences. The limit is 6.", text=text,
                    start=start, end=end, action_type="split_paragraph",
                    instruction="Split this paragraph into shorter paragraphs.", candidates=[],
                    evidence={"sentence_count": count, "limit": 6},
                ))

    vocabulary_masked = masked
    for match in contraction_matches:
        vocabulary_masked = mask_span(vocabulary_masked, match.start(), match.end())
    protected_phrases = sorted(
        {key for key in approved_forms if " " in key} | {key for key in terms if " " in key},
        key=len,
        reverse=True,
    )
    for phrase in protected_phrases:
        pattern = re.compile(r"(?<![A-Za-z])" + re.escape(phrase) + r"(?![A-Za-z])", re.I)
        for match in list(pattern.finditer(vocabulary_masked)):
            vocabulary_masked = mask_span(vocabulary_masked, match.start(), match.end())
    unapproved_phrases = sorted((key for key in unapproved if " " in key), key=len, reverse=True)
    for phrase in unapproved_phrases:
        pattern = re.compile(r"(?<![A-Za-z])" + re.escape(phrase) + r"(?![A-Za-z])", re.I)
        records = unapproved[phrase]
        source = records[0].get("source")
        for match in list(pattern.finditer(vocabulary_masked)):
            if source == SOURCE_SOFTWARE:
                findings.append(make_finding(
                    severity="review", rule=records[0].get("rule", "1.1"), category="overused_term",
                    problem="The expression is an overused AI-coding-assistant tic.", text=text,
                    start=match.start(), end=match.end(), action_type="review_overused_term",
                    instruction="Review this expression and consider an alternative an engineer would write.",
                    candidates=dictionary_candidates(records), evidence={"source": source},
                ))
            else:
                findings.append(make_finding(
                    severity="error", rule="1.1", category="unapproved_expression",
                    problem="The expression is not approved.", text=text,
                    start=match.start(), end=match.end(), action_type="replace",
                    instruction="Replace this expression with an approved alternative.",
                    candidates=dictionary_candidates(records), evidence={"source": source},
                ))
            vocabulary_masked = mask_span(vocabulary_masked, match.start(), match.end())

    for match in WORD.finditer(vocabulary_masked):
        token = match.group(0)
        key = token.casefold()
        if key.endswith("'s"):
            key = key[:-2]
        if key in terms or key in approved_forms:
            continue
        if key in unapproved:
            records = unapproved[key]
            source = records[0].get("source")
            if source == SOURCE_SOFTWARE:
                findings.append(make_finding(
                    severity="review", rule=records[0].get("rule", "1.1"), category="overused_term",
                    problem="The word is an overused AI-coding-assistant tic.", text=text,
                    start=match.start(), end=match.end(), action_type="review_overused_term",
                    instruction="Review this word and consider an alternative an engineer would write.",
                    candidates=dictionary_candidates(records), evidence={"source": source},
                ))
            else:
                findings.append(make_finding(
                    severity="error", rule="1.1", category="unapproved_word",
                    problem="The word is not approved.", text=text,
                    start=match.start(), end=match.end(), action_type="replace",
                    instruction="Replace this word with an approved alternative.",
                    candidates=dictionary_candidates(records), evidence={"source": source},
                ))
            continue
        if key in by_headword and any(entry["status"] == "approved" for entry in by_headword[key]):
            allowed = sorted({form for entry in by_headword[key] if entry["status"] == "approved" for form in entry["forms"]})
            findings.append(make_finding(
                severity="error", rule="1.4", category="unapproved_form",
                problem="The word form is not approved.", text=text,
                start=match.start(), end=match.end(), action_type="use_approved_form",
                instruction="Use an approved form of this word.", candidates=allowed, evidence={},
            ))
            continue
        if report_unknown_terms:
            findings.append(make_finding(
                severity="review", rule="1.5/1.12", category="unknown_term",
                problem="The term is not in the approved dictionary or project terminology.", text=text,
                start=match.start(), end=match.end(), action_type="review_terminology",
                instruction="Review this term as a possible technical noun or technical verb.", candidates=[],
                evidence={"normalized_term": key},
            ))

    for match in PASSIVE.finditer(masked):
        findings.append(make_finding(
            severity="warning", rule="3.6", category="passive_voice",
            problem="The text can contain passive voice.", text=text,
            start=match.start(), end=match.end(), action_type="review_active_voice",
            instruction="Review the agent and use active voice when it is suitable.", candidates=[], evidence={},
        ))
    for match in re.finditer(r"\b[A-Za-z]+ing\b", masked, re.I):
        key = match.group(0).casefold()
        if key not in approved_forms and key not in terms:
            findings.append(make_finding(
                severity="warning", rule="3.5", category="unapproved_ing_form",
                problem="The -ing form can be unapproved.", text=text,
                start=match.start(), end=match.end(), action_type="review_word_form",
                instruction="Review the word form and its technical-noun use.", candidates=[], evidence={},
            ))

    for match in re.finditer(r"\b(?:[A-Za-z][A-Za-z-]*\s+){3,}[A-Za-z][A-Za-z-]*\b", masked):
        words = WORD.findall(match.group(0))
        if 4 <= len(words) <= 6 and not any(word.casefold() in {"and", "or", "the", "a", "an", "to", "of", "in", "for", "with"} for word in words):
            findings.append(make_finding(
                severity="warning", rule="2.1", category="long_multiword_noun",
                problem="The possible multi-word noun has more than three words.", text=text,
                start=match.start(), end=match.end(), action_type="shorten_noun_phrase",
                instruction="Shorten this possible multi-word noun.", candidates=[],
                evidence={"word_count": len(words), "limit": 3},
            ))

    severity_order = {"error": 0, "warning": 1, "review": 2}
    findings.sort(key=lambda item: (item["source"]["start"]["offset"], severity_order[item["severity"]]))
    for number, item in enumerate(findings, 1):
        item["id"] = f"F{number:03d}"

    errors = sum(item["severity"] == "error" for item in findings)
    warnings = sum(item["severity"] == "warning" for item in findings)
    reviews = sum(item["severity"] == "review" for item in findings)
    unique_unknown_terms = len({
        item["evidence"]["normalized_term"]
        for item in findings
        if item["category"] == "unknown_term"
    })
    outcome = "fail" if errors else "review" if findings else "pass"
    return {
        "mode": mode,
        "outcome": outcome,
        "summary": {
            "total": len(findings),
            "errors": errors,
            "warnings": warnings,
            "reviews": reviews,
            "unique_unknown_terms": unique_unknown_terms,
        },
        "findings": findings,
    }


def plain_message(item: Finding) -> str:
    source = item["source"]["text"]
    evidence = item["evidence"]
    category = item["category"]
    if category == "semicolon":
        return "Do not use a semicolon in natural-language prose."
    if category == "contraction":
        return "Do not use a contraction."
    if category == "long_sentence":
        return f"Sentence has {evidence['word_count']} words; the limit is {evidence['limit']}."
    if category == "long_paragraph":
        return f"Paragraph has {evidence['sentence_count']} sentences; the limit is {evidence['limit']}."
    if category == "unapproved_expression":
        return f"Unapproved expression: {source}."
    if category == "unapproved_word":
        return f"Unapproved word: {source}."
    if category == "unapproved_form":
        return f"Unapproved form: {source}."
    if category == "unknown_term":
        return f"Unknown term; review it as a possible technical noun or verb: {source}."
    if category == "overused_term":
        return f"Overused AI-coding-assistant tic; consider an alternative: {source}."
    if category == "passive_voice":
        return "Possible passive voice; review the agent and context."
    if category == "unapproved_ing_form":
        return "Possible unapproved -ing form; review technical-noun use."
    return "Possible multi-word noun with more than three words."


@dataclass(frozen=True)
class InvocationError(Exception):
    code: str
    condition: str
    inputs: list[dict[str, str]] | None = None


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise InvocationError("invalid_arguments", message)


def input_condition(error: OSError) -> str:
    if error.errno == errno.ENOENT:
        return "file does not exist"
    if error.errno in {errno.EACCES, errno.EPERM}:
        return "permission denied"
    return error.strerror or str(error)


def read_file_input(path: str) -> tuple[str | None, str | None]:
    candidate = Path(path)
    try:
        details = candidate.stat()
    except OSError as error:
        return None, input_condition(error)
    if not stat.S_ISREG(details.st_mode):
        return None, "not a regular file"
    try:
        return candidate.read_text(encoding="utf-8"), None
    except UnicodeDecodeError:
        return None, "invalid UTF-8"
    except OSError as error:
        return None, input_condition(error)


def read_inputs(paths: list[str]) -> list[tuple[str, str]]:
    if paths == ["-"]:
        try:
            return [("-", sys.stdin.read())]
        except UnicodeError:
            raise InvocationError(
                "input_read_failed", "standard input is not valid UTF-8",
                [{"path": "-", "condition": "invalid UTF-8"}],
            ) from None
        except OSError as error:
            condition = input_condition(error)
            raise InvocationError(
                "input_read_failed", f"standard input: {condition}",
                [{"path": "-", "condition": condition}],
            ) from error
    loaded: list[tuple[str, str]] = []
    failures: list[dict[str, str]] = []
    for path in paths:
        text, condition = read_file_input(path)
        if condition is not None:
            failures.append({"path": path, "condition": condition})
        else:
            loaded.append((path, text))
    if failures:
        raise InvocationError("input_read_failed", "one or more inputs could not be read", failures)
    return loaded


def make_batch(mode: str, results: list[tuple[str, dict]]) -> dict:
    files = [
        {
            "path": path,
            "outcome": result["outcome"],
            "summary": result["summary"],
            "findings": result["findings"],
        }
        for path, result in results
    ]
    summaries = [result["summary"] for _, result in results]
    errors = sum(summary["errors"] for summary in summaries)
    warnings = sum(summary["warnings"] for summary in summaries)
    reviews = sum(summary["reviews"] for summary in summaries)
    unknown_terms = {
        item["evidence"]["normalized_term"]
        for _, result in results
        for item in result["findings"]
        if item["category"] == "unknown_term"
    }
    passed_files = sum(result["outcome"] == "pass" for _, result in results)
    review_files = sum(result["outcome"] == "review" for _, result in results)
    failed_files = sum(result["outcome"] == "fail" for _, result in results)
    outcome = "fail" if failed_files else "review" if review_files else "pass"
    return {
        "mode": mode,
        "outcome": outcome,
        "summary": {
            "files": len(files),
            "passed_files": passed_files,
            "review_files": review_files,
            "failed_files": failed_files,
            "total": sum(summary["total"] for summary in summaries),
            "errors": errors,
            "warnings": warnings,
            "reviews": reviews,
            "unique_unknown_terms": len(unknown_terms),
        },
        "files": files,
    }


def print_plain(result: dict) -> None:
    for number, file_result in enumerate(result["files"]):
        if number:
            print()
        print(f"File: {file_result['path']}")
        for item in file_result["findings"]:
            start = item["source"]["start"]
            print(
                f"  {start['line']}:{start['column']} [{item['severity']}] "
                f"[{item['rule']}] {plain_message(item)}"
            )
        print(f"Outcome: {file_result['outcome']}")
    print("\nAggregate summary:")
    for key in (
        "files", "passed_files", "review_files", "failed_files", "total",
        "errors", "warnings", "reviews", "unique_unknown_terms",
    ):
        print(f"  {key}: {result['summary'][key]}")


def report_invocation_error(error: InvocationError, json_output: bool) -> None:
    details: dict[str, Any] = {"code": error.code}
    if error.inputs is not None:
        details["inputs"] = error.inputs
    else:
        details["condition"] = error.condition
    if json_output:
        print(json.dumps({"error": details}, ensure_ascii=False, indent=2), file=sys.stderr)
        return
    if error.inputs is not None:
        for item in error.inputs:
            print(f"ERROR [{error.code}]: {item['path']}: {item['condition']}", file=sys.stderr)
        return
    print(f"ERROR [{error.code}]: {error.condition}", file=sys.stderr)


def layer_list(value: str) -> list:
    tokens = [token.strip() for token in value.split(",") if token.strip()]
    invalid = [token for token in tokens if token not in LAYERS]
    if not tokens or invalid:
        raise argparse.ArgumentTypeError(
            f"--layers must be a comma-separated list drawn from {', '.join(LAYERS)}"
        )
    return tokens


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = Parser(prog="ste_check.py")
    parser.add_argument("files", nargs="+", help="Files to check, or - as the sole standard-input path")
    parser.add_argument("--mode", choices=("procedural", "descriptive", "mixed"), required=True)
    parser.add_argument("--terms", type=Path)
    parser.add_argument(
        "--layers", type=layer_list, default=list(LAYERS),
        help=f"Comma-separated vocabulary layers to check, drawn from {', '.join(LAYERS)} (default: all)",
    )
    parser.add_argument("--json", action="store_true")
    json_output = "--json" in argv
    try:
        args = parser.parse_args(argv)
    except InvocationError as error:
        report_invocation_error(error, json_output)
        return 2
    try:
        ensure_references_ready()
    except ReferencesError as error:
        report_reference_error(error, args.json)
        return 2
    if "-" in args.files and args.files != ["-"]:
        report_invocation_error(
            InvocationError("invalid_arguments", "- is valid only as the sole input"), args.json
        )
        return 2
    try:
        inputs = read_inputs(args.files)
    except InvocationError as error:
        report_invocation_error(error, args.json)
        return 2
    try:
        dictionary = load_dictionary()
    except (OSError, UnicodeError, ValueError) as error:
        report_reference_error(
            ReferencesError("references_invalid", f"dictionary loading could not complete: {error}"), args.json
        )
        return 2
    layers = set(args.layers)
    software_entries = []
    if "software" in layers:
        try:
            software_entries = load_software_terms()
        except (OSError, UnicodeError, ValueError) as error:
            report_invocation_error(InvocationError("software_terms_invalid", str(error)), args.json)
            return 2
    merged = merge_layers(dictionary, software_entries, layers)
    try:
        terms = load_terms(args.terms) if "project" in layers else {}
    except ValueError as error:
        report_invocation_error(InvocationError("terms_invalid", str(error)), args.json)
        return 2
    report_unknown_terms = "asd" in layers
    results = [
        (path, check_file(
            text, args.mode, merged.by_headword, merged.approved_forms, merged.unapproved, terms,
            report_unknown_terms=report_unknown_terms,
        ))
        for path, text in inputs
    ]
    result = make_batch(args.mode, results)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_plain(result)
    return 1 if result["outcome"] == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
