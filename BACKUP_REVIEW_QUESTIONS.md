# Backup utility decision questions

Edit the `Answer` fields below. The recommended defaults are implementation guidance, not preselected answers.

## 1. Trust model

Will this remain a same-user interactive utility with trusted configuration files, environment variables, configured directories, and directory ownership?

Recommended default: Yes. If the utility may run as a privileged service, accept uploaded configuration, or cross operating-system user boundaries, it needs a separate security project covering allowed roots, ownership and permission validation, descriptor-relative operations, and stronger artifact ownership tracking.

Answer:
Yes. This is just for me.


## 2. Backup consistency

Is it sufficient to document that the utility archives a live source and does not guarantee a consistent point-in-time view, or must it provide snapshot-grade consistency?

Recommended default: Documentation is sufficient. Applications should be stopped, data should be quiesced, or callers should provide a filesystem or application snapshot when consistency matters.

Answer:
Documentation is sufficient. Do not add a file watcher. Clearly state that callers must stop applications, quiesce mutable data, or provide a filesystem or application snapshot when point-in-time consistency matters.


## 3. Compression policy

Is maximum compression an explicit requirement, or should the utility prefer lower CPU use and elapsed time when representative benchmarks show only a negligible archive-size difference?

Recommended default: Benchmark representative sources and use DEFLATE level 6 if its size increase is immaterial. Keep level 9 only if maximum compression is an explicit requirement.

Answer:
Use DEFLATE level 6.


## 4. Replacement permissions

When replacing an existing backup, should the new file always receive POSIX mode `0600`, even if the previous destination had different permissions?

Recommended default: Yes. Always install replacement archives and copies as `0600` so backup data has predictable private permissions.

Answer:
Yes


## 5. Cancellation behavior

Should preflight continue creating a missing output path before confirmation, with an accurate cancellation message, or should directory creation be deferred until after confirmation?

Recommended default: Keep output-path creation in preflight and correct the cancellation message. Deferring creation complicates preview accuracy, directory identity validation, and concurrent path handling.

Answer:
Maintain behaviour.


## 6. Dependency release policy

May the utility ship with the currently reported high-severity transitive dependency findings when the affected brace-expansion path is not reachable through this CLI flow, provided the findings remain documented and monitored?

Recommended default: Yes. Do not block the Phase 1 correctness and confidentiality fixes on this audit result. Continue monitoring upstream releases and validate any dependency update with the complete backup test suite and a real ZIP creation and extraction test.

Answer:
Yes


## 7. Supported storage workloads

Which storage combinations must performance work represent? Include the usual number of targets and whether copies to independent targets may run concurrently.

Consider:

- local SSD;
- external disk;
- Google Drive or another cloud-backed volume;
- network storage;
- multiple paths on the same physical device;
- multiple independent physical devices.

Recommended default: Benchmark every storage type used in normal backups. Permit bounded parallel copies only for workloads where measurements show a meaningful improvement without saturating a shared device.

Answer:
Reading from local ssd, external disk, google drive.
Writing to local ssd, external disk, google drive.

All operating from same computer.


## Decisions that do not require user input

The implementation can proceed without additional policy decisions for the following work:

- add authoritative interruption checks before final renames and success reporting;
- handle unknown directory-entry types safely during startup cleanup;
- add deterministic regression tests for verified correctness gaps;
- preserve the deprecated `acquireDirectoryLocks` export;
- retain existing safety controls;
- defer any `createArchive` lifecycle refactor until race coverage exists.
