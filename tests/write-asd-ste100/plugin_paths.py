"""Select the same installation-shaped test artifact as the Node helpers."""
import os
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
TARGET = os.environ.get('HARNESS_TEST_TARGET', 'development')
TARGETS = {'development': '.build/harness', 'distribution': 'dist/harness'}
if TARGET not in TARGETS:
    raise ValueError(f'Invalid HARNESS_TEST_TARGET: {TARGET!r}')
ARTIFACT_ROOT = REPOSITORY_ROOT / TARGETS[TARGET]
SCRIPTS = ARTIFACT_ROOT / 'skills/write-asd-ste100/scripts'
