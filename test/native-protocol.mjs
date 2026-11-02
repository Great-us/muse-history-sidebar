import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const companion = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(companion, 'bin', 'muse-history-recycle.exe');
const sandbox = join(companion, 'native-recycle', 'test-sandbox');
assert.ok(sandbox.startsWith(companion + sep));
mkdirSync(sandbox, { recursive: true });

function fixture(label, session = '合成会话') {
  const base = mkdtempSync(join(sandbox, label + '-'));
  assert.ok(resolve(base).startsWith(sandbox + sep));
  const root = join(base, 'sessions');
  const directory = join(root, session);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session.jsonl'), 'synthetic native-helper fixture\n');
  return { base, root, session, directory };
}

function invoke(args) {
  const result = spawnSync(helper, args, {
    encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, 'helper stdout is one JSON object');
  return { code: result.status, value: JSON.parse(lines[0]) };
}

function argsFor(f) {
  return ['--root', f.root, '--session', f.session, '--directory', f.directory];
}

const windowsOnly = { skip: process.platform !== 'win32' };

test('native helper rejects malformed argv as one JSON error', windowsOnly, () => {
  for (const args of [[], ['--root'], ['--unknown', 'x'], ['--root', 'a', '--root', 'b']]) {
    const { code, value } = invoke(args);
    assert.notEqual(code, 0);
    assert.equal(value.status, 'failed');
    assert.equal(value.sourceGone, false);
    assert.equal(typeof value.message, 'string');
  }
});

test('native helper rejects basename mismatch, root, outside root and non-file logs', windowsOnly, () => {
  const f = fixture('protocol-boundary');
  const outside = join(f.base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'session.jsonl'), 'synthetic outside-root fixture');
  const notFile = join(f.root, 'not-a-file');
  mkdirSync(join(notFile, 'session.jsonl'), { recursive: true });
  const cases = [
    { ...f, session: 'other-id' },
    { ...f, session: 'sessions', directory: f.root },
    { ...f, session: 'outside', directory: outside },
    { ...f, session: 'not-a-file', directory: notFile },
  ];
  for (const candidate of cases) {
    const { code, value } = invoke(argsFor(candidate));
    assert.notEqual(code, 0);
    assert.equal(value.status, 'failed');
    assert.equal(value.sourceGone, false);
    assert.equal(typeof value.message, 'string');
  }
  assert.ok(existsSync(join(f.directory, 'session.jsonl')));
  assert.ok(existsSync(join(outside, 'session.jsonl')));
});

test('native helper refuses reparse target and canonical root escape', windowsOnly, () => {
  const f = fixture('protocol-junction');
  const outside = join(f.base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'session.jsonl'), 'synthetic junction target');
  for (const [session, target] of [['inside-link', f.directory], ['escape-link', outside]]) {
    const directory = join(f.root, session);
    symlinkSync(target, directory, 'junction');
    const { code, value } = invoke(argsFor({ ...f, session, directory }));
    assert.notEqual(code, 0);
    assert.equal(value.status, 'failed');
    assert.equal(value.sourceGone, false);
  }
  assert.ok(existsSync(join(outside, 'session.jsonl')));
});

test('native helper returns an actual receipt for non-ASCII synthetic session', {
  skip: process.platform !== 'win32' || process.env.MUSE_NATIVE_RECYCLE_TEST !== '1',
}, () => {
  const f = fixture('receipt', '原生回收-会话');
  const sha256 = createHash('sha256').update(readFileSync(join(f.directory, 'session.jsonl'))).digest('hex');
  const { code, value } = invoke(argsFor(f));
  console.log('NATIVE_RECYCLE_RECEIPT ' + JSON.stringify({ originalPath: f.directory, sha256, code, result: value }));
  assert.equal(code, 0);
  assert.equal(value.status, 'recycled');
  assert.equal(value.sourceGone, true);
  assert.equal(value.hasRecycleItem, true);
  assert.equal(typeof value.deleteHresult, 'number');
  assert.ok(value.deleteHresult >= 0);
  assert.equal(existsSync(f.directory), false);
});
