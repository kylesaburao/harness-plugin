"""Test-only pre-F07 masking/check_file oracle from 89247e2a6e4241d81538ebb426e698fe29fc5e9d.
Unchanged helpers are shared with production. Do not update masking to match production.
"""
from __future__ import annotations
from ste_check import *


def mask_span(text: str, start: int, end: int) -> str:
    return text[:start] + " " * (end - start) + text[end:]


def protect_markdown(text: str) -> str:
    masked = text
    protected: list[tuple[int, int]] = []
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        line_start = offset
        line_end = offset + len(line)
        delimiter = re.match(r"(`{3,}|~{3,})(.*)$", stripped.rstrip("\r\n"))
        if fence:
            protected.append((line_start, line_end))
            if delimiter and delimiter[1][0] == fence[0] and len(delimiter[1]) >= fence[1] and not delimiter[2].strip():
                fence = None
        elif delimiter:
            fence = (delimiter[1][0], len(delimiter[1]))
            protected.append((line_start, line_end))
        elif stripped.startswith(">") or DIAGNOSTIC.match(line):
            protected.append((line_start, line_end))
        offset = line_end
    for pattern in PROTECTED:
        for match in pattern.finditer(text):
            protected.append(match.span())
    for start, end in sorted(protected, reverse=True):
        masked = mask_span(masked, start, end)
    return masked


def check_file(
    text: str,
    mode: str,
    by_headword: dict,
    approved_forms: dict,
    unapproved: dict,
    terms: dict,
    report_unknown_terms: bool = True,
) -> dict:
    newline_offsets = [-1] + [i for i, character in enumerate(text) if character == "\n"]
    masked = protect_markdown(text)
    contraction_matches = list(CONTRACTION.finditer(masked))
    findings: list[Finding] = []

    for match in re.finditer(";", masked):
        findings.append(make_finding(
            newline_offsets=newline_offsets,
            severity="error", rule="8.1", category="semicolon",
            problem="Natural-language prose contains a semicolon.", text=text,
            start=match.start(), end=match.end(), action_type="rewrite_without_semicolon",
            instruction="Rewrite the text without a semicolon.", candidates=[], evidence={},
        ))
    for match in contraction_matches:
        findings.append(make_finding(
            newline_offsets=newline_offsets,
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
                    newline_offsets=newline_offsets,
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
                    newline_offsets=newline_offsets,
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
                    newline_offsets=newline_offsets,
                    severity="review", rule=records[0].get("rule", "1.1"), category="overused_term",
                    problem="The expression is an overused AI-coding-assistant tic.", text=text,
                    start=match.start(), end=match.end(), action_type="review_overused_term",
                    instruction="Review this expression and consider an alternative an engineer would write.",
                    candidates=dictionary_candidates(records), evidence={"source": source},
                ))
            else:
                findings.append(make_finding(
                    newline_offsets=newline_offsets,
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
                    newline_offsets=newline_offsets,
                    severity="review", rule=records[0].get("rule", "1.1"), category="overused_term",
                    problem="The word is an overused AI-coding-assistant tic.", text=text,
                    start=match.start(), end=match.end(), action_type="review_overused_term",
                    instruction="Review this word and consider an alternative an engineer would write.",
                    candidates=dictionary_candidates(records), evidence={"source": source},
                ))
            else:
                findings.append(make_finding(
                    newline_offsets=newline_offsets,
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
                newline_offsets=newline_offsets,
                severity="error", rule="1.4", category="unapproved_form",
                problem="The word form is not approved.", text=text,
                start=match.start(), end=match.end(), action_type="use_approved_form",
                instruction="Use an approved form of this word.", candidates=allowed, evidence={},
            ))
            continue
        if report_unknown_terms:
            findings.append(make_finding(
                newline_offsets=newline_offsets,
                severity="review", rule="1.5/1.12", category="unknown_term",
                problem="The term is not in the approved dictionary or project terminology.", text=text,
                start=match.start(), end=match.end(), action_type="review_terminology",
                instruction="Review this term as a possible technical noun or technical verb.", candidates=[],
                evidence={"normalized_term": key},
            ))

    for match in PASSIVE.finditer(masked):
        findings.append(make_finding(
            newline_offsets=newline_offsets,
            severity="warning", rule="3.6", category="passive_voice",
            problem="The text can contain passive voice.", text=text,
            start=match.start(), end=match.end(), action_type="review_active_voice",
            instruction="Review the agent and use active voice when it is suitable.", candidates=[], evidence={},
        ))
    for match in re.finditer(r"\b[A-Za-z]+ing\b", masked, re.I):
        key = match.group(0).casefold()
        if key not in approved_forms and key not in terms:
            findings.append(make_finding(
                newline_offsets=newline_offsets,
                severity="warning", rule="3.5", category="unapproved_ing_form",
                problem="The -ing form can be unapproved.", text=text,
                start=match.start(), end=match.end(), action_type="review_word_form",
                instruction="Review the word form and its technical-noun use.", candidates=[], evidence={},
            ))

    for match in re.finditer(r"\b(?:[A-Za-z][A-Za-z-]*\s+){3,}[A-Za-z][A-Za-z-]*\b", masked):
        words = WORD.findall(match.group(0))
        if 4 <= len(words) <= 6 and not any(word.casefold() in {"and", "or", "the", "a", "an", "to", "of", "in", "for", "with"} for word in words):
            findings.append(make_finding(
                newline_offsets=newline_offsets,
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
