import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [url, directory] = process.argv.slice(2);
if (!url || !directory) throw new Error('Usage: node tests/check-ui.mjs <app-url> <output-directory>');
const output = resolve(directory);
const session = `mermaid-ui-check-${process.pid}`;
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
mkdirSync(output, { recursive: true });

function browser(...args) {
  const response = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  }));
  if (!response.success) throw new Error(JSON.stringify(response.error));
  return response.data;
}

function evaluate(code) {
  return browser('eval', code).result;
}

function wait(condition) {
  browser('wait', '--fn', condition);
}

function captureDownload(selector, path) {
  // Capture the actual download Blob and filename independently of OS download settings.
  evaluate(`(() => {
    const blobs = new Map();
    window.__originalCreateURL = URL.createObjectURL;
    URL.createObjectURL = blob => {
      const url = window.__originalCreateURL.call(URL, blob);
      blobs.set(url, blob);
      return url;
    };
    window.__captureDownload = event => {
      const link = event.target instanceof Element ? event.target.closest('a[download]') : null;
      if (!link) return;
      event.preventDefault();
      const blob = blobs.get(link.href);
      const reader = new FileReader();
      reader.onload = () => {
        window.__download = { name: link.download, type: blob.type, base64: reader.result.split(',')[1] };
      };
      reader.readAsDataURL(blob);
    };
    document.addEventListener('click', window.__captureDownload, true);
    return true;
  })()`);
  try {
    browser('click', selector);
    wait('Boolean(window.__download)');
    const download = evaluate('window.__download');
    writeFileSync(path, Buffer.from(download.base64, 'base64'));
    return download;
  } finally {
    evaluate(`document.removeEventListener('click', window.__captureDownload, true);
      URL.createObjectURL = window.__originalCreateURL;
      delete window.__originalCreateURL; delete window.__captureDownload; delete window.__download; true`);
  }
}

function state() {
  return evaluate(`({
    titles: [...document.querySelectorAll('button[role="tab"]')].map(tab => tab.textContent),
    renderer: document.querySelector('#viewer svg')?.dataset.renderer,
    nodes: document.querySelectorAll('#viewer .node').length,
    svgDisabled: document.querySelector('#svg').disabled,
    pngDisabled: document.querySelector('#png').disabled,
    error: !document.querySelector('#error').hidden,
    status: document.querySelector('#status').textContent,
    workspace: JSON.parse(localStorage.getItem('mermaid-studio-workspace-v1'))
  })`);
}

const checks = [];
try {
  browser('open', url);
  browser('set', 'viewport', '1600', '1000');
  browser('set', 'media', 'light');
  wait('document.querySelector("#viewer svg") && !document.querySelector("#svg").disabled');
  browser('screenshot', join(output, 'deployment-desktop.png'));
  browser('upload', '#file', fixture('import.md'));
  wait('document.querySelectorAll("button[role=tab]").length === 3 && !document.querySelector("#svg").disabled');
  let current = state();
  assert.deepEqual(current.titles.slice(1), ['Uploaded flow', 'Uploaded sequence']);
  assert.equal(current.renderer, 'structured');
  assert.equal(current.nodes, 4);
  assert.equal(current.workspace.tabs[1].source.includes('```'), false);
  assert.equal(current.workspace.tabs[2].source.includes('sequenceDiagram'), true);
  assert.equal(current.workspace.activeId, current.workspace.tabs[1].id);
  const flowId = current.workspace.tabs[1].id;
  const sequenceId = current.workspace.tabs[2].id;
  checks.push('All Markdown blocks import into independent tabs, with the first selected.');

  browser('click', '.node[data-entity="B"]');
  assert.ok(evaluate('document.querySelectorAll("#viewer .is-selected").length > 0'));
  const svgPath = join(output, 'uploaded-flow.svg');
  const pngPath = join(output, 'uploaded-flow.png');
  assert.equal(captureDownload('#svg', svgPath).name, 'uploaded-flow.svg');
  assert.equal(captureDownload('#png', pngPath).type, 'image/png');
  const svg = readFileSync(svgPath, 'utf8');
  assert.equal(svg.match(/class="node"/g)?.length, 4);
  assert.doesNotMatch(svg, /class="[^"]*\bis-(?:selected|dimmed)\b/);
  assert.deepEqual([...readFileSync(pngPath).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  browser('press', 'Escape');
  browser('click', '#edit');
  const sourcePath = join(output, 'uploaded-source.mmd');
  captureDownload('#save-source', sourcePath);
  assert.match(readFileSync(sourcePath, 'utf8'), /^---\ntitle: Uploaded flow\n---\nflowchart TB/);
  browser('click', '#cancel');
  browser('screenshot', join(output, 'uploaded-flow-desktop.png'));
  checks.push('Tracing, complete SVG/PNG exports, and extracted .mmd download work.');

  browser('click', `button[data-tab-id="${sequenceId}"]`);
  wait('document.querySelector("#viewer svg")?.dataset.renderer === "native" && !document.querySelector("#svg").disabled');
  assert.equal(state().pngDisabled, true);
  captureDownload('#svg', join(output, 'uploaded-sequence.svg'));
  browser('screenshot', join(output, 'uploaded-sequence-desktop.png'));
  browser('reload');
  wait('document.querySelector("#viewer svg")?.dataset.renderer === "native" && !document.querySelector("#svg").disabled');
  assert.deepEqual(state().titles.slice(1), ['Uploaded flow', 'Uploaded sequence']);
  checks.push('Native diagram imports, tab switching, SVG export, and reload persistence work.');

  browser('upload', '#file', fixture('invalid-import.md'));
  wait('!document.querySelector("#error").hidden');
  current = state();
  assert.equal(current.titles.length, 3);
  assert.equal(current.svgDisabled, false);
  assert.equal(current.renderer, 'native');
  assert.match(evaluate('document.querySelector("#error").textContent'), /Diagram 2/);
  checks.push('An invalid later Markdown block does not partially import or replace the current diagram.');

  evaluate('window.__originalWorker = window.Worker; window.Worker = function () { throw new Error("Intentional layout-worker failure"); }; true');
  browser('click', `button[data-tab-id="${flowId}"]`);
  wait('document.querySelector("#viewer svg")?.dataset.renderer === "native" && document.querySelector("#status").textContent.includes("original Mermaid layout instead")');
  assert.equal(state().pngDisabled, true);
  browser('screenshot', join(output, 'native-fallback.png'));
  evaluate('window.Worker = window.__originalWorker; delete window.__originalWorker; true');
  browser('click', '#edit');
  browser('click', '#source-form .primary');
  wait('document.querySelector("#viewer svg")?.dataset.renderer === "structured" && !document.querySelector("#svg").disabled');
  checks.push('A layout-worker failure falls back to native Mermaid with an explanation, and can recover.');

  browser('click', '#edit');
  browser('fill', '#source', 'flowchart TB\n A["Unclosed');
  browser('click', '#source-form .primary');
  wait('!document.querySelector("#source-error").hidden');
  current = state();
  assert.equal(current.nodes, 4);
  assert.equal(current.svgDisabled, true);
  assert.equal(current.pngDisabled, true);
  browser('click', '#cancel');
  wait('!document.querySelector("#svg").disabled && document.querySelector("#error").hidden');

  browser('click', '#edit');
  evaluate(`(() => {
    const source = document.querySelector('#source');
    const form = document.querySelector('#source-form');
    source.value = 'flowchart TB\\n Old --> Older';
    form.requestSubmit();
    source.value = '---\\ntitle: Latest edit\\n---\\nflowchart LR\\n X[First] --> Y[Second]';
    form.requestSubmit();
    return true;
  })()`);
  wait('document.title.startsWith("Latest edit") && !document.querySelector("#svg").disabled');
  assert.equal(state().nodes, 2);
  checks.push('Invalid edits retain the previous view, cancellation restores exports, and the newest render wins.');

  browser('click', '#theme');
  const theme = evaluate('document.documentElement.dataset.theme');
  browser('set', 'viewport', '390', '844');
  browser('reload');
  wait('document.title.startsWith("Latest edit") && !document.querySelector("#svg").disabled');
  assert.equal(evaluate('document.documentElement.dataset.theme'), theme);
  assert.equal(evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  browser('screenshot', join(output, 'mobile.png'));
  checks.push('Mobile fitting and persisted appearance work.');

  const { errors } = browser('errors');
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'checks.json'), `${JSON.stringify({ checks, browserErrors: errors }, null, 2)}\n`);
  checks.forEach(check => console.log(`PASS ${check}`));
} finally {
  browser('close');
}
console.log(`UI evidence saved to ${output}`);
