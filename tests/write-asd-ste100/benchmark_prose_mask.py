#!/usr/bin/env python3
"""Supplied F07 workload, measuring either baseline or production in this process.
Adaptation: import real production or frozen oracle instead of selecting old AST
names and rewriting the old loop into a prototype. Workload and sizes unchanged.
Run each --variant in a separate process. No full-checker timing or CI threshold.
"""
import argparse
import json
from pathlib import Path
import statistics
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--variant', choices=['baseline', 'implementation'], required=True)
parser.add_argument('--repeats', type=int, default=3)
args = parser.parse_args()
if not 1 <= args.repeats <= 10:
    parser.error('--repeats must be 1..10')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'plugins/harness/skills/write-asd-ste100/scripts'))
if args.variant == 'baseline':
    from prose_mask_baseline import protect_markdown
else:
    from ste_check import protect_markdown
row = 'Use `tool.run()` with --flag=value and "quoted text" at https://example.invalid/ref.\n'
results = []
for lines in [500, 1000, 2000, 4000]:
    text = row * lines
    samples = []
    for _ in range(args.repeats):
        start = time.perf_counter()
        protect_markdown(text)
        samples.append(time.perf_counter() - start)
    results.append({'lines': lines, 'characters': len(text), 'repetitions': args.repeats,
                    'seconds_median': statistics.median(samples), 'samples_seconds': samples})
print(json.dumps({'python': sys.version, 'variant': args.variant,
                  'scope': 'protect_markdown only, supplied synthetic identifier-dense workload',
                  'measurements': results}, indent=2))
