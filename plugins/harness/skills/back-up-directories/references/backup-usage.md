# ZIP backup utility

Reference for the `back-up-directories` skill. Node.js 22.12.0 or newer is required. Install the one dependency once, from the skill directory:

```sh
npm install --omit=dev
```

Copy the committed [`backup-config.json`](backup-config.json) template to an ignored local configuration, then edit the local copy:

```sh
cp references/backup-config.json backup-config.local.json
```

Validate it without backing anything up:

```sh
node scripts/backup.js --preflight --json ./backup-config.local.json
```

Run the backup with the local configuration:

```sh
node scripts/backup.js ./backup-config.local.json
```

`sourceDirectory` and every `targetDirectories` entry are required. `outputDirectory` is optional and defaults to the operating system's temporary directory. Relative paths are resolved from the configuration file's directory; absolute paths are used as written. The source and every target directory must already exist. A missing output directory and any missing parents are created automatically during preflight. The source must be readable and searchable. The output directory and every target must be readable, writable, and searchable, because startup cleanup enumerates their root entries before writing.

The utility resolves directory aliases and rejects an output directory that is the source or anywhere below it. Equivalent targets are deduplicated. A target that resolves to the output directory shares the completed output archive and is not copied onto itself; the preview identifies every shared or skipped destination. If the output directory is not also a target, it is treated only as staging and the completed ZIP is removed after replication, including when replication fails.

After validation, the script prints the source, generated filename, output path, target paths, and create, overwrite, or shared-output behavior. It does not scan target contents during preflight, so an unrelated inaccessible descendant cannot prevent a valid backup at the target root.

The utility asks `Proceed? [y/N]` and creates no backup unless the answer is exactly `Y`, `y`, or `yes`. Because output-directory creation is part of preflight, cancelling at the prompt can leave a newly created empty output directory and its newly created parent directories. The cancellation message identifies that side effect when it occurred. Cancellation does not create an archive, replicated copy, or temporary backup file. Once confirmed, the utility reports its preparation, archive creation progress, and each replication copy so long-running cloud downloads and compression do not appear stalled. It then acquires the run lock and cleans up stale temporary artifacts before writing. The archive name is `<folder>_Backup_<Month><DD><YYYY>.zip`, for example `My-Documents_Backup_July112026.zip`. Names too long for common 255-byte filesystem component limits are shortened with a deterministic hash while preserving the date suffix.

Archive and copy data are streamed asynchronously. ZIP creation uses DEFLATE level 6. This is a fixed implementation policy, not a configuration option. When the output directory is staging-only, the archive keeps its `.backup-archive-<uuid>.tmp` name until every target has been replicated and is then removed; it is renamed to the dated ZIP name only when the output directory is itself a target. Targets are copied serially in configured order. A copy failure prevents later copies from starting, while copies installed earlier remain in place. Copies are installed through a short temporary file in each target directory followed by an atomic rename where the platform supports it. On POSIX systems, new staging archives and target-copy temporary files are created with mode `0600`. Atomic installation preserves that mode, so replacing an existing backup also replaces its previous mode with `0600`. A missing output directory is created with mode `0700`; an existing output directory's permissions are not changed.

The utility archives a live source and does not provide a filesystem snapshot or source-mutation detection. Archiver traverses the source and lazily opens entries by pathname. The configured-directory identity checks detect replacement of that directory only at specific checkpoints; they do not detect a file being modified, truncated, or replaced in place during archive creation. A successful and structurally valid ZIP can therefore contain a mixed point-in-time view. When consistency matters, stop applications that write to the source, otherwise quiesce mutable data, or point the utility at a filesystem or application snapshot.

Before cleanup or writing, the utility acquires one user-local run lock at `.backup-tool.lock` in the invoking user's home directory. This prevents concurrent backup invocations by that local OS user. Set `BACKUP_LOCK_PATH` to an absolute path to override the lock location, for example when isolating tests or separate operating environments. Coordination between different OS users is deliberately outside the supported concurrency model.

With the lock held, startup removes utility-owned archive and copy temporary files left by a previous forced termination. Temporary files and the run lock are removed on normal completion, errors, `SIGINT`, and `SIGTERM`, with a synchronous process-exit fallback; failures are reported and retained for that fallback retry. Archive warnings are treated as failures so omitted or unreadable content is never silently distributed. `SIGKILL`, abrupt termination, and sudden power loss cannot run exit cleanup and can leave a stale lock. In that case, the next run reports the lock path; after confirming that no backup is active, the local operator must inspect and remove the stale lock manually. The tool deliberately does not guess ownership or automatically delete a lock it did not create.

The utility is designed as a same-user interactive personal tool. Its configuration, environment variables, directory ownership, and configured directory paths are trusted inputs. It records each configured directory's canonical path and filesystem device/inode identity during validation and checks it again before writing. It also performs work through the validated canonical paths, which prevents a replaced configuration-path symlink from redirecting a write. Portable Node.js APIs do not provide all descriptor-relative filesystem operations needed to eliminate every time-of-check/time-of-use race. Configured directories and their parent directories therefore must not be writable or renameable by less-trusted users. Privileged services, uploaded configuration, and cross-user or cross-machine operation require a separate threat model and are outside this utility's supported use.

One ZIP stream is one DEFLATE workload. Increasing `UV_THREADPOOL_SIZE` does not make that stream multicore, so no worker-pool tuning is recommended for this utility.
