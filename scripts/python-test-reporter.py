"""Sequential unittest discovery with live diagnostics and structured stdout events."""
import inspect
import json
import sys
import time
import unittest


class Result(unittest.TextTestResult):
    def startTest(self, test):
        self.started = time.monotonic()
        self.outcome = "passed"
        super().startTest(test)

    def addFailure(self, test, err):
        self.outcome = "failed"
        super().addFailure(test, err)

    def addError(self, test, err):
        self.outcome = "failed"
        super().addError(test, err)

    def addSubTest(self, test, subtest, err):
        if err is not None:
            self.outcome = "failed"
        super().addSubTest(test, subtest, err)

    def addSkip(self, test, reason):
        self.outcome = "skipped"
        super().addSkip(test, reason)

    def addExpectedFailure(self, test, err):
        self.outcome = "todo"
        super().addExpectedFailure(test, err)

    def addUnexpectedSuccess(self, test):
        self.outcome = "failed"
        super().addUnexpectedSuccess(test)

    def stopTest(self, test):
        method = inspect.unwrap(getattr(type(test), test._testMethodName, lambda: None))
        try:
            file = inspect.getsourcefile(method)
            line = inspect.getsourcelines(method)[1]
        except (TypeError, OSError):
            file, line = str(test), 1
        print(json.dumps({"type": "python:test", "data": {
            "name": test.id(), "file": file, "line": line,
            "outcome": self.outcome,
            "duration_ms": (time.monotonic() - self.started) * 1000,
        }}), flush=True)
        super().stopTest(test)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(sys.argv[1] if len(sys.argv) > 1 else "tests/write-asd-ste100")
    # Keep test prints on the diagnostic stream so stdout remains a valid protocol.
    protocol = sys.stdout
    class ProtocolResult(Result):
        def stopTest(self, test):
            diagnostic = sys.stdout
            sys.stdout = protocol
            try:
                super().stopTest(test)
            finally:
                sys.stdout = diagnostic
    sys.stdout = sys.stderr
    result = unittest.TextTestRunner(verbosity=2, resultclass=ProtocolResult).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
