'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { workflowSteps } = require('../helpers/workflow-steps');
const root = path.resolve(__dirname, '../..');
const publication = fs.readFileSync(path.join(root, '.github/workflows/bump-version.yml'), 'utf8');
const verification = fs.readFileSync(path.join(root, '.github/workflows/verify.yml'), 'utf8');
const steps = workflowSteps(publication, 'test');

test('main routing gates all candidate work after source validation and retains unconditional integrity checks', () =>
{
  const policy = steps.findIndex(step => step.name === 'Validate source before generation');
  const selection = steps.findIndex(step => step.id === 'candidate');
  assert.ok(policy >= 0 && policy < selection);
  const expensive = steps.filter(step => step.uses === 'actions/setup-python@v6' ||
    ['npm ci --include=dev', 'npm run build', 'npm run test:setup', 'npm test -- --skip-gif'].includes(step.run));
  assert.equal(expensive.length, 5);
  for (const step of expensive)
  {
    assert.ok(steps.indexOf(step) > selection);
    assert.equal(step.if, "steps.candidate.outputs.test_candidate == 'true'");
  }
  const integrity = steps.find(step => step.name === 'Verify tracked checkout remained unchanged');
  assert.equal(integrity.if, undefined);
  assert.match(integrity.run, /git diff --exit-code\n.*git diff --cached --exit-code/);
  assert.ok(steps.indexOf(integrity) > steps.indexOf(expensive.at(-1)));
  assert.match(steps[selection].raw, /DISPATCH_LEVEL: \$\{\{ inputs.level \}\}/);
  assert.match(publication, /bump:\n    needs: test\n    permissions:\n      contents: write/);
  assert.doesNotMatch(publication.split('\n  bump:\n')[1].split('    steps:')[0], /\bif:/);
  assert.match(publication, /concurrency:\n  group: version-bump\n  cancel-in-progress: false\n  queue: max/);
});

test('selection uses publication policy and fails closed without output on errors or unknown dispositions', () =>
{
  const shell = steps.find(step => step.id === 'candidate').run;
  assert.match(shell, /^node - <<'NODE'\n[\s\S]+\nNODE\n?$/);
  const code = shell.replace(/^node - <<'NODE'\n/, '').replace(/\nNODE\n?$/, '');
  for (const manualLevel of [null, 'patch', 'minor', 'major'])
  {
    for (const [status, expected] of [['ready', false], ['already published', false], ['no eligible changes', true], ['unknown', null], ['throw', null]])
    {
      const writes = [];
      let calls = 0;
      const invoke = () => vm.runInNewContext(code, {
        process: {cwd: () => '/event', env: {
          GITHUB_RUN_ID:'42', GITHUB_WORKFLOW_SHA:'executed-sha',
          GITHUB_EVENT_NAME:manualLevel ? 'workflow_dispatch' : 'push',
          DISPATCH_LEVEL:manualLevel ?? 'ignored-push-input',
          GITHUB_OUTPUT:'output', GITHUB_STEP_SUMMARY:'summary',
        }},
        require(name)
        {
          if (name === 'node:fs') return {appendFileSync: (...args) => writes.push(args)};
          assert.equal(name, './scripts/release-policy');
          return {inspectPublication(cwd, options)
          {
            calls++;
            assert.equal(cwd, '/event');
            assert.deepEqual(JSON.parse(JSON.stringify(options)), {
              head:'HEAD', runId:'42', workflowSha:'executed-sha', manualLevel,
            });
            if (status === 'throw') throw Error('policy failed');
            return {status};
          }};
        },
      });
      if (expected === null)
      {
        assert.throws(invoke, /policy failed|Unexpected publication disposition/);
        assert.deepEqual(writes, []);
      }
      else
      {
        invoke();
        assert.deepEqual(writes.filter(([file]) => file === 'output'), [['output', `test_candidate=${expected}\n`]]);
      }
      assert.equal(calls, 1);
    }
  }
});

test('PR verification cancels obsolete runs for the same PR and still tests its pinned integration', () =>
{
  assert.match(verification, /on: pull_request/);
  assert.match(verification, /concurrency:\n  group: \$\{\{ github.workflow \}\}-\$\{\{ github.event.pull_request.number \}\}\n  cancel-in-progress: true/);
  assert.match(verification, /permissions:\n  contents: read/);
  assert.match(verification, /ref: \$\{\{ github.sha \}\}\n          fetch-depth: 0\n          persist-credentials: false/);
  const pr = workflowSteps(verification, 'verify');
  const node = pr.filter(step => step.uses === 'actions/setup-node@v4');
  assert.equal(node.length, 1);
  assert.match(node[0].raw, /node-version-file: '\.nvmrc'/);
  assert.doesNotMatch(node[0].raw, /node-version:/);
  const policy = pr.findIndex(step => step.run?.includes('check-source-policy.js'));
  const install = pr.findIndex(step => step.run === 'npm ci --include=dev');
  const build = pr.findIndex(step => step.run === 'npm run build');
  const setup = pr.findIndex(step => step.run === 'npm run test:setup');
  const gate = pr.findIndex(step => step.run === 'npm test -- --skip-gif');
  assert.ok(policy >= 0 && policy < install && install < build && build < setup && setup < gate);
  assert.match(pr[policy].run, /--base "\$SOURCE_BASE" --head "\$SOURCE_HEAD" --integration "\$INTEGRATION"/);
  assert.match(pr[policy].raw, /INTEGRATION: \$\{\{ github.sha \}\}/);
  assert.ok(pr.every(step => step.if === undefined));
});
