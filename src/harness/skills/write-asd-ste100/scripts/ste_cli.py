"""Shared argument diagnostics for the checker and lookup commands."""
from __future__ import annotations
import argparse
import json
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from typing import Any, NoReturn

@dataclass(frozen=True)
class InvocationError(Exception):
    code: str
    condition: str
    inputs: list[dict[str, Any]] | None = None
    remedy: str = "run python3 ste_check.py --help and correct the reported input"
    # Further camelCase evidence fields reported beside code, condition, and remedy.
    details: dict[str, Any] | None = None
    # 2 means the work never started; 1 means extraction started and failed.
    status: int = 2


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise InvocationError("usage_error", message, remedy=f"run python3 {self.prog} --help and correct the arguments")


def report_invocation_error(error: InvocationError, json_output: bool) -> None:
    details: dict[str, Any] = {"code": error.code, "condition": error.condition, "remedy": error.remedy}
    if error.details:
        details.update(error.details)
    if error.inputs is not None:
        details["inputs"] = error.inputs
    if json_output:
        print(json.dumps({"error": details}, ensure_ascii=False), file=sys.stderr)
        return
    if error.inputs is not None:
        for item in error.inputs:
            print(f"ERROR [{error.code}]: {item['path']}: {item['condition']}", file=sys.stderr)
        print(f"Remedy: {error.remedy}", file=sys.stderr)
        return
    print(f"ERROR [{error.code}]: {error.condition}", file=sys.stderr)
    print(f"Remedy: {error.remedy}", file=sys.stderr)
