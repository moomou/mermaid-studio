import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildVersion {
  schema: 1;
  fingerprint: string;
  builtAt: string;
}

function fingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (path: string): void => {
    const absolute = join(root, path);
    if (statSync(absolute).isDirectory()) {
      for (const child of readdirSync(absolute).sort()) visit(`${path}/${child}`);
    } else {
      hash.update(path).update('\0').update(readFileSync(absolute)).update('\0');
    }
  };
  for (const input of [
    'build-version.ts', 'index.html', 'package-lock.json', 'package.json',
    'public', 'src', 'tsconfig.json', 'vite.config.ts',
  ]) visit(input);
  return hash.digest('hex');
}

function previousVersion(root: string): BuildVersion | undefined {
  let source: string;
  try {
    source = readFileSync(join(root, 'docs/version.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error('docs/version.json contains invalid version metadata.', { cause: error });
  }
  if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 1
    || !('fingerprint' in value) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !('builtAt' in value) || typeof value.builtAt !== 'string'
    || !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt) {
    throw new Error('docs/version.json contains invalid version metadata.');
  }
  return { schema: 1, fingerprint: value.fingerprint, builtAt: value.builtAt };
}

export function buildVersion(root: string, now = new Date()): BuildVersion {
  const current = fingerprint(root);
  const previous = previousVersion(root);
  return previous?.fingerprint === current
    ? previous
    : { schema: 1, fingerprint: current, builtAt: now.toISOString() };
}
