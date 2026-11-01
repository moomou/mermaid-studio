import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVersion } from '../build-version.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mermaid-studio-version-'));
  for (const directory of ['src', 'public', 'docs', 'tests']) mkdirSync(join(root, directory));
  for (const file of [
    'src/main.ts', 'public/favicon.svg', 'index.html', 'package.json', 'package-lock.json',
    'tsconfig.json', 'vite.config.ts', 'build-version.ts',
  ]) writeFileSync(join(root, file), file);
  return root;
}

test('build date is UTC and remains unchanged for identical production inputs', t => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = buildVersion(root, new Date('2026-10-31T17:08:35-07:00'));
  assert.equal(first.builtAt, '2026-11-01T00:08:35.000Z');
  writeFileSync(join(root, 'docs/version.json'), JSON.stringify(first));
  writeFileSync(join(root, 'docs/index.html'), 'Generated output');
  writeFileSync(join(root, 'README.md'), 'Documentation-only update');
  writeFileSync(join(root, 'tests/example.test.ts'), 'Test-only update');
  assert.deepEqual(buildVersion(root, new Date('2026-11-02T12:00:00Z')), first);
});

test('runtime source, public assets, and build configuration changes produce a new version', t => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['src/main.ts', 'public/favicon.svg', 'package-lock.json', 'vite.config.ts']) {
    const previous = buildVersion(root, new Date('2026-11-01T00:00:00Z'));
    writeFileSync(join(root, 'docs/version.json'), JSON.stringify(previous));
    writeFileSync(join(root, file), `Changed ${file}`);
    const next = buildVersion(root, new Date('2026-11-01T01:00:00Z'));
    assert.notEqual(next.fingerprint, previous.fingerprint);
    assert.equal(next.builtAt, '2026-11-01T01:00:00.000Z');
  }
});

test('malformed version metadata fails explicitly rather than changing a deployed stamp silently', t => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const metadata of [
    '{',
    JSON.stringify({ schema: 2, fingerprint: 'a'.repeat(64), builtAt: '2026-11-01T00:00:00.000Z' }),
    JSON.stringify({ schema: 1, fingerprint: 'a'.repeat(64), builtAt: '2026-02-30T00:00:00.000Z' }),
  ]) {
    writeFileSync(join(root, 'docs/version.json'), metadata);
    assert.throws(() => buildVersion(root), /invalid version metadata/);
  }
});
