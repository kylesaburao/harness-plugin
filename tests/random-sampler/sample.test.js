'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');
const script = path.resolve(__dirname, '../../plugins/harness/skills/random-sampler/scripts/sample.mjs');
function run(input, args = ['--json'], mode) {
  const result = spawnSync(process.execPath, [...(mode ? ['--require', path.join(__dirname, 'preload.cjs')] : []), script, ...args], {
    env: { ...process.env, SAMPLER_TEST_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  result.trace = (result.output[3] || '').trim().split('\n').filter(Boolean).map(JSON.parse);
  return result;
}
function fail(result, code, status = 2) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error;
  assert.deepEqual(Object.keys(error), ['code', 'condition', 'remedy']);
  assert.equal(error.code, code);
  assert.ok(error.condition.length && error.remedy.length);
}
function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const body = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(body) + '\n');
  return body;
}
test('modes and invalid flags finish with stdin held open', async () => {
  for (const args of [['--help'], ['--help', '--json'], ['--preflight', '--json'], ['--wat', '--json'], ['--json', '--json'], ['--help', '--preflight', '--json']]) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: 'pipe' });
      let out = '', err = '';
      child.stdout.on('data', x => { out += x; });
      child.stderr.on('data', x => { err += x; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('waited for stdin')); }, 3000);
      child.on('error', reject);
      child.on('close', status => {
        clearTimeout(timer);
        try {
          if (args.includes('--wat')) fail({ status, stdout: out, stderr: err }, 'UNKNOWN_ARGUMENT');
          else if (args.length === 3 || args[0] === '--json') fail({ status, stdout: out, stderr: err }, 'INVALID_ARGUMENTS');
          else { assert.equal(status, 0, err); assert.ok(out.length); }
          resolve();
        } catch (e) { reject(e); }
      });
    });
  }
});
test('exact preflight and help contracts', () => {
  assert.deepEqual(ok(run('', ['--preflight', '--json'])), { preflight: { status: 'passed', node: process.versions.node, crypto: 'available' } });
  const help = run('', ['--help']);
  assert.equal(help.status, 0);
  for (const word of ['integer', 'boolean', 'choice', 'sample', 'shuffle', 'maxExclusive', 'stdin', '2^48']) assert.ok(help.stdout.includes(word));
  assert.match(run('', []).stderr, /^ERROR \[EMPTY_INPUT\]: .+\nRemedy: .+\n$/);
  fail(run('', ['--help', '--help', '--wat', '--json']), 'UNKNOWN_ARGUMENT');
});
test('request validation and strict operation fields', () => {
  for (const [input, code] of [
    ['', 'EMPTY_INPUT'], [' \n', 'EMPTY_INPUT'], ['{', 'INVALID_JSON'], ['{} {}', 'INVALID_JSON'],
    ['null', 'INVALID_REQUEST'], ['[]', 'INVALID_REQUEST'], ['1', 'INVALID_REQUEST'], [{}, 'INVALID_REQUEST'],
    [{ op: 1 }, 'INVALID_REQUEST'], [{ op: 'constructor' }, 'UNKNOWN_OPERATION'],
    ...['integer', 'boolean', 'choice', 'sample', 'shuffle'].map(op => [{ op, typo: 1 }, 'INVALID_REQUEST']),
    [{ op: 'choice', values: [] }, 'INVALID_VALUES'], [{ op: 'shuffle', values: 'abc' }, 'INVALID_VALUES'],
    [{ op: 'sample', values: [] }, 'INVALID_COUNT'],
    ...[-1, 1, 0.5, '0', 2 ** 53].map(count => [{ op: 'sample', values: [], count }, 'INVALID_COUNT']),
  ]) fail(run(input), code);
});
test('integer boundaries and normal schemas', () => {
  for (const [min, maxExclusive] of [[0,0], [2,1], [0,2**48], [0,2**53], [0.5,2], [0,1.5], ['0',2], [null,2], [{valueOf:null,toString:null},2], [0,{}], [-1, 2**48]]) {
    fail(run({ op: 'integer', min, maxExclusive }), 'INVALID_INTEGER_RANGE');
  }
  for (const [min, maxExclusive] of [[1,101], [-(2**47),2**47-1], [Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER]]) {
    const body = ok(run({ op: 'integer', min, maxExclusive }));
    assert.deepEqual(Object.keys(body), ['op','value']);
    assert.equal(body.op, 'integer');
    assert.ok(Number.isSafeInteger(body.value) && body.value >= min && body.value < maxExclusive);
  }
  const b = ok(run({ op: 'boolean' }));
  assert.deepEqual(Object.keys(b), ['op','value']);
  assert.equal(b.op, 'boolean');
  assert.equal(typeof b.value, 'boolean');
});
test('array values preserve original positions and arbitrary JSON', () => {
  const values = ['A','A','B','"\'\n\t $() `echo hi` \\ 雪', { a: [null,true,false] }, [1,2], null, true];
  const choice = ok(run({ op: 'choice', values }));
  assert.deepEqual(Object.keys(choice), ['op','index','value']);
  assert.deepEqual(choice.value, values[choice.index]);
  for (const request of [{ op: 'sample', values, count: 3 }, { op: 'sample', values, count: values.length }, { op: 'shuffle', values }]) {
    const result = ok(run(request));
    assert.deepEqual(Object.keys(result), ['op','indices','values']);
    assert.equal(result.op, request.op);
    assert.equal(result.indices.length, request.count ?? values.length);
    assert.equal(new Set(result.indices).size, result.indices.length);
    assert.ok(result.indices.every(i => Number.isInteger(i) && i >= 0 && i < values.length));
    assert.deepEqual(result.values, result.indices.map(i => values[i]));
  }
});


test('runtime failures, validation precedence, and no entropy on rejected requests', () => {
  for (const [mode, code] of [['old','UNSUPPORTED_NODE'], ['old-json','UNSUPPORTED_NODE'], ['missing','CRYPTO_UNAVAILABLE'], ['import','CRYPTO_UNAVAILABLE']]) {
    for (const [input,args] of [[{ op: 'boolean' },['--json']], [{ op: 'integer', min: 1, maxExclusive: 2 },['--json']], ['', ['--preflight','--json']]]) {
      const result = run(input,args,mode);
      fail(result,code);
      assert.deepEqual(result.trace,[]);
    }
    const invalid = run({op:'sample',values:[],count:1},['--json'],mode);
    fail(invalid,'INVALID_COUNT');
    assert.deepEqual(invalid.trace,[]);
    assert.equal(run('', ['--help'],mode).status,0);
  }
  fail(run('', ['--wat','--json'],'old'),'UNKNOWN_ARGUMENT');
  fail(run('', ['--json'],'read'),'INPUT_READ_FAILED');
  const failure = run({op:'boolean'},['--json'],'throw');
  fail(failure,'SAMPLING_FAILED',1);
  assert.deepEqual(failure.trace,[[2]]);
  assert.equal(ok(run('', ['--preflight','--json'],'floor')).preflight.node,'22.0.0');
});
test('forced outcomes and preflight use zero entropy calls', () => {
  for (const [request, expected] of [
    [{op:'integer',min:-9,maxExclusive:-8},{op:'integer',value:-9}],
    [{op:'choice',values:[null]},{op:'choice',index:0,value:null}],
    [{op:'sample',values:['a','b'],count:0},{op:'sample',indices:[],values:[]}],
    [{op:'sample',values:[],count:0},{op:'sample',indices:[],values:[]}],
    [{op:'sample',values:['a'],count:1},{op:'sample',indices:[0],values:['a']}],
    [{op:'shuffle',values:[]},{op:'shuffle',indices:[],values:[]}],
    [{op:'shuffle',values:['a']},{op:'shuffle',indices:[0],values:['a']}],
  ]) {
    const result = run(request,['--json'],'throw');
    assert.deepEqual(ok(result),expected);
    assert.deepEqual(result.trace,[]);
  }
  const probe = run('', ['--preflight','--json'],'throw');
  ok(probe);
  assert.deepEqual(probe.trace,[]);
  for (const input of ['', '{', {op:'wat'}, {op:'integer',min:0,maxExclusive:2**48}]) {
    const result = run(input,['--json'],'throw');
    assert.equal(result.status,2);
    assert.deepEqual(result.trace,[]);
  }
});
test('Fisher-Yates draw bounds, draw order, duplicate positions, and exact mappings', () => {
  const values = ['A','A',{x:'雪'},null];
  for (const [op,count,indices,trace] of [
    ['sample',2,[3,0],[[0,4],[1,4]]],
    ['sample',4,[3,0,1,2],[[0,4],[1,4],[2,4]]],
    ['shuffle',undefined,[0,1,2,3],[[4],[3],[2]]],
  ]) {
    const result = run({op,values,...(count === undefined ? {} : {count})},['--json'],'trace');
    assert.deepEqual(ok(result),{op,indices,values:indices.map(i=>values[i])});
    assert.deepEqual(result.trace,trace);
  }
  const choice = run({op:'choice',values:['A','A','B']},['--json'],'trace');
  assert.deepEqual(ok(choice),{op:'choice',index:2,value:'B'});
  assert.deepEqual(choice.trace,[[3]]);
  const integer = run({op:'integer',min:-2,maxExclusive:3},['--json'],'trace');
  assert.deepEqual(ok(integer),{op:'integer',value:2});
  assert.deepEqual(integer.trace,[[-2,3]]);
  assert.deepEqual(ok(run({op:'boolean'},['--json'],'trace')),{op:'boolean',value:true});
});

test('candidate numeric tokens survive choice, sample, and shuffle without precision loss', () => {
  const values = ['1e400', '9007199254740993', '-0', '1e-400', '{"x":[1e400,1e-400,9007199254740993,-0],"rawJSON":"1e400"}'];
  for (const value of values) {
    const result = run(`{"op":"choice","values":[${value}]}`, ['--json'], 'throw');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `{"op":"choice","index":0,"value":${value}}\n`);
    assert.deepEqual(result.trace, []);
  }
  for (const [op, indices] of [['sample', [4,0,1,2,3]], ['shuffle', [0,1,2,3,4]]]) {
    const result = run(`{"op":"${op}","values":[${values.join(',')}]${op === 'sample' ? ',"count":5' : ''}}`, ['--json'], 'trace');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `{"op":"${op}","indices":${JSON.stringify(indices)},"values":[${indices.map(i => values[i]).join(',')}]}\n`);
  }
});

test('operation numeric arguments reject rounding and accept exact alternate integer notation', () => {
  for (const token of ['1.0000000000000001', '1e-400', '-1e-400', '9007199254740991.1', '1e400']) {
    for (const [request, code] of [
      [`{"op":"integer","min":${token},"maxExclusive":9007199254740991}`, 'INVALID_INTEGER_RANGE'],
      [`{"op":"integer","min":0,"maxExclusive":${token}}`, 'INVALID_INTEGER_RANGE'],
      [`{"op":"sample","values":["a"],"count":${token}}`, 'INVALID_COUNT'],
    ]) {
      const result = run(request, ['--json'], 'throw');
      fail(result, code);
      assert.deepEqual(result.trace, []);
    }
  }
  for (const token of ['1.0', '10e-1', '0.01e2', '1e+000000000000000000000000000000000000000000000000000000000000000000000000']) {
    assert.deepEqual(ok(run(`{"op":"sample","values":["a"],"count":${token}}`, ['--json'], 'throw')), { op: 'sample', indices: [0], values: ['a'] });
  }
  for (const token of ['0e999999999999999999999999', '-0', '0.0000e-400']) {
    assert.deepEqual(ok(run(`{"op":"sample","values":[],"count":${token}}`, ['--json'], 'throw')), { op: 'sample', indices: [], values: [] });
  }
  assert.deepEqual(ok(run('{"op":"integer","min":-12e1,"maxExclusive":-119.0}', ['--json'], 'throw')), { op: 'integer', value: -120 });
});
