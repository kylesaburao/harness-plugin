'use strict';

const path = require('node:path');
const { artifactRoot: resolveArtifactRoot, validateTarget } = require('../../scripts/artifact-paths');

const repositoryRoot = path.resolve(__dirname, '../..');
const authoringRoot = path.join(repositoryRoot, 'src/harness');
const target = validateTarget(process.env.HARNESS_TEST_TARGET ?? 'development');
const artifactRoot = resolveArtifactRoot(repositoryRoot, target);
const publishedRoot = resolveArtifactRoot(repositoryRoot, 'distribution');

function mapPublishedPath(destination)
{
  const relative = path.relative(publishedRoot, path.resolve(destination));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  {
    return destination;
  }
  return path.join(artifactRoot, relative);
}

module.exports = {
  repositoryRoot,
  authoringRoot,
  target,
  artifactRoot,
  publishedRoot,
  mapPublishedPath,
  authoringPath: (...segments) => path.join(authoringRoot, ...segments),
  artifactPath: (...segments) => path.join(artifactRoot, ...segments),
};
