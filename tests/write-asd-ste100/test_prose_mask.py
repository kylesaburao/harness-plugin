"""Differential coverage for batching, with a frozen pre-F07 policy oracle."""
import json
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'plugins/harness/skills/write-asd-ste100/scripts'))
import ste_check
import prose_mask_baseline as baseline

PARTS = ['ordinary prose; ', '`obj.method()` ', 'https://example.invalid/a ',
         '\n```py\nobj.method()\n```\n', '\n~~~\nhello\n~~~~\n', '\n> quoted line\n',
         '“words; café” ', 'use --flag=value ', "it's text. ", '\r\n',
         '\nWarning: example\n', '字段🙂 ', 'file_name ', '/some/path ', '\n\n',
         '"https://example.invalid/quoted" ', '\\"escape;\\" ',
         'alpha beta gamma delta. ', 'beta gamma. ', 'gamma delta. ',
         "we're they're isn't I'd. ", 'is checked. running. ', 'CAFÉ🙂\r\n']


class ProseMaskTests(unittest.TestCase):
    def test_span_union_exact_character_offsets(self):
        rng = random.Random(1973)
        for i in range(360):
            text = ''.join(rng.choice(PARTS) for _ in range(rng.randrange(15)))
            spans = [tuple(sorted((rng.randrange(len(text)+1), rng.randrange(len(text)+1))))
                     for _ in range(rng.randrange(20))]
            expected = text
            for start, end in spans:
                expected = baseline.mask_span(expected, start, end)
            with self.subTest(case=i):
                self.assertEqual(ste_check.mask_spans(text, iter(spans)), expected)
                self.assertEqual(len(expected), len(text))
        self.assertEqual(ste_check.mask_spans('🙂a\r\nbéZ', [(1, 3), (3, 5), (2, 4), (6, 6)]), '🙂    éZ')

    def test_benchmark_workload_equivalence(self):
        row = 'Use `tool.run()` with --flag=value and "quoted text" at https://example.invalid/ref.\n'
        for lines in (500, 1000, 2000, 4000):
            text = row * lines
            self.assertEqual(ste_check.protect_markdown(text), baseline.protect_markdown(text))

    def test_policy_and_complete_findings_differential(self):
        rng = random.Random(9517)
        documents = ['', '\r\n', '\n```py\r\n🙂foo_bar\r\n```\r\n',
                     'alpha beta gamma delta beta gamma gamma delta.',
                     '"https://example.invalid/a" `foo_bar` café🙂;']
        documents += [''.join(rng.choice(PARTS) for _ in range(rng.randrange(1, 100)))
                      for _ in range(360)]
        def record(source):
            return [{'source': source, 'meaning_or_alternatives': ['replace'], 'rule': '1.1'}]
        # Different lengths collide across approved, project and unapproved phrases.
        approved = {'use': [], 'alpha beta gamma': [], 'alpha beta': []}
        terms = {'gamma delta': [], 'project name': []}
        unapproved = {'beta gamma delta': record('dictionary'),
                      'beta gamma': record(ste_check.SOURCE_SOFTWARE),
                      'gamma delta': record('dictionary'), 'ordinary': record('dictionary')}
        for i, text in enumerate(documents):
            with self.subTest(case=i):
                self.assertEqual(ste_check.protect_markdown(text), baseline.protect_markdown(text))
                for mode in ('procedural', 'descriptive', 'mixed'):
                    args = (text, mode, {}, approved, unapproved, terms, i % 2 == 0)
                    self.assertEqual(json.dumps(ste_check.check_file(*args), ensure_ascii=False),
                                     json.dumps(baseline.check_file(*args), ensure_ascii=False))


if __name__ == '__main__':
    unittest.main()
