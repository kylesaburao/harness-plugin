'use strict';

const path = require('node:path');
const DEFAULT_TARGET = 'development';
const TARGETS = Object.freeze({ development: '.build/harness', distribution: 'dist/harness' });

class ArtifactArgumentError extends Error
{
  constructor(code, condition, remedy)
  {
    super(condition);
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = 2;
  }
}

function validateTarget(target)
{
  if (!Object.hasOwn(TARGETS, target))
  {
    throw new ArtifactArgumentError('INVALID_TARGET', `unknown artifact target: ${target}`, 'select development or distribution');
  }
  return target;
}

function artifactRoot(root, target = DEFAULT_TARGET)
{
  return path.resolve(root, TARGETS[validateTarget(target)]);
}

function parseArtifactTarget(argv)
{
  let target = DEFAULT_TARGET;
  let explicitTarget = false;
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1)
  {
    if (argv[index] !== '--target')
    {
      remaining.push(argv[index]);
      continue;
    }
    if (explicitTarget)
    {
      throw new ArtifactArgumentError('DUPLICATE_TARGET', '--target was supplied more than once', 'supply --target once');
    }
    explicitTarget = true;
    target = validateTarget(argv[++index]);
  }
  return { target, explicitTarget, remaining };
}

function artifactPath(root, target, ...segments)
{
  const base = artifactRoot(root, target);
  const result = path.resolve(base, ...segments);
  const relative = path.relative(base, result);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  {
    throw new ArtifactArgumentError('INVALID_ARTIFACT_PATH', 'resource path escapes the selected artifact', 'use an artifact-relative resource path');
  }
  return result;
}

function assertReleaseWriteIntent(env = process.env)
{
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'kylesaburao/harness-plugin'
    || env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || env.HARNESS_RELEASE_WRITE !== '1')
  {
    throw new ArtifactArgumentError('RELEASE_WRITE_REQUIRED', 'canonical version and distribution writes require explicit main release workflow intent',
      'use npm run build for development; publish through the main release workflow');
  }
}

module.exports = { DEFAULT_TARGET, TARGETS, ArtifactArgumentError, validateTarget, artifactRoot, artifactPath, parseArtifactTarget, assertReleaseWriteIntent };
