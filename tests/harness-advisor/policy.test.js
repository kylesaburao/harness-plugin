'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../dist/harness/skills');
const policy = fs.readFileSync(path.join(root, 'harness-advisor/SKILL.md'), 'utf8');
const activation = fs.readFileSync(path.join(root, 'install-harness-plugin-capabilities/references/activation-instructions.md'), 'utf8');
const [codexBlock, claudeBlock] = [...activation.matchAll(/```markdown\n([\s\S]*?)```/g)].map(match => match[1]);

// Retained public instruction contracts, not claims of live model enforcement.
test('policy retains separate budgets, peer gate, and relevant model-neutral carryover', () => {
  for (const phrase of ['USER_REQUEST', 'AUTOMATIC', '3 automatic calls', 'User calls do not consume',
    '**not** reset task call counts', 'disable further automatic calls', 'NEW_EVIDENCE',
    'APPROACH_FAILED', 'RECONCILE_CONFLICT', 'FINAL_REVIEW alone does not waive',
    'SUPERSEDES', 'Advisor speculation is not evidence',
    'Copy the baseline and existing serialized ledger verbatim', 'not the semantic epoch']) assert.ok(policy.includes(phrase), phrase);
});

test('context policy preserves relevance, actual capacity, explicit budgets, and honest omissions', () => {
  for (const phrase of ['Harness token or byte limit', 'obsolete material', 'confusing',
    'complete consultation', 'space\nneeded for output and host-provided instructions',
    'explicit user cost or\nlatency budget', 'Do not remove\nnecessary evidence',
    'report the limitation and any material omission', 'Missing telemetry alone',
    'Compaction preserves useful task facts and all task accounting']) assert.ok(policy.includes(phrase), phrase);
  assert.doesNotMatch(policy, /8,000|16,000|UTF-8 bytes|soft target|hard limit/);
});

test('Claude activation suppresses Harness on native presence including native errors', () => {
  const block = claudeBlock;
  for (const phrase of ['server tool', 'Managed Agents', 'do not load, invoke, or otherwise use',
    'Native errors do not enable Harness fallback', 'Only when native Advisor is unavailable',
    'explicit native-only request', 'Do not use both']) assert.ok(block.includes(phrase), phrase);
  assert.ok(!codexBlock.includes('native'));
});

test('Codex dispatch uses an ordinary fresh agent and distinguishes instructions from permissions', () => {
  const host = fs.readFileSync(path.join(root, 'harness-advisor/references/host-codex.md'), 'utf8');
  for (const phrase of ['ordinary fresh subagent', 'model and reasoning effort',
    'fork_turns: "none"', 'canonical `contract.md`', 'No named role is required',
    'must not block consultation', 'unsupported effort', 'enforced permissions',
    'contract alone does not establish', 'additional child permission controls']) assert.ok(host.includes(phrase), phrase);
  const dispatch = host.replace(/\s+/g, ' ');
  for (const phrase of ['Pass the prepared prompt unchanged as the spawn tool’s message argument',
    'The canonical contract already supplies the Advisor’s role and restrictions',
    'Add no preamble, wrapper delimiters, or closing instructions',
    'Immediately before dispatch, check the actual message argument, not merely a saved prompt file',
    'it must begin with the exact canonical contract and match the prepared prompt',
    'This check applies to the agent-authored message, not additional context injected by the host']) {
    assert.ok(dispatch.includes(phrase), phrase);
  }
  const contract = fs.readFileSync(path.join(root, 'harness-advisor/references/contract.md'), 'utf8');
  assert.match(contract, /Use no tools/);
  assert.match(contract, /Do not modify files, create commits, mutate external state, or spawn agents/);
});

// These protect required declarations, not model adherence or permission enforcement.
test('source inspection retains attribution, coherent targets, and qualified conclusions', () => {
  const contract = fs.readFileSync(path.join(root, 'harness-advisor/references/contract.md'), 'utf8');
  for (const phrase of ['not authentication', 'primary-reported runtime results',
    'Source inspection cannot authenticate user approval', 'partial/truncated reads',
    'mixed-state final review', 'coverage judgment', 'within the inspected scope']) assert.ok(contract.includes(phrase), phrase);
  for (const phrase of ['repository-wide changed-path inventory', 'before narrowing content',
    'unchanged status filenames do not prove content stability', 'policy version (2)',
    'selected tool policy', 'Reinspect material changed premises', 'primary/executor-owned writers']) assert.ok(policy.includes(phrase), phrase);
});
