import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { renderingCases } from './fixtures/rendering-cases.ts';

const [url, directory] = process.argv.slice(2);
if (!url || !directory) throw new Error('Usage: node --experimental-strip-types tests/compare-rendering.mjs <dev-server-url> <output-directory>');
const output = resolve(directory);
const session = `mermaid-comparisons-${process.pid}`;
mkdirSync(output, { recursive: true });

function browser(...args) {
  const response = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  }));
  if (!response.success) throw new Error(JSON.stringify(response.error));
  return response.data;
}

const results = [];
try {
  browser('open', new URL('/tests/visual.html', url).href);
  browser('set', 'viewport', '1600', '1020');
  browser('wait', '--fn', 'window.comparisonResults?.length === 2');
  for (let index = 0; index < renderingCases.length; index += 2) {
    const ids = renderingCases.slice(index, index + 2).map(item => item.id);
    const { result } = browser('eval', `window.renderComparisons(${JSON.stringify(ids)})`);
    results.push(...result);
    browser('screenshot', '--full', join(output, `${String(index / 2 + 1).padStart(2, '0')}-${ids.join('-')}.png`));
    console.log(ids.join(', '));
  }
  const { errors } = browser('errors');
  writeFileSync(join(output, 'results.json'), `${JSON.stringify({ results, browserErrors: errors }, null, 2)}\n`);
  console.table(results.map(item => ({
    case: item.id,
    native: item.native?.fittedFont,
    studio: item.studio?.fittedFont,
    sharpJoins: item.studio?.routing?.sharpJoins,
    error: item.error ?? '',
  })));
  const failures = results.filter(item => item.error);
  if (failures.length) throw new Error(`Failed comparisons: ${failures.map(item => `${item.id}: ${item.error}`).join('; ')}`);
  if (errors?.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
} finally {
  browser('close');
}
console.log(`Comparisons saved to ${output}`);
