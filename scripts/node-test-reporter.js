'use strict';

// JSON lines are an internal pipe protocol, never a persistent report.
const { inspect } = require('node:util');
module.exports = async function* (source) {
  for await (const { type, data } of source) {
    if (!['test:dequeue', 'test:complete', 'test:pass', 'test:fail', 'test:summary', 'test:stdout', 'test:stderr', 'test:diagnostic'].includes(type)) continue;
    yield JSON.stringify({ type, data }, (key, value) => key === 'error' ? inspect(value, { depth: 8, colors: false }) : value) + '\n';
  }
};
