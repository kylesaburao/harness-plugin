# Handoff: Finalize `extract-video-frames`

## Goal and Scope

Finalize the Harness `extract-video-frames` skill in `/home/kyle/harness-plugin`.
The skill must deterministically extract every presented frame at coded resolution,
optionally inside an inclusive time window, with SDR written as lossless sRGB PNG and
PQ/HLG HDR written as linear BT.2020 float32 OpenEXR. Output is always the fixed sibling
`<input-stem>-frames`, existing output is never replaced, and the script owns all
FFmpeg/ffprobe command construction.

Primary repository instructions: `/home/kyle/harness-plugin/AGENTS.md`.

## Current State

- Working tree was clean when this handoff was created.
- Draft commit: `71c9cea891b968da4d1fa589306d1fe872154028`
- Review base: `fe934049ebd5572f7d6bd00209052a5f9a0ec252`
- Commit subject: `feat: add untested video frame extraction working draft`
- Author and committer dates are correctly fixed at `1999-12-31T23:59:00-08:00`.
- The draft is intentionally and visibly labeled **untested working draft**.
- No tests, builds, validators, formatters, syntax checks, Node entrypoint runs, or
  FFmpeg/ffprobe smoke tests have been executed.

Key artifacts:

- `plugins/harness/skills/extract-video-frames/SKILL.md`
- `plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js`
- `plugins/harness/skills/extract-video-frames/agents/openai.yaml`
- `tests/extract-video-frames/policy.test.js`
- `tests/extract-video-frames/cli-contract.test.js`
- `README.md` inventory row

## Locked Product and Interface Decisions

- Public name and entrypoint: `extract-video-frames` and
  `node scripts/extract-video-frames.js`.
- Target macOS is 26.0 or newer. Linux/WSL2 remain supported by design; native Windows
  and older macOS are rejected.
- Time flags are `--start` and `--end`; each accepts decimal seconds or
  `HH:MM:SS[.fraction]` with up to nine fractional digits.
- Time zero is the first presented frame. Selection is literal and inclusive:
  `PTS >= start && PTS <= end`. Invalid, reversed, out-of-range, or empty windows fail
  before output creation.
- Use the first non-attached-picture video stream. No stream selector or output override.
- Directory name is always `<stem>-frames` beside the supplied path, including symlinks.
- Existing file, directory, or symlink collisions fail unchanged. Partial work is cleaned.
- Frames use zero-padded sequence names; there is no manifest, hash list, or durable
  per-frame PTS map. Reports retain requested bounds and actual first/last PTS only.
- SDR: tagged, unambiguous input only; normalize to sRGB PNG, 8-bit for <=8-bit source
  and 16-bit for higher-depth source.
- HDR: strict tagged PQ/HLG BT.2020 input only; linear BT.2020 RGB/RGBA float32 OpenEXR;
  never tone-map or silently fall back. Reject ambiguous HDR and Dolby Vision-only input.
- Preserve alpha, sample aspect ratio, coded pixels, and interlacing. Do not resize,
  deinterlace, change frame rate, duplicate, or drop presented frames.
- Apply only orthogonal display rotations/flips. Reject scale, shear, and arbitrary angles.
- Plain progress belongs on stderr; JSON mode suppresses progress and emits one final
  stdout object.
- Follow the repository preflight/error/reporting contract exactly, including exit `2`
  before work starts and stable `code`/`condition`/`remedy` triples.

## Independent Code-Review Findings

The review was read-only and used two isolated axes. No fixes have been applied.

### Standards axis

1. **High: raw preflight exceptions violate the exit/diagnostic contract.**
   Filesystem and child-spawn exceptions around script lines 98-117 and 147-163 can
   reach the catch-all around lines 474-477, produce `unexpected_failure`, and return
   exit `1` even though work never started. Wrap every preflight filesystem/process
   failure in a stable `DraftError` with `EXIT.CANNOT_START`; reserve the generic
   fallback for genuine post-start defects.

2. **High: publication is check-then-rename and can clobber a racing empty directory.**
   The sequence around lines 470-471 checks absence and then uses POSIX `rename`.
   The sidecar lock coordinates only cooperating instances. Replace this with an atomic
   no-clobber publication design. On macOS 26+, prefer a deterministic platform primitive
   that provides no-replace semantics; keep a safe Linux implementation or reject the
   platform when the guarantee cannot be met.

3. **Medium: child output buffering is unbounded.**
   `ProcessManager.run` retains all stdout/stderr, including the full FFmpeg progress
   stream. Stream progress incrementally and retain only a bounded stderr tail for
   diagnostics.

### Specification axis

1. **High: display transforms are neither fully validated nor explicit.**
   `displayRotation` reduces the display matrix to one rotation scalar, while the FFmpeg
   command leaves autorotation implicit. Parse/decompose the complete display matrix,
   accept only orthogonal rotations/flips, reject scale/shear/arbitrary transforms,
   disable implicit autorotation, and construct explicit transpose/flip filters. Add
   those filters to capability preflight and report the applied transform.

2. **High: input-aware preflight omits the promised representative decode.**
   Metadata and frame timestamps are inspected, but no deterministic FFmpeg decode and
   color-conversion probe is sent to a null sink. Add that probe before returning input
   readiness so corrupt/unsupported input fails with exit `2` and a stable remedy.

3. **Medium: dormant tests cover only part of the promised contract.**
   Add unexecuted tests for collision/publication races, cleanup and signals, source
   mutation, stream selection, HLG, complete transform/flip handling, inclusive frame
   selection, preflight decode, bounded diagnostics, report shapes, and structural
   checks.

## Implementation Guidance

- Keep production code skill-local under `plugins/harness/skills/extract-video-frames/`.
  Do not import the existing GIF skill or create a shared module merely for similarity.
- Keep tests and fixtures under root `tests/extract-video-frames/`; nothing test-only may
  ship under `plugins/harness/`.
- Prefer dependency-free Node.js using the documented Node 20.6 floor.
- Preserve argument validation before environment probing. Normal runs must repeat the
  same preflight before any output mutation.
- Keep deterministic command builders exported for dormant unit tests. Callers must
  never infer or synthesize FFmpeg commands.
- Do not manually edit plugin version fields; the push workflow owns version bumps.
- Any subsequent commit must preserve the repository's fixed author and committer date.

## Verification and Authorization Boundary

The originating user required the first implementation to be committed only as an
explicitly untested working draft and prohibited all tests, builds, validators, FFmpeg
smoke tests, and other executable verification. That requirement has been satisfied,
but it has **not** been explicitly lifted for follow-up work.

Therefore:

1. The next session may inspect and edit the code, expand dormant tests, review diffs,
   and create another explicitly untested draft commit.
2. It must not run tests, validators, builds, linters, formatters, syntax checks, Node
   entrypoints, FFmpeg, or ffprobe unless the user explicitly authorizes verification.
3. It must not remove `untested working draft` labels or claim completion/verification
   until authorized checks have actually passed, including a real macOS 26.0+ run.
4. If verification remains unauthorized after repairs, stop after the repaired draft
   commit and ask the user to authorize the final verification phase.

## Suggested Skills

Use these in order:

1. `/home/kyle/.codex/skills/.system/skill-creator/SKILL.md` — update the skill while
   preserving portable Agent Skills structure and progressive disclosure.
2. `/home/kyle/.codex/plugins/cache/openai-curated-remote/matt-skills-curated/1.1.0/skills/implement/SKILL.md`
   — implement the six review remediations from this approved handoff. User constraints
   override its normal requirement to run tests continuously.
3. `/home/kyle/.codex/plugins/cache/openai-curated-remote/matt-skills-curated/1.1.0/skills/code-review/SKILL.md`
   — repeat isolated Standards and Spec review after the repairs.
4. `/home/kyle/.codex/plugins/cache/openai-curated-remote/matt-skills-curated/1.1.0/skills/diagnosing-bugs/SKILL.md`
   — use only later, if the user authorizes verification and a check fails.

## Exact Next Action

Start a fresh session in the repository and give it this prompt exactly:

```text
Read /home/kyle/harness-plugin/HANDOFF-extract-video-frames.md completely. Use the suggested
skill-creator and implement skills, then repair all Standards-axis and Spec-axis findings
against commit 71c9cea891b968da4d1fa589306d1fe872154028. Preserve every locked product
decision. Expand the dormant root tests but do not execute tests, builds, validators,
formatters, linters, syntax checks, Node entrypoints, FFmpeg, or ffprobe unless I
explicitly authorize verification. Review the resulting diff with isolated Standards
and Spec subagents. If findings remain, revise them. Commit the repaired result with the
repository's fixed timestamps and an explicitly untested-draft subject, then report the
new commit and ask me whether to authorize the final macOS 26.0+ verification phase.
```

Optional shell launch command:

```sh
cd /home/kyle/harness-plugin && codex "Read HANDOFF-extract-video-frames.md completely and execute its Exact Next Action section."
```
