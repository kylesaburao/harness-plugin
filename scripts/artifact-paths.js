'use strict';

const path = require('node:path');
const { parseArgs } = require('node:util');
const DEFAULT_TARGET = 'development';
const TARGETS = Object.freeze({ development: '.build/harness', distribution: 'dist/harness' });
// Extensions copied into an artifact unchanged. The builder classifies source
// with this list and every artifact check rejects anything else that is not
// compiled JavaScript.
const ASSET_EXTENSIONS = new Set(['.md', '.json', '.jsonl', '.yaml', '.yml', '.py', '.swift']);
// Path components that mark development-only or local content. No artifact
// path may contain one.
const FORBIDDEN_ARTIFACT_COMPONENTS = new Set([
  'node_modules', '__pycache__', 'tests', 'fixtures', 'benchmarks', 'evidence', '.git', '.build', '.venv', 'generated',
]);

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

// Parses a repository tooling command line with one strict node:util.parseArgs
// call and no positionals. Every option may appear at most once, and a string
// option's value must be non-empty and must not start with '-', including the
// inline --name=value spelling, so a value can never be mistaken for a flag or
// reach Git as one. usageError(code, condition) builds the caller's own exit-2
// error for UNKNOWN_ARGUMENT, MISSING_VALUE and DUPLICATE_ARGUMENT, reported for
// the first offending argument in command-line order. Absent booleans are false
// and absent strings are null.
function parseCommandLine(argv, options, usageError)
{
  let tokens;
  let strictFailure = null;
  try
  {
    ({ tokens } = parseArgs({ args: argv, options, strict: true, tokens: true }));
  }
  catch (error)
  {
    if (typeof error.code !== 'string' || !error.code.startsWith('ERR_PARSE_ARGS_'))
    {
      throw error;
    }
    // Strict mode names no offending argument in a stable form, so locate it
    // in the same command line parsed without enforcement.
    strictFailure = error;
    ({ tokens } = parseArgs({ args: argv, options, strict: false, tokens: true }));
  }
  const values = {};
  for (const token of tokens)
  {
    const option = token.kind === 'option' && Object.hasOwn(options, token.name) ? options[token.name] : null;
    if (option === null || (option.type === 'boolean' && token.value !== undefined))
    {
      throw usageError('UNKNOWN_ARGUMENT', `unrecognized argument: ${argv[token.index]}`);
    }
    const flag = `--${token.name}`;
    if (Object.hasOwn(values, token.name))
    {
      throw usageError('DUPLICATE_ARGUMENT', `${flag} was supplied more than once`);
    }
    if (option.type === 'string' && (token.value === undefined || token.value === '' || token.value.startsWith('-')))
    {
      throw usageError('MISSING_VALUE', `${flag} requires a value`);
    }
    values[token.name] = option.type === 'boolean' ? true : token.value;
  }
  if (strictFailure !== null)
  {
    throw usageError('INVALID_ARGUMENTS', strictFailure.message);
  }
  for (const [name, option] of Object.entries(options))
  {
    if (!Object.hasOwn(values, name))
    {
      values[name] = option.type === 'boolean' ? false : null;
    }
  }
  return values;
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

module.exports = {
  DEFAULT_TARGET,
  TARGETS,
  ASSET_EXTENSIONS,
  FORBIDDEN_ARTIFACT_COMPONENTS,
  ArtifactArgumentError,
  validateTarget,
  artifactRoot,
  artifactPath,
  parseCommandLine,
  assertReleaseWriteIntent,
};
