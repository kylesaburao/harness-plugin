---
name: handoff
description: Write a durable Markdown file that brings a session starting with zero context up to speed on work still in flight, carrying only what that session cannot cheaply and reliably recover on its own. Use when context is running low and the work is not finished, when the user says they will continue tomorrow or on another machine, when the work is resuming in a new session or a different harness, or when a long investigation reached a conclusion the code does not record. Do not use for briefing a subagent dispatched from the current session, which gets its context from its own dispatch prompt, for a finished task with nothing in flight, for work a written plan file already fully describes, for permanent architectural reasoning, which belongs in a decision record, or for durable conventions aimed at every future session, which belong in CLAUDE.md or AGENTS.md.
---

# Hand off in-flight work

The reader is a session that starts with the repository and nothing else. No
transcript, no memory of what was tried, no idea which half-finished thing is
deliberate. Write for that reader, and write only what the repository is
going to fail to tell them.

## The subtraction rule

The test is not whether the information technically exists somewhere in the
repo. Nearly everything does, given enough effort, and a rule written that way
strips out exactly the conclusions that cost the most to reach. The test is:

**Can the next session recover this cheaply, reliably, and unambiguously from
durable artifacts?**

If yes, leave it out. If no, keep the conclusion, and keep it without
replaying the investigation that produced it.

So a behavior traced across several files, an implementation path that looks
obvious but was ruled out, a non-obvious property of the system established by
reading: all of these belong, even though a determined session could
re-derive them. What does not belong is the walk that got there. Write the
finding, not the search.

When a plan file, a todo list, or an issue already owns some of this state
cheaply and unambiguously, name it by path and carry only what it does not
hold. Two files describing the same state will drift apart, and then the next
session has two seeds that disagree and no way to tell which one is current.

## What the file has to answer

These are questions to answer, not headings to fill. A fixed schema traps the
file in the frame the work started in. Answer what applies, in whatever order
serves the reader, and skip what is genuinely empty rather than padding it.

Subtraction applies to every line, including the opening orientation, which is
where duplication sneaks back in: having named the plan file by path, do not
then summarize it. And a conclusion a cold session reaches from one read of a
file it is going to open anyway is not a finding worth recording.

Roughly ordered by how expensive each is for the next session to recover:

- **What was tried and abandoned, and the specific reason it failed.** The
  highest-value line in the file, and the one thing a fresh session is
  otherwise guaranteed to redo at full cost. Be concrete: which approach, what
  actually happened, what it cost. "Tried the Playwright loader, it added 30 to
  60 seconds per query" beats "that approach did not work out."
- **Why the obvious approach does not work**, when there is one. Related but
  distinct: this pre-empts a path nobody has tried yet but that looks inviting
  from a cold read.
- **What the user actually asked for**, in their framing, as distinct from
  what the current diff shows. Half-finished code misrepresents intent, and
  this is the anchor that stops scope drifting further with every session.
- **In-flight state.** What is half-done, what is stubbed, what is knowingly
  broken right now. Broken on purpose and broken by accident look identical to
  someone who was not there.
- **Decisions made in conversation and written down nowhere else**, each with
  its reason, each marked settled. Settled means the next session builds on it
  instead of reopening it. A decision consequential enough to outlive the task
  belongs in a decision record instead, and the handoff just points at it.
- **Verification and its gaps.** The gaps matter more than the passes here.
  Recovery cost applies to this bullet too: a check the next session can just
  re-run in a second does not need recording, while an expensive one, a long
  test run or a manual reproduction, does, along with the exact command. What
  always gets recorded is what was *not* checked. Silently omitting a gap is
  how a wrong assumption gets locked in permanently.
- **Open questions**, kept visibly unresolved. These are the counterpart to
  settled decisions and the two must not blur. A settled decision reopened
  wastes the next session's time. An open question mistaken for settled gets an
  answer nobody ever established. Say which questions are open and that no
  answer exists yet, so they read as neither forgotten work nor a decision
  already made.
- **The exact next action.** A concrete command, or a named file and the change
  to make in it. One action, not a direction and not a backlog.

## Present tense, not chronology

The file describes the state the previous session left behind, addressed to
the session picking it up. "Current goal is Z. X was abandoned because Y."

Not "first we tried X, then found Y, then discussed Z." That is transcript
drift wearing a summary's clothes, and it makes the reader reconstruct the end
state themselves from a story they did not need. Put events in order only when
the order is itself the finding.

If the work pivoted mid-session, describe where it landed, not the frame it
started in. Writing the file is the moment to notice the pivot, not to
preserve it.

## Say what is checked and what is guessed

A fresh session cannot tell a verified fact from a plausible guess, and
inheriting a guess as a fact is how a handoff does damage. So mark epistemic
status wherever it changes what the next session should do: empirical
findings, hypotheses not yet tested, verification gaps, external blockers.
Anything called verified names the command that verified it.

Do not prefix every ordinary sentence with a label. Mechanically tagging
everything drowns the signal and turns the file into a form. It should still
read as concise operational prose.

The reason the labels matter: **writing an inference into the file must not
promote it to fact.** A hypothesis that makes the trip into a file and out the
other side, stripped of its uncertainty on the way, is worse than one never
written down, because the next session now acts on it with confidence it never
earned. Keep the uncertainty in the same sentence as the claim. The file
transfers state, not authority.

## Where it goes

`HANDOFF.md` at the root of the working directory. One file, overwritten by
the next handoff. This skill takes no position on version control for it.

## Staleness is partial, not total

Open the file with the date, the branch, and the commit SHA it was written
against. Work continuing past that SHA makes the handoff *potentially* stale,
not automatically wrong. That distinction is the whole point: a file the
reader is told to distrust wholesale gets discarded, and then writing it
bought nothing.

The reading session's first move is to compare current HEAD against the
recorded SHA, look at what actually changed in between, and invalidate only
the parts of the handoff those changes touch. Everything the diff does not
reach still stands.

## What this is not

- A decision record captures permanent *why* and lives in an architecture doc.
  A handoff is working state that stops mattering once the work lands.
- CLAUDE.md and AGENTS.md hold durable conventions for every future session. A
  handoff describes one piece of unfinished work.
- `agentic-loop`'s round bookkeeping, its acceptance criteria and triage table,
  is state for a loop running now, not a handoff to a later session.
- Dispatching a subagent from the live session is not a handoff. The dispatch
  prompt is the brief. Writing a file to pass context sideways to an agent the
  session is already coordinating is work paid for twice.

## Style

Plain prose. Facts over hedges. Where the file does claim something was
checked, name the command, file, or measurement behind it, because "verified"
without evidence is an assertion, not a handoff.
