'use strict';

const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');
const authoringRoot = path.join(repositoryRoot, 'src/harness');
const distributionRoot = path.join(repositoryRoot, 'dist/harness');

module.exports = {
  repositoryRoot,
  authoringRoot,
  distributionRoot,
  authoringPath: (...segments) => path.join(authoringRoot, ...segments),
  distributionPath: (...segments) => path.join(distributionRoot, ...segments),
};
