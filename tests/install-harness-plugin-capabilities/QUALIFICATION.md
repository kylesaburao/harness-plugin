# Capability installer qualification

Date: 2026-09-13. Repository: `/Users/kyle/Documents/harness-plugin`.
Host: macOS, `codex --version` reported `codex-cli 0.154.0`.
Scope: Markdown installer and descriptions, ordinary temporary file operations,
and a minimal fresh-session discovery check. No installer executable or Markdown
parser was added. Personal configuration and plugin installations were not edited.

## Static checks

Commands run from the repository:

```sh
python3 /Users/kyle/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/harness/skills/install-harness-plugin-capabilities
node --test tests/harness-advisor/policy.test.js tests/inventory/*.test.js
git diff --check
```

- Passed: validator printed `Skill is valid!`.
- Passed: all 9 selected Node tests, no failures or skips.
- Passed: whitespace check.
- Passed: Python byte/text comparisons against `git show HEAD:<path>` confirmed
  the original three activation templates retain their contents and order,
  the bundled-path authority section is unchanged, and the Final plans companion
  is unchanged byte-for-byte.

## Temporary installation checks

Disposable root: `/private/tmp/harness-discovery-tievnlzb`.
Fixtures were created and edited using `python3 - <<'PY'` file operations
(`Path.write_text`, exact contextual `str.replace`, and `shutil.copyfile`),
then inspected with `cat`. These were direct agent edits of known fixtures,
not an automated installer or a Markdown parser. Templates were taken from the
four known fenced blocks in the authoritative activation reference.

| Fixture | Effective instruction file | Result |
| --- | --- | --- |
| `codex` | `AGENTS.md` | Passed |
| `codex-override` | Nonempty `AGENTS.override.md` | Passed, shadowed `AGENTS.md` preserved |
| `claude` | `CLAUDE.md` | Passed, no native Advisor detection or authentication needed |

Each original fixture contained unrelated prose, a fenced `# Skill discovery`
example, `# Engineering context`, and nested notes. Direct edits installed the
host Advisor block, substituted the actual absolute temporary companion path in
Final plans, and inserted active Skill discovery before Engineering context.
The fenced example remained unchanged and did not count as active guidance.

For each fixture, Python assertions checked the companion against bundled bytes,
the pointer against its actual destination, and preservation of original content.
On the repeat pass all three components were inspected independently and matched,
so no writes were made. SHA-256 and nanosecond modification-time snapshots matched
before and after that pass (`repeat-evidence.json` in the disposable root).
Only the exact installed discovery template and its separator were then removed.
The repair pass reinserted that missing guidance. Assertions confirmed the entire
instruction file returned to its saved installed bytes, the companion remained
identical, and the shadowed file stayed unchanged.

These checks qualify this execution of the procedure and its resulting files.
They do not establish universal future agent behavior. Ambiguous ownership and
conflicting instructions were not separately exercised in this minimal session.

## Fresh Codex discovery

A separate `live` directory contained `codex`, an empty unrelated `work` directory,
and a `marketplace` copy retaining `.agents/plugins`, `.claude-plugin`, and
`plugins/harness` at their repository-relative locations. Development-only
`node_modules` was omitted. Authentication was copied privately from the existing
user auth file to isolated `codex/auth.json` with mode 0600. No credentials were
printed and no login was initiated. The private copy was removed after the checks.

CLI help was inspected with:

```sh
codex --version
codex plugin --help
codex exec --help
codex plugin marketplace add --help
codex plugin add --help
```

Registration and installation commands, both successful:

```sh
CODEX_HOME=/private/tmp/harness-discovery-tievnlzb/live/codex codex plugin marketplace add /private/tmp/harness-discovery-tievnlzb/live/marketplace --json
CODEX_HOME=/private/tmp/harness-discovery-tievnlzb/live/codex codex plugin add harness@harness-plugin --json
```

The CLI installed Harness 3.1.4 under the isolated directory. All three instruction
components were installed into isolated `AGENTS.md`, with the companion copied
first and its absolute path substituted. The following command ran twice, the
second time at the user's explicit request. Output files for the retry were
`retry.jsonl` and `retry.stderr` instead of `session.jsonl` and `session.stderr`.

```sh
CODEX_HOME=/private/tmp/harness-discovery-tievnlzb/live/codex codex exec --sandbox read-only --skip-git-repo-check -C /private/tmp/harness-discovery-tievnlzb/live/work --json 'Use the Harness random-sampler skill to display its bundled command-line help without drawing a number. Report the skill file you loaded, the command you executed, and its exit status.' > /private/tmp/harness-discovery-tievnlzb/live/session.jsonl 2> /private/tmp/harness-discovery-tievnlzb/live/session.stderr
```

Observed evidence from persisted rollout JSONL:

- Passed: user instructions included the complete installed Skill discovery text.
- Passed: the session catalog listed `harness:random-sampler` at
  `r2/random-sampler/SKILL.md`, with `r2` mapped to
  `/private/tmp/harness-discovery-tievnlzb/live/codex/plugins/cache/harness-plugin/harness/3.1.4/skills`.
- Passed: the first attempted skill read used exactly that expanded location.
- Blocked: both attempts to read the skill exited 71 with
  `sandbox-exec: sandbox_apply: Operation not permitted`.
- Blocked: `scripts/sample.mjs --help` was not executed, so successful help and
  same-directory executable use remain unverified. No draw or guessed-path lookup
  occurred. The outer Codex process exited 0 while reporting the blocked read,
  which is not a successful help execution.
- Unverified: Claude live skill loading is outside this task.

First session: `01a09d2f-d7ba-7053-b1bf-cf3683ec6e8e`.
Retry session: `01a09d30-d7cb-78e1-b957-579eeffa7430`.
Raw evidence remains under the disposable root in `live/session.jsonl`,
`live/retry.jsonl`, and `live/codex/sessions/2026/09/13/`. The error and decisive
path evidence are reproduced here because disposable files may be removed.
Read-only controls and user instructions remained enabled for both attempts.

## Claude live qualification (2026-09-25)

This closes "Claude live skill loading is outside this task" above, and the blocked Claude refresh in `tests/write-implementation-plan/QUALIFICATION.md`.

**Environment.**
- Host: Claude Code 2.1.282, macOS, personal claude.ai login, model `claude-opus-5-5`.
- Candidate: fresh build of HEAD `0071f1e4fe1cf58dd6e29c79a58ceaa105c24db7`, at `/private/tmp/claude-qual-20260925092150/harness`.
- Sessions ran with `--plugin-dir` and `--add-dir` for the candidate and for the fixture, plus `--setting-sources '' --no-session-persistence --permission-mode dontAsk`.
- Allowed tools: `Read Edit Write Glob Grep 'Bash(cat *)' 'Bash(ls *)' 'Bash(shasum *)' 'Bash(cp *)' 'Bash(mkdir *)'`.
- The personal-profile constraint rules out redirecting `CLAUDE_CONFIG_DIR`, so each prompt named the fixture file as the target. Default target resolution (`CLAUDE_CONFIG_DIR`, then `~/.claude`) was **not** exercised.
- An init-only debug probe reported "project memory is off": the fixture `CLAUDE.md` was not auto-loaded as instructions.

**Prompt.** "Use /harness:install-harness-plugin-capabilities to install or repair Harness capabilities for Claude Code. The target Claude instruction file for this run is <absolute fixture CLAUDE.md>. Do not touch any other instruction file."

**Fixtures.** The stale planning block is the real earlier template from `git show 0586c40:src/harness/skills/install-harness-plugin-capabilities/references/activation-instructions.md`, with its markers.
- (i) `CLAUDE.md` containing: personal prose, the current Advisor block, the stale active planning block, the same stale block inside a fenced Markdown example, the current Skill discovery block, and nested and quoted notes.
- (ii) `CLAUDE.md` containing prose, the Advisor block, and `@shared/AGENTS.md`. The imported file holds the stale planning block, current discovery, and notes. This mirrors a layout where shared instructions are imported.

Snapshots recorded the SHA-256, mode, and nanosecond mtime of every fixture file.

| Run | Evidence | Result |
| --- | --- | --- |
| (i) first pass | Skill tool loaded `harness:install-harness-plugin-capabilities`. It read the bundled `references/activation-instructions.md` from the candidate path, checked `write-implementation-plan` in the candidate, and made one `Edit` of the fixture. One Bash template diff was denied, and the model used Read instead. | **Passed.** A byte comparison shows only the active stale block was replaced with the current template. The fenced example, prose, notes, Advisor, and discovery are byte-identical. Mode is unchanged. |
| (i) repeat | Skill load, two Reads, no Edit or Write. | **Passed.** Hashes, modes, and mtimes are identical before and after. |
| (ii) first pass | Skill load. It read `CLAUDE.md`, then `shared/AGENTS.md` through the import. | **Finding, ungraded.** No file changed. The model treated the import as part of the effective instructions: Advisor correct, discovery correct via the import (no duplicate added), planning reported as **Blocked**, because the stale block is in a file the prompt put off-limits and adding a second block would create two active planning authorities. It offered two options: authorize editing the shared file, or have the user remove the stale block. |

The installer contract does not define whether files imported with `@path` belong to the effective instruction file. Run (ii) shows a conservative, reasonable interpretation. It is one sample, not a contract. Cost: about $0.54 across the three runs. Raw evidence (`evidence/g5-*`) remains under the disposable root and was not archived.
