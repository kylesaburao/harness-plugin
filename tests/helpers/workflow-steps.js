'use strict';

const assert = require('node:assert/strict');

// Read the repository's literal job steps, preserving the shell exactly. This
// deliberately supports only the block/inline run syntax used by these workflows.
function workflowSteps(workflow, job)
{
  const start = workflow.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `Missing job: ${job}`);
  const body = workflow.slice(start + 1).split(/\n(?=  [\w-]+:\n)/)[0];
  return body.split(/\n(?=      - )/).slice(1).map(raw =>
  {
    const step = { raw };
    for (const match of raw.matchAll(/^(?:      - |        )(name|id|if|run|uses): (.+)$/gm))
    {
      step[match[1]] = match[2];
    }
    if (step.run === '|')
    {
      const lines = raw.slice(raw.indexOf('        run: |\n') + '        run: |\n'.length).split('\n');
      const shell = [];
      for (const line of lines)
      {
        if (line && !line.startsWith('          ')) break;
        shell.push(line.slice(10));
      }
      step.run = shell.join('\n');
    }
    return step;
  });
}

module.exports = { workflowSteps };
