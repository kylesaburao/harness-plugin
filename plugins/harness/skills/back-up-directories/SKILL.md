---
name: back-up-directories
description: Archive one directory into a dated ZIP and replicate it to several destinations, with validation, a confirmation prompt, a run lock, and cleanup of interrupted runs. Use when the user asks to back up a folder to external drives or cloud-synced directories, to make a dated archive of a project, or to repeat a configured backup. Do not use for incremental or versioned backups, for restoring from an archive, or as a substitute for a filesystem snapshot when the source is being written to.
---

# Back up directories

Creates `<folder>_Backup_<Month><DD><YYYY>.zip` from a source directory, then copies it to
every configured target. Configuration is a JSON file, not command-line flags.

This skill needs one npm package. Read [INSTALL.md](INSTALL.md) if the preflight reports
`dependency_missing`.

## This tool is interactive

The utility prints a preview and then asks `Proceed? [y/N]`. It creates nothing unless the
answer is exactly `y`, `Y`, or `yes`.

That prompt is the user's decision, not yours. Do not pipe an answer into it, do not run
the command with input redirected, and do not answer on the user's behalf. Show them the
preview, then let them run the command or confirm it themselves. Backups overwrite files
at every target.

## Workflow

1. Every path below is relative to the skill directory, not the current working directory.
   When they differ, prefix the script with the absolute skill directory path.

2. Check the environment before anything else:

   ```sh
   node scripts/backup.js --preflight --json
   ```

   Exit status 2 with `dependency_missing` means the package is not installed. Relay the
   `remedy` command and ask before running it, since it writes to the skill directory.

3. Build the configuration. Copy `references/backup-config.json` to a local file the user
   owns, then edit it:

   ```json
   {
     "sourceDirectory": "./Documents",
     "targetDirectories": ["/Volumes/Backup", "/Users/me/Dropbox"],
     "outputDirectory": "./generated-backups"
   }
   ```

   `sourceDirectory` and a non-empty `targetDirectories` are required. `outputDirectory` is
   optional and defaults to the system temporary directory. Relative paths resolve from the
   configuration file's own directory. Name the local copy something matching
   `*.local.json`, which the repository ignores, because these paths are machine-specific.

4. Validate the configuration without backing anything up:

   ```sh
   node scripts/backup.js --preflight --json path/to/backup-config.local.json
   ```

   This runs exactly the validation a real run does, so it reports the resolved source,
   output, targets, and the archive filename before any data moves. It has one side effect:
   a missing output directory is created, as it would be on a real run.

5. Hand the run to the user:

   ```sh
   node scripts/backup.js path/to/backup-config.local.json
   ```

## Reading the result

| Exit | Meaning |
| --- | --- |
| `0` | The archive was created and every copy was installed, or the user answered no at the prompt |
| `2` | Did not start: `usage_error`, `dependency_missing`, or `node_version_unsupported` |
| `3` | Did not start: `config_invalid`. Nothing was archived or copied |
| `4` | Archive creation failed |
| `5` | A copy failed. Copies installed before it remain in place |
| `130` / `143` | Interrupted. Temporary artifacts were cleaned up |

Exit `0` covers a cancelled run as well as a completed one, so read stdout to tell them
apart: a cancellation prints `CANCELLED`. Copies are serial and stop at the first failure,
so on exit `5` say which targets did get a copy rather than describing the backup as
failed outright.

## Before claiming a backup is safe

Read [references/backup-usage.md](references/backup-usage.md) before answering questions
about guarantees. Points that change what you should tell the user:

- The source is archived live. There is no snapshot and no detection of a file changing
  mid-archive, so a valid ZIP can still hold a mixed point-in-time view. When consistency
  matters, the source has to be quiesced first.
- One run lock lives at `.backup-tool.lock` in the invoking user's home directory. A
  `SIGKILL` or power loss leaves it behind, and the next run reports the path. Removing it
  is the operator's call after confirming no backup is running. Do not delete it for them.
- The tool is a same-user interactive utility. Its configuration and directory paths are
  trusted input, so it is not suitable for privileged services or cross-user operation.
