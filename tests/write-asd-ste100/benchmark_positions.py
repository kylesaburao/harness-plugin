#!/usr/bin/env python3
"""Paired checker processing and CLI measurements, outside unittest discovery."""
import importlib.util
import json
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time

baseline_root, evidence = map(Path, sys.argv[1:])
repo = Path(__file__).resolve().parents[2]
evidence.mkdir(parents=True, exist_ok=True)
relative = Path('plugins/harness/skills/write-asd-ste100/scripts')
sys.path.insert(0, str(repo / relative))
import ste_data

def load(root, name):
    spec = importlib.util.spec_from_file_location(name, root / relative / 'ste_check.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

modules = {'baseline': load(baseline_root, 'baseline'), 'current': load(repo, 'current')}
ste_data.ensure_references_ready()
dictionary = ste_data.load_dictionary()
software = ste_data.load_software_terms()
merged = ste_data.merge_layers(dictionary, software, ste_data.LAYERS)

report = {'python': platform.python_version(), 'baseline': str(baseline_root), 'warmups': 1, 'pairs': 3, 'cases': []}
for name, text, dictionaries in [(f'synthetic-{n}', 'Foobarqux.\n' * n, ({}, {}, {}, {})) for n in (2000, 8000, 32000)] + [
    (name, (repo / name).read_text(), (merged.by_headword, merged.approved_forms, merged.unapproved, {})) for name in ('README.md', 'AGENTS.md', 'CONTAINER.md')
]:
    samples = {key: [] for key in modules}
    cli_samples = {key: [] for key in modules}
    input_path = evidence / 'checker-input.md'
    input_path.write_text(text)
    for pair in range(-1, 3):
        results, cli_results = {}, {}
        order = ['baseline', 'current'] if pair % 2 == 0 else ['current', 'baseline']
        for key in order:
            start = time.perf_counter()
            results[key] = modules[key].check_file(text, 'procedural', *dictionaries)
            elapsed = (time.perf_counter() - start) * 1000
            if pair >= 0:
                samples[key].append(elapsed)
            root = baseline_root if key == 'baseline' else repo
            start = time.perf_counter()
            process = subprocess.run([sys.executable, str(root / relative / 'ste_check.py'), str(input_path), '--mode', 'procedural', '--json'], capture_output=True)
            elapsed = (time.perf_counter() - start) * 1000
            assert process.returncode in (0, 1), process.stderr
            cli_results[key] = (process.returncode, json.loads(process.stdout), process.stderr.decode())
            if pair >= 0:
                cli_samples[key].append(elapsed)
        assert results['baseline'] == results['current'], name
        assert cli_results['baseline'] == cli_results['current'], name
    case = {'name': name, 'characters': len(text), 'findings': len(results['current']['findings']),
            'processing_dictionaries': 'empty' if name.startswith('synthetic-') else 'existing reference bundle, all layers',
            'cli_dictionaries': 'existing reference bundle, all layers'}
    for label, values in [('processing', samples), ('cli', cli_samples)]:
        medians = {key: statistics.median(times) for key, times in values.items()}
        case[label] = {'samples_ms': values, 'median_ms': medians, 'saving_ms': medians['baseline'] - medians['current']}
    report['cases'].append(case)
    (evidence / 'positions.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(case), flush=True)
