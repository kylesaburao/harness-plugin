"""Publication tests use synthetic bundles only, never the user reference cache."""
from __future__ import annotations

import io
import json
import multiprocessing
import os
import shutil
import signal
import stat
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from test_ste_tools import make_bundle
import initialize_references as init
from ste_data import REQUIRED_FILES, validate_bundle


def identity(path):
    return (path.stat().st_ino, {name: (path / name).read_bytes() for name in REQUIRED_FILES})


def reader_worker(connection, generated, config):
    try:
        while connection.recv() == "read":
            connection.send((validate_bundle(generated, config), identity(generated)))
    except BaseException as error:
        connection.send(("error", repr(error)))
    finally:
        connection.close()


def writer_worker(connection, stage, generated, config, barrier):
    real_open, real_inspect, real_replace = init.os.open, init.inspect_destination, init.os.replace

    def pause(phase):
        if phase == barrier:
            connection.send(phase)
            if connection.recv() != "continue":
                raise AssertionError("unexpected barrier command")

    def open_lock(path, flags, mode=0o777, **kwargs):
        if Path(path) == init.lock_path(generated):
            pause("before_lock")
        return real_open(path, flags, mode, **kwargs)

    def inspect(path, cfg):
        result = real_inspect(path, cfg)
        pause("revalidated")
        return result

    def replace(source, destination):
        result = real_replace(source, destination)
        if source == generated:
            pause("invalid_moved")
        return result

    try:
        result = {}
        with mock.patch.object(init.os, "open", open_lock), mock.patch.object(
            init, "inspect_destination", inspect
        ), mock.patch.object(init.os, "replace", replace):
            init.publish_validated(stage, generated, config, result)
        connection.send(("ready", result))
    except init.InitializationError as error:
        connection.send(("error", error.code, str(error), error.details))
    except BaseException as error:
        connection.send(("unexpected", repr(error)))
    finally:
        connection.close()


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.config, self.generated, self.raw = make_bundle(self.root)
        self.original = identity(self.generated)
        self.stage = self.root / "stage"
        shutil.copytree(self.generated, self.stage)

    def publish(self):
        result = {}
        init.publish_validated(self.stage, self.generated, self.config, result)
        return result

    def assert_original(self):
        self.assertEqual(identity(self.generated), self.original)
        validate_bundle(self.generated, self.config)

    def invalid(self, kind="directory"):
        shutil.rmtree(self.generated)
        if kind == "directory":
            self.generated.mkdir()
            (self.generated / "invalid").write_text("original invalid data")
        else:
            self.generated.write_text("original invalid data")

    def test_valid_destination_identity_and_bytes_are_immutable(self):
        with mock.patch.object(init.os, "replace", side_effect=AssertionError("valid directory moved")):
            result = self.publish()
        self.assert_original()
        self.assertEqual(result, validate_bundle(self.generated, self.config))
        self.assertTrue(self.stage.exists())
        self.assertFalse(init.lock_path(self.generated).exists())

    def test_forced_build_still_builds_and_validates_stage_but_retains_identity(self):
        with mock.patch.object(init, "prepare_source", return_value=("pdf", self.root / "source.pdf")), mock.patch.object(
            init, "verify_pdf_hash"
        ), mock.patch.object(init, "run_extractor") as extract, mock.patch.object(
            init, "run_builder", side_effect=lambda _geometry, dictionary: dictionary.write_bytes(self.raw)
        ) as build:
            result = init.initialize(self.root / "source.pdf", True, self.config, self.generated)
        extract.assert_called_once()
        build.assert_called_once()
        self.assert_original()
        self.assertEqual(result, validate_bundle(self.generated, self.config))
        self.assertFalse(list(self.generated.parent.glob(".generated-stage-*")))

    def test_forced_import_retains_valid_bundle_and_discards_stage(self):
        result = init.initialize(None, True, self.config, self.generated, self.stage)
        self.assert_original()
        self.assertEqual(result, validate_bundle(self.generated, self.config))
        self.assertFalse(list(self.generated.parent.glob(".generated-stage-*")))

    def test_missing_destination_publishes_with_one_rename(self):
        shutil.rmtree(self.generated)
        stage_inode = self.stage.stat().st_ino
        with mock.patch.object(init.os, "replace", wraps=os.replace) as replace:
            self.publish()
        replace.assert_called_once_with(self.stage, self.generated)
        self.assertEqual(self.generated.stat().st_ino, stage_inode)
        validate_bundle(self.generated, self.config)

    def test_invalid_file_and_directory_are_replaced_and_backup_cleaned(self):
        for kind in ("file", "directory"):
            with self.subTest(kind=kind):
                self.invalid(kind)
                if not self.stage.exists():
                    self.stage.mkdir()
                    (self.stage / "dictionary.jsonl").write_bytes(self.raw)
                    init.write_bundle_metadata(self.stage, init.load_source_config(self.config), self.config)
                self.publish()
                validate_bundle(self.generated, self.config)
                self.assertFalse(list(self.generated.parent.glob(".generated-backup-*")))

    def test_invalid_stage_never_acquires_lock_or_changes_destination(self):
        (self.stage / "dictionary.jsonl").write_text("invalid")
        with mock.patch.object(init.os, "open", side_effect=AssertionError("lock acquired")):
            with self.assertRaisesRegex(init.InitializationError, "staged bundle validation failed"):
                self.publish()
        self.assert_original()

    def test_busy_lock_is_unchanged_and_has_explicit_manual_remedy(self):
        path = init.lock_path(self.generated)
        path.write_text('unowned stale lock')
        with self.assertRaises(init.InitializationError) as raised:
            self.publish()
        self.assertEqual(raised.exception.code, "initialization_busy")
        self.assertIn(str(path), raised.exception.remedy)
        self.assertIn("Confirm no initializer is active", raised.exception.remedy)
        self.assertEqual(path.read_text(), 'unowned stale lock')
        self.assert_original()

    def test_lock_mode_token_pid_and_ownership_safe_release(self):
        result = {}
        path = init.lock_path(self.generated)
        with init.publication_lock(self.generated, result):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            owner = json.loads(path.read_text())
            self.assertEqual(owner["pid"], os.getpid())
            self.assertTrue(owner["token"])
            owner["token"] = "another invocation"
            path.write_text(json.dumps(owner))
        self.assertTrue(path.exists())
        self.assertEqual(result["cleanupFailures"][0]["code"], "lock_release_failed")
        self.assertIn("ownership token", result["cleanupFailures"][0]["condition"])

    def test_replaced_lock_inode_is_not_removed(self):
        result = {}
        path = init.lock_path(self.generated)
        with init.publication_lock(self.generated, result):
            path.rename(self.root / "original-lock")
            path.write_text("another owner's lock")
        self.assertEqual(path.read_text(), "another owner's lock")
        self.assertIn("ownership changed", result["cleanupFailures"][0]["condition"])

    def test_lock_create_failure_preserves_destination(self):
        with mock.patch.object(init.os, "open", side_effect=PermissionError("exclusive create denied")):
            with self.assertRaisesRegex(init.InitializationError, "cannot create publication lock"):
                self.publish()
        self.assert_original()

    def test_lock_partial_write_failure_closes_descriptor_and_cleans_only_owned_lock(self):
        real_write = os.write
        descriptors = []
        def write(fd, payload):
            descriptors.append(fd)
            if len(descriptors) == 1:
                return real_write(fd, payload[:3])
            raise OSError("lock write failed")
        with mock.patch.object(init.os, "write", write):
            with self.assertRaisesRegex(init.InitializationError, "lock write failed"):
                self.publish()
        self.assertFalse(init.lock_path(self.generated).exists())
        with self.assertRaises(OSError):
            os.fstat(descriptors[0])
        self.assert_original()

    def test_lock_write_and_cleanup_failures_both_reported(self):
        with mock.patch.object(init.os, "write", side_effect=OSError("primary write")), mock.patch.object(
            Path, "unlink", side_effect=OSError("secondary unlink")
        ):
            with self.assertRaises(init.InitializationError) as raised:
                self.publish()
        self.assertIn("primary write", str(raised.exception))
        self.assertIn("secondary unlink", raised.exception.details["cleanupFailures"][0]["condition"])
        self.assertTrue(init.lock_path(self.generated).exists())
        self.assert_original()

    def test_uninspectable_destination_and_required_file_symlinks_are_retained(self):
        self.generated.rename(self.root / "real-bundle")
        self.generated.symlink_to(self.root / "real-bundle", target_is_directory=True)
        with self.assertRaises(init.InitializationError) as raised:
            init.initialize(None, True, self.config, self.generated, self.stage)
        self.assertEqual(raised.exception.code, "destination_uninspectable")
        self.assertTrue(self.generated.is_symlink())
        self.assert_original()
        self.generated.unlink()
        (self.root / "real-bundle").rename(self.generated)
        dictionary = self.generated / "dictionary.jsonl"
        dictionary.rename(self.root / "real-dictionary")
        dictionary.symlink_to(self.root / "real-dictionary")
        with self.assertRaises(init.InitializationError) as raised:
            self.publish()
        self.assertEqual(raised.exception.code, "destination_uninspectable")
        self.assertTrue(dictionary.is_symlink())

    def test_permission_error_wrapped_by_validation_is_not_invalid_data(self):
        real_read = Path.read_text
        def read(path, *args, **kwargs):
            if path == self.generated / "manifest.json":
                raise PermissionError("manifest denied")
            return real_read(path, *args, **kwargs)
        with mock.patch.object(Path, "read_text", read), mock.patch.object(init.os, "replace") as replace:
            with self.assertRaises(init.InitializationError) as raised:
                self.publish()
        self.assertEqual(raised.exception.code, "destination_uninspectable")
        replace.assert_not_called()
        self.assert_original()

    def test_uninspectable_lstat_is_not_absent(self):
        real_lstat = Path.lstat
        def lstat(path, *args, **kwargs):
            if path == self.generated:
                raise PermissionError("cannot inspect")
            return real_lstat(path, *args, **kwargs)
        with mock.patch.object(Path, "lstat", lstat), mock.patch.object(init.os, "replace") as replace:
            with self.assertRaises(init.InitializationError) as raised:
                self.publish()
        self.assertEqual(raised.exception.code, "destination_uninspectable")
        replace.assert_not_called()

    def test_failed_publish_restores_invalid_bundle(self):
        self.invalid()
        before = self.generated.stat().st_ino
        real_replace = os.replace
        def replace(source, target):
            if source == self.stage:
                raise OSError("primary rename failed")
            return real_replace(source, target)
        with mock.patch.object(init.os, "replace", replace):
            with self.assertRaisesRegex(init.InitializationError, "primary rename failed"):
                self.publish()
        self.assertEqual(self.generated.stat().st_ino, before)
        self.assertEqual((self.generated / "invalid").read_text(), "original invalid data")
        self.assertFalse(list(self.generated.parent.glob(".generated-backup-*")))

    def test_failed_publish_and_failed_rollback_preserve_both_diagnostics_and_backup(self):
        self.invalid()
        real_replace = os.replace
        def replace(source, target):
            if source == self.stage:
                raise OSError("primary rename failed")
            if source.name.startswith(".generated-backup-"):
                raise OSError("secondary rollback failed")
            return real_replace(source, target)
        with mock.patch.object(init.os, "replace", replace):
            with self.assertRaises(init.InitializationError) as raised:
                self.publish()
        self.assertIn("primary rename failed", str(raised.exception))
        rollback = raised.exception.details["rollbackFailure"]
        self.assertIn("secondary rollback failed", rollback["condition"])
        self.assertEqual((Path(rollback["path"]) / "invalid").read_text(), "original invalid data")
        self.assertTrue(self.stage.exists())
        self.assertFalse(init.lock_path(self.generated).exists())

    def test_rollback_does_not_overwrite_an_unexpected_destination(self):
        self.invalid()
        real_replace = os.replace
        def replace(source, target):
            if source == self.stage:
                self.generated.write_text("unexpected data")
                raise OSError("primary failure")
            return real_replace(source, target)
        with mock.patch.object(init.os, "replace", replace):
            with self.assertRaises(init.InitializationError) as raised:
                self.publish()
        self.assertEqual(self.generated.read_text(), "unexpected data")
        self.assertIn("refusing to overwrite", raised.exception.details["rollbackFailure"]["condition"])

    def test_backup_cleanup_failure_preserves_ready_fields_and_retained_path(self):
        self.invalid()
        real_remove = shutil.rmtree
        def remove(path, *args, **kwargs):
            if Path(path).name.startswith(".generated-backup-"):
                raise OSError("backup cleanup failed")
            return real_remove(path, *args, **kwargs)
        with mock.patch.object(init.shutil, "rmtree", remove):
            result = self.publish()
        self.assertEqual(result["dictionary_rows"], 2)
        validate_bundle(self.generated, self.config)
        retained = Path(result["cleanupFailures"][0]["path"])
        self.assertEqual((retained / "invalid").read_text(), "original invalid data")

    def test_successful_stage_cleanup_failure_reports_ready_and_exit_one_json_and_plain(self):
        real_initialize, real_remove = init.initialize, shutil.rmtree
        def remove(path, *args, **kwargs):
            if Path(path).name.startswith(".generated-stage-"):
                raise OSError("stage cleanup failed")
            return real_remove(path, *args, **kwargs)
        def initialize(_pdf, _force, **kwargs):
            return real_initialize(None, True, self.config, self.generated, self.stage)
        for json_output in (True, False):
            with self.subTest(json=json_output), mock.patch.object(init.shutil, "rmtree", remove), mock.patch.object(
                init, "initialize", initialize
            ), redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
                status = init.main(["--json"] if json_output else [])
            self.assertEqual(status, 1)
            if json_output:
                result = json.loads(stdout.getvalue())
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["dictionary_rows"], 2)
                self.assertTrue(Path(result["cleanupFailures"][0]["path"]).exists())
            else:
                self.assertIn("READY:", stdout.getvalue())
                self.assertIn("stage cleanup failed", stderr.getvalue())
        self.assert_original()

    def test_primary_build_and_stage_cleanup_failure_keep_original_error(self):
        real_remove = shutil.rmtree
        def remove(path, *args, **kwargs):
            if Path(path).name.startswith(".generated-stage-"):
                raise OSError("secondary stage cleanup")
            return real_remove(path, *args, **kwargs)
        with mock.patch.object(init, "prepare_source", return_value=("pdf", self.root / "source.pdf")), mock.patch.object(
            init, "verify_pdf_hash"
        ), mock.patch.object(init, "run_extractor", side_effect=init.InitializationError("primary extraction")), mock.patch.object(
            init.shutil, "rmtree", remove
        ):
            with self.assertRaises(init.InitializationError) as raised:
                init.initialize(self.root / "source.pdf", True, self.config, self.generated)
        self.assertEqual(str(raised.exception), "primary extraction")
        self.assertIn("secondary stage cleanup", raised.exception.details["cleanupFailures"][0]["condition"])
        self.assertTrue(Path(raised.exception.details["cleanupFailures"][0]["path"]).exists())
        self.assert_original()

    def test_primary_import_and_cleanup_failures_survive_json_reporting(self):
        real_initialize, real_remove = init.initialize, shutil.rmtree
        def remove(path, *args, **kwargs):
            if Path(path).name.startswith(".generated-stage-"):
                raise OSError("secondary stage cleanup")
            return real_remove(path, *args, **kwargs)
        def initialize(_pdf, _force, **kwargs):
            return real_initialize(None, True, self.config, self.generated, self.stage)
        with mock.patch.object(init, "initialize", initialize), mock.patch.object(
            init.shutil, "copy2", side_effect=OSError("primary import")
        ), mock.patch.object(init.shutil, "rmtree", remove), redirect_stderr(io.StringIO()) as stderr:
            status = init.main(["--json"])
        failure = json.loads(stderr.getvalue())["error"]
        self.assertEqual(status, 1)
        self.assertIn("primary import", failure["condition"])
        self.assertIn("secondary stage cleanup", failure["cleanupFailures"][0]["condition"])
        self.assertTrue(Path(failure["cleanupFailures"][0]["path"]).exists())

    def test_baseexception_injection_after_invalid_move_is_not_oserror_rollback(self):
        self.invalid()
        class Interrupted(BaseException):
            pass
        real_replace = os.replace
        def replace(source, target):
            if source == self.stage:
                raise Interrupted()
            return real_replace(source, target)
        with mock.patch.object(init.os, "replace", replace), redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(Interrupted):
                self.publish()
        retained = Path(json.loads(stderr.getvalue())["retainedInvalidBackup"])
        self.assertEqual((retained / "invalid").read_text(), "original invalid data")
        self.assertFalse(self.generated.exists())
        self.assertFalse(init.lock_path(self.generated).exists())


class ConcurrentPublicationTests(unittest.TestCase):
    setUp = PublicationTests.setUp
    assert_original = PublicationTests.assert_original
    invalid = PublicationTests.invalid

    def spawn(self, target, *args):
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        process = context.Process(target=target, args=(child, *args))
        process.start()
        child.close()
        def cleanup():
            if process.is_alive():
                process.kill()
            process.join(10)
            parent.close()
        self.addCleanup(cleanup)
        return parent, process

    def receive(self, connection):
        self.assertTrue(connection.poll(15), "process barrier timed out")
        return connection.recv()

    def reader_check(self, connection):
        connection.send("read")
        result = self.receive(connection)
        self.assertIsInstance(result[0], dict, result)
        self.assertEqual(result[1], self.original)

    def test_reader_process_observes_valid_bundle_before_lock_after_revalidation_and_completion(self):
        reader, _ = self.spawn(reader_worker, self.generated, self.config)
        for barrier in ("before_lock", "revalidated"):
            writer, process = self.spawn(writer_worker, self.stage, self.generated, self.config, barrier)
            self.assertEqual(self.receive(writer), barrier)
            self.reader_check(reader)
            writer.send("continue")
            self.assertEqual(self.receive(writer)[0], "ready")
            process.join(10)
            self.assertEqual(process.exitcode, 0)
            self.reader_check(reader)
        self.assert_original()

    def test_writer_that_finishes_during_other_build_is_retained_after_revalidation(self):
        shutil.rmtree(self.generated)
        second_stage = self.root / "second-stage"
        shutil.copytree(self.stage, second_stage)
        first, first_process = self.spawn(writer_worker, self.stage, self.generated, self.config, "before_lock")
        self.assertEqual(self.receive(first), "before_lock")
        second, second_process = self.spawn(writer_worker, second_stage, self.generated, self.config, None)
        self.assertEqual(self.receive(second)[0], "ready")
        installed = identity(self.generated)
        first.send("continue")
        self.assertEqual(self.receive(first)[0], "ready")
        self.assertEqual(identity(self.generated), installed)
        self.assertTrue(self.stage.exists())
        for process in (first_process, second_process):
            process.join(10)
            self.assertEqual(process.exitcode, 0)

    def test_competing_publisher_is_busy_without_retries_or_mutation(self):
        writer, process = self.spawn(writer_worker, self.stage, self.generated, self.config, "revalidated")
        self.assertEqual(self.receive(writer), "revalidated")
        other, other_process = self.spawn(writer_worker, self.stage, self.generated, self.config, None)
        self.assertEqual(self.receive(other)[:2], ("error", "initialization_busy"))
        self.assert_original()
        writer.send("continue")
        self.assertEqual(self.receive(writer)[0], "ready")
        for child in (process, other_process):
            child.join(10)
            self.assertEqual(child.exitcode, 0)

    def test_sigkill_before_publication_and_while_locked_keeps_valid_readers_available(self):
        reader, _ = self.spawn(reader_worker, self.generated, self.config)
        for barrier in ("before_lock", "revalidated"):
            writer, process = self.spawn(writer_worker, self.stage, self.generated, self.config, barrier)
            self.assertEqual(self.receive(writer), barrier)
            process.kill()
            process.join(10)
            self.assertEqual(process.exitcode, -signal.SIGKILL)
            self.reader_check(reader)
            self.assertEqual(init.lock_path(self.generated).exists(), barrier == "revalidated")
        with self.assertRaises(init.InitializationError) as raised:
            init.publish_validated(self.stage, self.generated, self.config, {})
        self.assertEqual(raised.exception.code, "initialization_busy")

    def test_sigkill_after_invalid_move_retains_backup_and_stale_lock_for_manual_recovery(self):
        self.invalid()
        writer, process = self.spawn(writer_worker, self.stage, self.generated, self.config, "invalid_moved")
        self.assertEqual(self.receive(writer), "invalid_moved")
        self.assertFalse(self.generated.exists())
        backups = list(self.generated.parent.glob(".generated-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "invalid").read_text(), "original invalid data")
        process.kill()
        process.join(10)
        self.assertEqual(process.exitcode, -signal.SIGKILL)
        self.assertTrue(init.lock_path(self.generated).exists())
        with self.assertRaises(init.InitializationError) as raised:
            init.publish_validated(self.stage, self.generated, self.config, {})
        self.assertEqual(raised.exception.code, "initialization_busy")
        self.assertTrue(backups[0].exists())


if __name__ == "__main__":
    unittest.main()
