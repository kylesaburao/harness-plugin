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
