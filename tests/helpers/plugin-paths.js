'use strict';

const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');
// Stage 0: both concepts intentionally resolve to the existing installation tree.
// The distribution cutover changes these independently.
const authoringRoot = path.join(repositoryRoot, 'plugins/harness');
const distributionRoot = path.join(repositoryRoot, 'plugins/harness');

module.exports = {
  repositoryRoot,
  authoringRoot,
  distributionRoot,
  authoringPath: (...segments) => path.join(authoringRoot, ...segments),
  distributionPath: (...segments) => path.join(distributionRoot, ...segments),
};
