"""Source-file routing and comment extraction for comment-only STE checking.

A language parser decides where comments are. This module turns those comments
into independent, same-length prose regions in canonical-input coordinates, so
ste_check.check_file never sees executable code, strings, or markup text.
"""

from __future__ import annotations

import ast
import io
import json
import re
import shutil
import subprocess
import sys
import tokenize
import warnings
from bisect import bisect_right
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ste_cli import InvocationError

# --- Input formats and parser profiles -------------------------------------------------

PROSE = "prose"
PYTHON = "python"
JS_FORMATS = ("javascript", "typescript", "jsx", "tsx")
SOURCE_FORMATS = (PYTHON, *JS_FORMATS)
INPUT_FORMATS = ("auto", PROSE, *SOURCE_FORMATS)
PROSE_SUFFIXES = (".md", ".markdown", ".txt")

# Declaration suffixes come first so that ".d.ts" wins over ".ts". Each entry
# names the automatically selected format and the profile hints the suffix carries.
SOURCE_SUFFIXES: tuple[tuple[str, str, dict[str, Any]], ...] = (
    (".d.mts", "typescript", {"sourceType": "module", "declaration": True, "disallowAmbiguousJsxLike": True}),
    (".d.cts", "typescript", {"sourceType": "unambiguous", "declaration": True, "disallowAmbiguousJsxLike": True}),
    (".d.ts", "typescript", {"declaration": True}),
    (".py", PYTHON, {}),
    (".pyi", PYTHON, {}),
    (".js", "javascript", {}),
    (".mjs", "javascript", {"sourceType": "module"}),
    (".cjs", "javascript", {"sourceType": "commonjs"}),
    (".jsx", "jsx", {}),
    (".ts", "typescript", {}),
    (".mts", "typescript", {"sourceType": "module", "disallowAmbiguousJsxLike": True}),
    (".cts", "typescript", {"sourceType": "unambiguous", "disallowAmbiguousJsxLike": True}),
    (".tsx", "tsx", {}),
)
LANGUAGE_FAMILY = {
    PYTHON: PYTHON,
    "javascript": "javascript",
    "jsx": "javascript",
    "typescript": "typescript",
    "tsx": "typescript",
}
FORMAT_REMEDY = (
    "pass --input-format prose|python|javascript|typescript|jsx|tsx for these inputs; "
    "one explicit format applies to every input, so split a batch whose inputs need different formats"
)


@dataclass(frozen=True)
class InputSpec:
    path: str
    input_format: str
    # The JS-family parser profile; None for prose and Python.
    profile: dict[str, Any] | None = None

    @property
    def is_source(self) -> bool:
        return self.input_format != PROSE


def suffix_format(path: str) -> tuple[str, dict[str, Any]] | None:
    name = Path(path).name.casefold()
    for suffix, input_format, hints in SOURCE_SUFFIXES:
        if name.endswith(suffix):
            return input_format, hints
    if name.endswith(PROSE_SUFFIXES):
        return PROSE, {}
    return None


def js_profile(input_format: str, hints: dict[str, Any]) -> dict[str, Any]:
    jsx = input_format in {"jsx", "tsx"}
    return {
        "typescript": input_format in {"typescript", "tsx"},
        "jsx": jsx,
        "sourceType": hints.get("sourceType", "unambiguous"),
        "declaration": bool(hints.get("declaration", False)),
        # The restriction concerns JSX-like syntax in files that cannot hold JSX.
        "disallowAmbiguousJsxLike": bool(hints.get("disallowAmbiguousJsxLike", False)) and not jsx,
    }


def resolve_input(path: str, requested: str) -> InputSpec | None:
    """Resolve one input's format, or None when the caller must declare it."""
    detected = None if path == "-" else suffix_format(path)
    if requested == "auto":
        if detected is None:
            return None
        input_format, hints = detected
    elif requested == PROSE:
        if detected is not None and detected[0] != PROSE:
            raise InvocationError(
                "usage_error",
                f"--input-format prose cannot check the recognized {detected[0]} source file {path}",
                remedy="omit --input-format so source files are checked comment by comment, "
                "or check the source file in a separate batch with its own format",
            )
        input_format, hints = PROSE, {}
    else:
        input_format = requested
        # Module and declaration hints survive only within the same language family.
        same_family = detected is not None and LANGUAGE_FAMILY.get(detected[0]) == LANGUAGE_FAMILY[requested]
        hints = detected[1] if same_family else {}
    profile = js_profile(input_format, hints) if input_format in JS_FORMATS else None
    return InputSpec(path, input_format, profile)


def resolve_inputs(paths: list[str], requested: str) -> list[InputSpec]:
    specs: list[InputSpec] = []
    unresolved: list[dict[str, Any]] = []
    for path in paths:
        spec = resolve_input(path, requested)
        if spec is None:
            condition = (
                "standard input has no file name to select a format"
                if path == "-" else "the file name does not identify a supported input format"
            )
            unresolved.append({"path": path, "condition": condition})
        else:
            specs.append(spec)
    if unresolved:
        raise InvocationError(
            "input_format_required",
            "the input format of one or more inputs must be declared",
            unresolved,
            remedy=FORMAT_REMEDY,
        )
    return specs


def canonical_source(text: str, path: str) -> str:
    """Source-mode standard input gets the newline normalization file reads already have."""
    if path != "-":
        return text
    return text.replace("\r\n", "\n").replace("\r", "\n")


# --- Runtime readiness -------------------------------------------------------------------

MINIMUM_PYTHON = (3, 12)
JS_HELPER = Path(__file__).absolute().parent / "extract-js-comments.js"
JS_HELPER_TIMEOUT_SECONDS = 60
JS_TASK = "js-comment-extraction"
PROTOCOL_VERSION = 1
# Helper diagnostics that mean extraction never started; relayed unchanged.
HELPER_STARTUP_CODES = {"node_version_unsupported", "dependency_missing", "dependency_invalid"}


def check_python_runtime(version: tuple | None = None) -> None:
    version = tuple(sys.version_info[:3]) if version is None else version
    if tuple(version[:2]) < MINIMUM_PYTHON:
        found = ".".join(str(part) for part in version[:3])
        required = ".".join(str(part) for part in MINIMUM_PYTHON)
        raise InvocationError(
            "python_version_unsupported",
            f"Python source checking requires Python {required} or newer, running {found}",
            remedy=f"run ste_check.py with Python {required} or newer",
            details={"requiredVersion": required, "foundVersion": found},
        )


def js_paths(specs: list[InputSpec]) -> list[str]:
    return [spec.path for spec in specs if spec.input_format in JS_FORMATS]


def node_executable(paths: list[str]) -> str:
    node = shutil.which("node")
    if node is None:
        raise InvocationError(
            "node_missing",
            "Node.js is required to extract comments from JavaScript-family inputs, but node is not on PATH",
            remedy="install Node.js 24.0.0 or newer and make node available on PATH",
            details={"inputPaths": paths},
        )
    return node


def helper_path() -> Path:
    if not JS_HELPER.is_file():
        raise InvocationError(
            "source_parser_missing",
            f"the bundled comment extraction helper is missing: {JS_HELPER}",
            remedy="reinstall or update the plugin; in a development checkout, run npm run build",
            details={"helperPath": str(JS_HELPER)},
        )
    return JS_HELPER


def parser_failure(condition: str, **evidence: Any) -> InvocationError:
    return InvocationError(
        "source_parser_failed",
        condition,
        remedy="run the same command again; if it fails again, split the JavaScript-family inputs "
        "into smaller batches and report the failure",
        details={"task": JS_TASK, **evidence},
        status=1,
    )


def run_helper(arguments: list[str], request: bytes | None, paths: list[str]) -> dict:
    """Run the helper once and return its stdout JSON, or raise the relayed diagnosis."""
    command = [node_executable(paths), str(helper_path()), *arguments, "--json"]
    try:
        completed = subprocess.run(
            command, input=request if request is not None else b"", capture_output=True,
            timeout=JS_HELPER_TIMEOUT_SECONDS, shell=False, check=False,
        )
    except subprocess.TimeoutExpired:
        raise InvocationError(
            "source_parser_failed",
            f"JavaScript-family comment extraction did not finish within {JS_HELPER_TIMEOUT_SECONDS} seconds",
            remedy="split these JavaScript-family inputs into smaller explicit batches and run the checker again",
            details={"task": JS_TASK, "timeoutSeconds": JS_HELPER_TIMEOUT_SECONDS, "inputPaths": paths},
            status=1,
        ) from None
    except OSError as error:
        raise parser_failure(f"the comment extraction helper could not start: {error.strerror or error}") from None
    if completed.returncode == 0:
        try:
            return json.loads(completed.stdout.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise parser_failure("the comment extraction helper printed malformed JSON", childStatus=0) from None
    diagnosis = None
    try:
        envelope = json.loads(completed.stderr.decode("utf-8"))
        if isinstance(envelope, dict) and isinstance(envelope.get("error"), dict):
            diagnosis = envelope["error"]
    except (UnicodeDecodeError, ValueError):
        pass
    evidence: dict[str, Any] = {"childStatus": completed.returncode}
    if diagnosis is not None and all(isinstance(diagnosis.get(key), str) for key in ("code", "condition", "remedy")):
        if completed.returncode == 2 and diagnosis["code"] in HELPER_STARTUP_CODES:
            extra = {key: value for key, value in diagnosis.items() if key not in {"code", "condition", "remedy"}}
            raise InvocationError(
                diagnosis["code"], diagnosis["condition"], remedy=diagnosis["remedy"],
                details={**extra, "inputPaths": paths} if paths else extra or None,
            )
        evidence["childCode"] = diagnosis["code"]
        evidence["childCondition"] = diagnosis["condition"]
    raise parser_failure("the comment extraction helper failed", **evidence)


def check_js_readiness(paths: list[str]) -> None:
    """The helper's own preflight: Node.js version and the user-level parser install."""
    status = run_helper(["--preflight"], None, paths)
    if not isinstance(status, dict) or status.get("status") != "ready":
        raise parser_failure("the comment extraction helper preflight printed an unexpected report")


# --- Extraction ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CommentSpan:
    kind: str  # "line" or "block"
    start: int  # inclusive offset in canonical source
    end: int  # exclusive offset in canonical source


class SourceParseError(Exception):
    def __init__(self, reason: str, message: str, offset: int | None = None):
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.offset = offset


def parser_view(text: str) -> tuple[str, int]:
    """Remove only an initial BOM; the shift maps view offsets back to canonical ones."""
    return (text[1:], 1) if text.startswith("﻿") else (text, 0)


def line_start_offsets(text: str) -> list[int]:
    return [0] + [index + 1 for index, character in enumerate(text) if character == "\n"]


def python_comment_spans(view: str, path: str) -> list[CommentSpan]:
    """Comment tokens of syntax ast.parse accepts; positions are view offsets."""
    starts = line_start_offsets(view)

    def offset(line: int, column: int) -> int | None:
        if 1 <= line <= len(starts):
            return min(starts[line - 1] + max(column, 0), len(view))
        return None

    spans: list[CommentSpan] = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            ast.parse(view, filename=path, mode="exec", type_comments=False)
            for token in tokenize.generate_tokens(io.StringIO(view).readline):
                if token.type == tokenize.ERRORTOKEN:
                    raise SourceParseError(
                        "ErrorToken", f"unexpected token {token.string!r}", offset(*token.start)
                    )
                if token.type == tokenize.COMMENT:
                    start, end = offset(*token.start), offset(*token.end)
                    if start is None or end is None or view[start:end] != token.string:
                        raise SourceParseError("TokenPosition", "a comment token position is inconsistent")
                    spans.append(CommentSpan("line", start, end))
        except SyntaxError as error:  # Includes IndentationError and TabError.
            position = None
            if error.lineno is not None:
                position = offset(error.lineno, (error.offset or 1) - 1)
            raise SourceParseError(type(error).__name__, error.msg or str(error), position) from None
        except tokenize.TokenError as error:
            message, location = (error.args + ("", None))[:2]
            position = offset(*location) if isinstance(location, tuple) and len(location) == 2 else None
            raise SourceParseError("TokenError", str(message), position) from None
        except (ValueError, RecursionError, MemoryError) as error:
            raise SourceParseError(type(error).__name__, str(error) or type(error).__name__) from None
    return spans


def utf16_to_code_points(text: str, boundaries: Iterable[int]) -> dict[int, int]:
    """Map UTF-16 offsets to Python string offsets in one pass over sorted boundaries."""
    targets = sorted(set(boundaries))
    mapping: dict[int, int] = {}
    pending = 0
    units = 0
    for index, character in enumerate(text):
        while pending < len(targets) and targets[pending] <= units:
            if targets[pending] < units:
                raise ValueError(f"offset {targets[pending]} falls inside a surrogate pair")
            mapping[targets[pending]] = index
            pending += 1
        if pending == len(targets):
            return mapping
        units += 2 if ord(character) > 0xFFFF else 1
    while pending < len(targets) and targets[pending] <= units:
        if targets[pending] < units:
            raise ValueError(f"offset {targets[pending]} falls inside a surrogate pair")
        mapping[targets[pending]] = len(text)
        pending += 1
    if pending < len(targets):
        raise ValueError(f"offset {targets[pending]} is beyond the end of the input")
    return mapping


def js_comment_spans(entries: list[tuple[int, InputSpec, str]]) -> dict[int, list[CommentSpan] | SourceParseError]:
    """Extract every JS-family input with one helper process; positions are view offsets."""
    paths = [spec.path for _, spec, _ in entries]
    request = {
        "protocolVersion": PROTOCOL_VERSION,
        "files": [
            {"id": number, "path": spec.path, "profile": spec.profile, "text": view}
            for number, spec, view in entries
        ],
    }
    response = run_helper([], json.dumps(request, ensure_ascii=False).encode("utf-8"), paths)

    def malformed(condition: str) -> InvocationError:
        return parser_failure(f"the comment extraction helper returned a malformed result: {condition}")

    result = response.get("result") if isinstance(response, dict) and list(response) == ["result"] else None
    if not isinstance(result, dict):
        raise malformed("missing result envelope")
    if result.get("protocolVersion") != PROTOCOL_VERSION or result.get("offsetEncoding") != "utf16":
        raise malformed("unexpected protocol version or offset encoding")
    files = result.get("files")
    if not isinstance(files, list) or [item.get("id") if isinstance(item, dict) else None for item in files] != [
        number for number, _, _ in entries
    ]:
        raise malformed("file results do not match the requested inputs")
    extracted: dict[int, list[CommentSpan] | SourceParseError] = {}
    for item, (number, _, view) in zip(files, entries):
        if set(item) == {"id", "error"} and isinstance(item["error"], dict):
            error = item["error"]
            offset = error.get("offset")
            if not isinstance(error.get("reason"), str) or not isinstance(error.get("message"), str) or not (
                offset is None or (isinstance(offset, int) and not isinstance(offset, bool))
            ):
                raise malformed("a parse error has invalid fields")
            position = None
            if offset is not None:
                try:
                    position = utf16_to_code_points(view, [offset])[offset]
                except ValueError as conversion:
                    raise malformed(str(conversion)) from None
            extracted[number] = SourceParseError(error["reason"], error["message"], position)
            continue
        comments = item.get("comments") if set(item) == {"id", "comments"} else None
        if not isinstance(comments, list):
            raise malformed("a file result has neither comments nor an error")
        bounds: list[tuple[str, int, int]] = []
        previous_end = 0
        for comment in comments:
            if not (
                isinstance(comment, dict) and set(comment) == {"kind", "start", "end"}
                and comment["kind"] in {"line", "block"}
                and all(isinstance(comment[key], int) and not isinstance(comment[key], bool) for key in ("start", "end"))
                and previous_end <= comment["start"] < comment["end"]
            ):
                raise malformed("a comment range is invalid or out of order")
            previous_end = comment["end"]
            bounds.append((comment["kind"], comment["start"], comment["end"]))
        try:
            mapping = utf16_to_code_points(view, [value for _, start, end in bounds for value in (start, end)])
        except ValueError as conversion:
            raise malformed(str(conversion)) from None
        extracted[number] = [CommentSpan(kind, mapping[start], mapping[end]) for kind, start, end in bounds]
    return extracted


# --- Comment prose policy ----------------------------------------------------------------

PY_DIRECTIVE = re.compile(r"(?:type:\s*\S|(?i:noqa)\s*(?::|$)|(?:ruff|pylint|mypy|pyright|fmt|isort):\s*\S)")
PY_ENCODING = re.compile(r"#.*?coding[:=][ \t]*[-\w.]+")
JS_DIRECTIVE = re.compile(
    r"(?:@ts-(?:check|nocheck|ignore|expect-error)(?![\w-])"
    r"|eslint-(?:disable(?:-next-line|-line)?|enable|env)(?![\w-])"
    r"|eslint\s+[@\w/-]+\s*:"
    r"|prettier-ignore(?![\w-])"
    r"|(?:istanbul|c8)\s+ignore(?![\w-])"
    r"|[@#]__PURE__(?!\w)"
    r"|[#@]\s*source(?:Mapping)?URL=)"
)
# What may separate two line comments of one run: nothing but one line feed and
# indentation. JavaScript also ends a line comment at U+2028 or U+2029, so a run
# is never joined across those or across anything else on the line.
RUN_GAP = re.compile(r"[ \t\f]*\n[ \t\f]*")
TRIPLE_SLASH_DIRECTIVE = re.compile(r"<(?:reference|amd-module|amd-dependency)\b")
SPDX = re.compile(r"SPDX-License-Identifier:")
LABEL = re.compile(r"(?:TODO|FIXME|NOTE|HACK|XXX)(?![\w-]):?")
DOC_TAG = re.compile(r"@([A-Za-z][\w-]*)")
FENCE = re.compile(r"(`{3,}|~{3,})(.*)$")
PARAM_TAGS = {"param", "arg", "argument"}
RETURN_TAGS = {"return", "returns", "throw", "throws"}
TEXT_TAGS = {"description", "summary", "remarks", "deprecated"}
CLOSERS = {"{": "}", "[": "]"}


@dataclass(frozen=True)
class AnalysisRegion:
    start: int
    end: int
    masked_text: str


@dataclass(frozen=True)
class SkippedSpan:
    reason: str
    start: int
    end: int


@dataclass(frozen=True)
class SourceAnalysis:
    input_format: str
    comment_count: int
    regions: tuple[AnalysisRegion, ...]
    skipped: tuple[SkippedSpan, ...]


def masked_copy(text: str, spans: Iterable[tuple[int, int]]) -> str:
    """Replace span characters with spaces in one pass, keeping line terminators."""
    characters = list(text)
    for start, end in spans:
        for index in range(start, end):
            if characters[index] != "\n":
                characters[index] = " "
    return "".join(characters)


def trim(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def balanced_end(text: str, start: int, limit: int, quotes: bool = True) -> int | None:
    """End of the {...} or [...] group opening at start.

    Type and name scaffolds honor quotes and escapes. Inline {@link ...} text
    is prose, where an apostrophe is not a quote, so callers pass quotes=False.
    """
    stack = [CLOSERS[text[start]]]
    quote = None
    index = start + 1
    while index < limit:
        character = text[index]
        if quote:
            if character == "\\":
                index += 1
            elif character == quote:
                quote = None
        elif quotes and character in "'\"`":
            quote = character
        elif character in CLOSERS:
            stack.append(CLOSERS[character])
        elif character in "}]":
            if character != stack.pop():
                return None
            if not stack:
                return index + 1
        index += 1
    return None


def label_span(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """A leading TODO-style label and optional colon; the explanation stays checkable."""
    body, _ = trim(text, start, end)
    label = LABEL.match(text, body, end)
    return [label.span()] if label else []


class CommentPolicy:
    """Turn one file's comment spans into prose regions and visible skips."""

    def __init__(self, text: str, language: str, origin: int):
        self.text = text
        self.language = language
        self.origin = origin
        self.line_starts = line_start_offsets(text)
        self.regions: list[AnalysisRegion] = []
        self.skipped: list[SkippedSpan] = []

    def line_of(self, offset: int) -> int:
        return bisect_right(self.line_starts, offset) - 1

    def skip(self, reason: str, start: int, end: int, masked: str | None = None, base: int = 0) -> None:
        """Record an excluded span, trimmed against the masked comment when one is given."""
        if masked is None:
            masked, base = self.text, 0
        local_start, local_end = trim(masked, start - base, end - base)
        if local_start < local_end:
            self.skipped.append(SkippedSpan(reason, base + local_start, base + local_end))

    def add_region(self, start: int, masked: str) -> None:
        """masked is the same length as text[start:...]; only nonblank prose counts."""
        if not masked.strip():
            return
        local_start, local_end = trim(masked, 0, len(masked))
        self.regions.append(AnalysisRegion(start + local_start, start + local_end, masked[local_start:local_end]))

    # Line comments ----------------------------------------------------------------------

    def marker_length(self, comment: CommentSpan) -> int:
        character = "#" if self.language == PYTHON else "/"
        body = self.text[comment.start:comment.end]
        return len(body) - len(body.lstrip(character))

    def line_directive(self, comment: CommentSpan) -> str | None:
        raw = self.text[comment.start:comment.end]
        marker = self.marker_length(comment)
        body = raw[marker:].strip()
        if self.language == PYTHON:
            if comment.start == self.origin and raw.startswith("#!"):
                return "tool_directive"
            if self.line_of(comment.start) - self.line_of(self.origin) <= 1 and PY_ENCODING.match(raw):
                return "tool_directive"
            if PY_DIRECTIVE.match(body):
                return "tool_directive"
        else:
            if marker == 3 and TRIPLE_SLASH_DIRECTIVE.match(body):
                return "tool_directive"
            if JS_DIRECTIVE.match(body):
                return "tool_directive"
        if SPDX.match(body):
            return "license"
        return None

    def line_start(self, offset: int) -> int:
        """Start of the offset's line; the first line starts after any BOM."""
        return max(self.line_starts[self.line_of(offset)], self.origin)

    def standalone(self, comment: CommentSpan) -> bool:
        return not self.text[self.line_start(comment.start):comment.start].strip()

    def run_key(self, comment: CommentSpan) -> tuple[str, str]:
        line_start = self.line_start(comment.start)
        return self.text[line_start:comment.start], self.text[comment.start:comment.start + self.marker_length(comment)]

    def line_run(self, run: list[CommentSpan]) -> None:
        start, end = run[0].start, run[-1].end
        region = self.text[start:end]
        spans: list[tuple[int, int]] = []
        for comment in run:
            local = comment.start - start
            marker_end = local + self.marker_length(comment)
            spans.append((local, marker_end))
            spans.extend(label_span(region, marker_end, comment.end - start))
        self.add_region(start, masked_copy(region, spans))

    # Block comments ---------------------------------------------------------------------

    def masked_block(self, comment: CommentSpan, opener: int) -> str:
        """Mask the delimiters and decorative leading stars, keeping the layout."""
        raw = self.text[comment.start:comment.end]
        spans = [(0, opener), (len(raw) - 2, len(raw))]
        offset = 0
        for number, line in enumerate(raw.splitlines(keepends=True)):
            if number:
                star = re.match(r"[ \t]*(\*)(?=[ \t\n]|$)", line)
                if star:
                    spans.append((offset + star.start(1), offset + star.end(1)))
            offset += len(line)
        return masked_copy(raw, spans)

    def block(self, comment: CommentSpan) -> None:
        raw = self.text[comment.start:comment.end]
        documentation = raw.startswith("/**") and raw != "/**/"
        masked = self.masked_block(comment, 3 if documentation else 2)
        body = masked.strip()
        if JS_DIRECTIVE.match(body):
            self.skip("tool_directive", comment.start, comment.end)
            return
        if SPDX.match(body):
            self.skip("license", comment.start, comment.end)
            return
        masked = self.mask_spdx_lines(comment.start, masked)
        if documentation:
            self.documentation(comment.start, masked)
        else:
            self.add_region(comment.start, masked_copy(masked, label_span(masked, 0, len(masked))))

    def mask_spdx_lines(self, start: int, masked: str) -> str:
        spans = []
        offset = 0
        for line in masked.splitlines(keepends=True):
            found = SPDX.search(line)
            if found and not line[:found.start()].strip():
                line_end = offset + len(line.rstrip("\n"))
                self.skip("license", start + offset + found.start(), start + line_end)
                spans.append((offset + found.start(), line_end))
            offset += len(line)
        return masked_copy(masked, spans)

    # Documentation comments -------------------------------------------------------------

    def sections(self, masked: str) -> list[tuple[str | None, int, int]]:
        """Split at tags that open a logical line outside fenced examples."""
        boundaries: list[tuple[str | None, int]] = [(None, 0)]
        fence = None
        offset = 0
        for line in masked.splitlines(keepends=True):
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            delimiter = FENCE.match(stripped.rstrip("\n"))
            if fence:
                if delimiter and delimiter[1][0] == fence[0] and len(delimiter[1]) >= fence[1] and not delimiter[2].strip():
                    fence = None
            elif delimiter:
                fence = (delimiter[1][0], len(delimiter[1]))
            else:
                tag = DOC_TAG.match(stripped)
                if tag:
                    boundaries.append((tag[1], offset + indent))
            offset += len(line)
        sections = []
        for number, (tag, start) in enumerate(boundaries):
            end = boundaries[number + 1][1] if number + 1 < len(boundaries) else len(masked)
            sections.append((tag, start, end))
        return sections

    def documentation(self, start: int, masked: str) -> None:
        for tag, section_start, section_end in self.sections(masked):
            if tag is None:
                self.doc_description(start, masked, section_start, section_end, section_start, section_end)
                continue
            after_tag = section_start + 1 + len(tag)
            if tag == "example":
                self.skip("doc_example", start + section_start, start + section_end, masked, start)
            elif tag in {"license", "preserve"}:
                self.skip("license", start + section_start, start + section_end, masked, start)
            elif tag in TEXT_TAGS:
                self.doc_description(start, masked, after_tag, section_end, section_start, section_end)
            elif tag in PARAM_TAGS or tag in RETURN_TAGS:
                description = self.scaffold_end(masked, after_tag, section_end, tag in PARAM_TAGS)
                if description is None:
                    self.skip("unsupported_doc_structure", start + section_start, start + section_end, masked, start)
                else:
                    self.doc_description(start, masked, description, section_end, section_start, section_end)
            else:
                self.skip("unsupported_doc_tag", start + section_start, start + section_end, masked, start)

    def scaffold_end(self, masked: str, index: int, limit: int, named: bool) -> int | None:
        """Skip an optional {type}, a parameter name, and a separator; None when unclear."""

        def spaces(position: int) -> int:
            while position < limit and masked[position].isspace():
                position += 1
            return position

        index = spaces(index)
        if index < limit and masked[index] == "{":
            closed = balanced_end(masked, index, limit)
            if closed is None:
                return None
            index = spaces(closed)
        if named:
            if index >= limit:
                return None
            if masked[index] == "[":
                closed = balanced_end(masked, index, limit)
                if closed is None:
                    return None
                index = closed
            else:
                name = re.compile(r"[^\s{}\[\]]+").match(masked, index, limit)
                if name is None:
                    return None
                index = name.end()
            index = spaces(index)
        if index < limit and masked[index] == "-":
            index = spaces(index + 1)
        return index

    def doc_description(self, start: int, masked: str, prose_start: int, prose_end: int,
                        section_start: int, section_end: int) -> None:
        """One checkable section; inline {@link ...} constructs stay exact."""
        spans = label_span(masked, prose_start, prose_end)
        index = prose_start
        while True:
            found = masked.find("{@", index, prose_end)
            if found < 0:
                break
            closed = balanced_end(masked, found, prose_end, quotes=False)
            if closed is None:
                self.skip("unsupported_doc_structure", start + section_start, start + section_end, masked, start)
                return
            spans.append((found, closed))
            index = closed
        self.add_region(start + prose_start, masked_copy(masked[prose_start:prose_end],
                                                          ((a - prose_start, b - prose_start) for a, b in spans)))

    # File -------------------------------------------------------------------------------

    def analyze(self, comments: list[CommentSpan]) -> None:
        run: list[CommentSpan] = []
        for comment in comments:
            if comment.kind == "block":
                if run:
                    self.line_run(run)
                    run = []
                self.block(comment)
                continue
            reason = self.line_directive(comment)
            if reason is not None:
                if run:
                    self.line_run(run)
                    run = []
                self.skip(reason, comment.start, comment.end)
                continue
            if not self.standalone(comment):
                if run:
                    self.line_run(run)
                    run = []
                self.line_run([comment])
                continue
            if run and not (
                RUN_GAP.fullmatch(self.text, run[-1].end, comment.start)
                and self.run_key(comment) == self.run_key(run[-1])
            ):
                self.line_run(run)
                run = []
            run.append(comment)
        if run:
            self.line_run(run)


def analyze_comments(text: str, input_format: str, comments: list[CommentSpan], origin: int) -> SourceAnalysis:
    policy = CommentPolicy(text, PYTHON if input_format == PYTHON else "javascript", origin)
    policy.analyze(comments)
    return SourceAnalysis(
        input_format=input_format,
        comment_count=len(comments),
        regions=tuple(policy.regions),
        skipped=tuple(sorted(policy.skipped, key=lambda item: (item.start, item.end))),
    )


def parse_failure(spec: InputSpec, text: str, error: SourceParseError) -> dict[str, Any]:
    entry: dict[str, Any] = {"path": spec.path, "condition": error.message, "inputFormat": spec.input_format,
                             "reason": error.reason}
    if error.offset is not None:
        offset = min(max(error.offset, 0), len(text))
        line = text.count("\n", 0, offset) + 1
        column = offset - (text.rfind("\n", 0, offset) + 1) + 1
        entry["condition"] = f"{error.message} (line {line}, column {column})"
        entry.update({"offset": offset, "line": line, "column": column})
    return entry


def prepare_sources(inputs: list[tuple[InputSpec, str]]) -> list[SourceAnalysis | None]:
    """Extract every source input before any English check runs.

    Returns one entry per input, None for prose. Parse failures are collected in
    caller order into one source_parse_failed error; infrastructure failures stop
    extraction at once.
    """
    analyses: list[SourceAnalysis | None] = [None] * len(inputs)
    failures: dict[int, dict[str, Any]] = {}
    views: dict[int, tuple[str, int]] = {}
    js_entries: list[tuple[int, InputSpec, str]] = []
    for number, (spec, text) in enumerate(inputs):
        if not spec.is_source:
            continue
        view, origin = parser_view(text)
        views[number] = (view, origin)
        if spec.input_format == PYTHON:
            try:
                spans = python_comment_spans(view, spec.path)
            except SourceParseError as error:
                failures[number] = parse_failure(spec, text, shifted(error, origin))
                continue
            analyses[number] = analysis_for(spec, text, spans, origin)
        else:
            js_entries.append((number, spec, view))
    if js_entries:
        for number, extracted in js_comment_spans(js_entries).items():
            spec, text = inputs[number]
            origin = views[number][1]
            if isinstance(extracted, SourceParseError):
                failures[number] = parse_failure(spec, text, shifted(extracted, origin))
            else:
                analyses[number] = analysis_for(spec, text, extracted, origin)
    if failures:
        raise InvocationError(
            "source_parse_failed",
            "one or more source inputs could not be parsed, so no comments were checked",
            [failures[number] for number in sorted(failures)],
            remedy="correct the reported syntax or select the correct --input-format; "
            "comment checking supports only syntax that the documented parser profiles accept",
        )
    return analyses


def shifted(error: SourceParseError, origin: int) -> SourceParseError:
    if error.offset is None or not origin:
        return error
    return SourceParseError(error.reason, error.message, error.offset + origin)


def analysis_for(spec: InputSpec, text: str, spans: list[CommentSpan], origin: int) -> SourceAnalysis:
    canonical = [CommentSpan(span.kind, span.start + origin, span.end + origin) for span in spans]
    return analyze_comments(text, spec.input_format, canonical, origin)
