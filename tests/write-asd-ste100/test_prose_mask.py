"""Golden input/expected-output cases for prose masking and complete check_file findings.

The expected values are literal outputs of the production checker, captured once.
They replace a frozen copy of an older implementation that this file used as a
differential oracle. Update a golden value only for a deliberate behavior change.
"""
import json
from pathlib import Path
import sys
import unittest

from plugin_paths import SCRIPTS
sys.path.insert(0, str(SCRIPTS))
import ste_check

GOLDEN_FINDINGS = Path(__file__).with_name('prose_mask_golden.json')

# (text, spans, masked): overlapping, adjacent, nested, duplicate, unsorted and
# zero-width spans, spans at both ends, CRLF, accents and astral characters.
MASK_CASES = [
    ('', [],
     ''),
    ('abc', [],
     'abc'),
    ('abcdef', [(0, 0), (6, 6), (3, 3)],
     'abcdef'),
    ('abcdef', [(0, 6)],
     '      '),
    ('abcdef', [(0, 2)],
     '  cdef'),
    ('abcdef', [(4, 6)],
     'abcd  '),
    ('abcdefgh', [(1, 3), (3, 5)],
     'a    fgh'),
    ('abcdefgh', [(1, 4), (2, 6)],
     'a     gh'),
    ('abcdefgh', [(1, 7), (2, 4)],
     'a      h'),
    ('abcdefgh', [(2, 4), (2, 4)],
     'ab  efgh'),
    ('abcdefgh', [(5, 7), (0, 2), (3, 4)],
     '  c e  h'),
    ('ab\r\ncd\nef', [(1, 5), (7, 8)],
     'a    d\n f'),
    ('🙂a\r\nbéZ', [(1, 3), (3, 5), (2, 4), (6, 6)],
     '🙂    éZ'),
    ('字段🙂 CAFÉ🙂\r\n', [(1, 3), (8, 11)],
     '字   CAFÉ   '),
]

# (text, masked): one case per original fragment, then fence, quote, diagnostic,
# and PROTECTED-pattern edge cases.
PROTECT_CASES = [
    ('ordinary prose; ',
     'ordinary prose; '),
    ('`obj.method()` ',
     '               '),
    ('https://example.invalid/a ',
     '                          '),
    ('\n```py\nobj.method()\n```\n',
     '\n                       '),
    ('\n~~~\nhello\n~~~~\n',
     '\n               '),
    ('\n> quoted line\n',
     '\n              '),
    ('“words; café” ',
     '              '),
    ('use --flag=value ',
     'use              '),
    ("it's text. ",
     "it's text. "),
    ('\r\n',
     '\r\n'),
    ('\nWarning: example\n',
     '\n                 '),
    ('字段🙂 ',
     '字段🙂 '),
    ('file_name ',
     '          '),
    ('/some/path ',
     '           '),
    ('\n\n',
     '\n\n'),
    ('"https://example.invalid/quoted" ',
     '                                 '),
    ('\\"escape;\\" ',
     '\\           '),
    ('alpha beta gamma delta. ',
     'alpha beta gamma delta. '),
    ('beta gamma. ',
     'beta gamma. '),
    ('gamma delta. ',
     'gamma delta. '),
    ("we're they're isn't I'd. ",
     "we're they're isn't I'd. "),
    ('is checked. running. ',
     'is checked. running. '),
    ('CAFÉ🙂\r\n',
     'CAFÉ🙂\r\n'),
    ('```\nunclosed; fence\nstill code;\n',
     '                                '),
    ('````md\n```\ninner; text\n````\nafter; fence\n',
     '                            after; fence\n'),
    ('~~~\ncode;\n```\nstill; code\n~~~\nout; side\n',
     '                              out; side\n'),
    ('  ```\nindented fence;\n  ```\nprose; here\n',
     '                            prose; here\n'),
    ('```py\ncode\n``` trailing\nstill; code\n```\n',
     '                                        '),
    ('visit www.example.invalid/x; then\n',
     'visit                        then\n'),
    ('go ~/conf/file; ../up/dir ./here,x\n',
     'go            ;                 ,x\n'),
    ('open C:\\Users\\me\\file.txt; now\n',
     'open                       now\n'),
    ('-v and --long-opt; and -x=1\n',
     '   and           ; and     \n'),
    ('camelCase; snake_case Foo::bar::baz obj.attr.sub run() call;\n',
     '         ;                                             call;\n'),
    ('‘single; quoted’ “double; quoted” "plain; quoted"\n',
     '                                                 \n'),
    ('error: bad; thing\nfatal: x;\nTraceback (most recent call last);\nexception: e;\ncaused by: y;\n  at frame;\nnot at; diag\n',
     '                                                                                             at frame;\nnot at; diag\n'),
    ('> quote; one\n   > indented quote;\nplain; line\n',
     '                                  plain; line\n'),
    ('a\r\n```\r\ncode;\r\n```\r\nb;\r\n',
     'a\r\n                 b;\r\n'),
    ('mixed 字段; 🙂 `x;y` end;',
     'mixed 字段; 🙂       end;'),
]

BENCHMARK_ROW = 'Use `tool.run()` with --flag=value and "quoted text" at https://example.invalid/ref.\n'
BENCHMARK_ROW_MASKED = 'Use              with              and               at                             \n'

# Phrases of different lengths collide across approved, project and unapproved entries.
APPROVED = {'use': [], 'alpha beta gamma': [], 'alpha beta': []}
TERMS = {'gamma delta': [], 'project name': []}


def record(source):
    return [{'source': source, 'meaning_or_alternatives': ['replace'], 'rule': '1.1'}]


UNAPPROVED = {'beta gamma delta': record('dictionary'),
              'beta gamma': record(ste_check.SOURCE_SOFTWARE),
              'gamma delta': record('dictionary'), 'ordinary': record('dictionary')}


class ProseMaskTests(unittest.TestCase):
    def test_mask_spans_golden(self):
        for i, (text, spans, expected) in enumerate(MASK_CASES):
            with self.subTest(case=i):
                self.assertEqual(ste_check.mask_spans(text, iter(spans)), expected)
                self.assertEqual(ste_check.mask_spans(text, list(reversed(spans))), expected)
                self.assertEqual(len(expected), len(text))

    def test_protect_markdown_golden(self):
        for i, (text, expected) in enumerate(PROTECT_CASES):
            with self.subTest(case=i):
                self.assertEqual(ste_check.protect_markdown(text), expected)
                self.assertEqual(len(expected), len(text))

    def test_benchmark_workload_golden(self):
        for lines in (500, 1000, 2000, 4000):
            with self.subTest(lines=lines):
                self.assertEqual(ste_check.protect_markdown(BENCHMARK_ROW * lines),
                                 BENCHMARK_ROW_MASKED * lines)

    def test_check_file_golden_findings(self):
        cases = json.loads(GOLDEN_FINDINGS.read_text(encoding='utf-8'))
        self.assertTrue(any(case['report_unknown_terms'] for case in cases))
        self.assertTrue(any(not case['report_unknown_terms'] for case in cases))
        for i, case in enumerate(cases):
            for mode, expected in case['expected'].items():
                with self.subTest(case=i, mode=mode):
                    actual = ste_check.check_file(case['text'], mode, {}, APPROVED, UNAPPROVED,
                                                  TERMS, case['report_unknown_terms'])
                    self.assertEqual(json.dumps(actual, ensure_ascii=False),
                                     json.dumps(expected, ensure_ascii=False))


if __name__ == '__main__':
    unittest.main()
