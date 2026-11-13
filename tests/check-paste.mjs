import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { examples } from '../src/examples.ts';

const [url, directory] = process.argv.slice(2);
if (!url || !directory) throw new Error('Usage: node --experimental-strip-types tests/check-paste.mjs <app-url> <output-directory>');
const output = resolve(directory);
const session = `mermaid-paste-check-${process.pid}`;
mkdirSync(output, { recursive: true });

function browser(...args) {
  const response = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  }));
  if (!response.success) throw new Error(JSON.stringify(response.error));
  return response.data;
}

const evaluate = code => browser('eval', code).result;
const wait = condition => browser('wait', '--fn', condition);
const workspace = () => evaluate('JSON.parse(localStorage.getItem("mermaid-studio-workspace-v1"))');
const fence = source => `\`\`\`mermaid\n${source}\n\`\`\``;
const flow = '---\ntitle: Pasted flow\n---\nflowchart LR\n PasteA[Paste] --> PasteB[Render]';

function paste(contents) {
  browser('click', '#edit');
  browser('fill', '#source', contents);
  assert.equal(evaluate('document.querySelector("#source").value'), contents, 'The test must paste the complete Markdown into the Source editor');
}

function render(native = false) {
  browser(native ? 'check' : 'uncheck', '#original');
  browser('click', '#source-form .primary');
  wait('!document.querySelector("#source-dialog").open || !document.querySelector("#source-error").hidden');
  assert.equal(evaluate('document.querySelector("#source-error").hidden'), true,
    `Pasted Markdown did not render: ${evaluate('document.querySelector("#source-error").textContent')}`);
  assert.equal(evaluate('document.querySelector("#svg").disabled'), false);
}

const checks = [];
try {
  browser('open', url);
  browser('set', 'viewport', '1600', '1000');
  wait('document.querySelector("#viewer svg") && !document.querySelector("#svg").disabled');

  paste(fence(flow));
  browser('screenshot', join(output, 'pasted-markdown-source.png'));
  render();
  assert.equal(evaluate('document.querySelectorAll("#viewer .node").length'), 2);
  assert.equal(workspace().tabs.length, 1);
  assert.equal(workspace().tabs[0].source, flow);
  browser('screenshot', join(output, 'pasted-flow.png'));
  checks.push('Markdown pasted directly into Source renders in the current tab without opening a file.');

  paste(`# Deployment plan\n\nThe complete deployment diagram follows.\n\n${fence(examples[0].source)}\n\nEnd of document.`);
  render();
  assert.equal(evaluate('document.querySelectorAll("#viewer .node").length'), 24);
  assert.equal(evaluate('document.querySelectorAll("#viewer .edge").length'), 26);
  browser('screenshot', join(output, 'pasted-deployment.png'));
  checks.push('Markdown prose, frontmatter, and the complete deployment example render directly from Source.');

  paste(`# Original layout\n\n~~~MERMAID\n${flow.replace('Pasted flow', 'Pasted original')}\n~~~`);
  render(true);
  assert.equal(evaluate('document.querySelector("#viewer svg").dataset.renderer'), 'native');
  assert.equal(evaluate('document.querySelector("#png").disabled'), true);
  checks.push('Pasted Markdown also works with Original Mermaid layout and tilde fences.');

  const sequence = '---\ntitle: Second pasted diagram\n---\nsequenceDiagram\n User->>Service: Request\n Service-->>User: Response';
  const first = flow.replace('Pasted flow', 'First pasted diagram');
  paste(`# Multiple diagrams\n\n${fence(first)}\n\nExplanatory prose.\n\n${fence(sequence)}`);
  render();
  let saved = workspace();
  assert.deepEqual(saved.tabs.map(tab => tab.title), ['First pasted diagram', 'Second pasted diagram']);
  assert.equal(saved.activeId, saved.tabs[0].id);
  assert.equal(saved.tabs[0].source, first);
  assert.equal(saved.tabs[1].source, sequence);
  const firstId = saved.tabs[0].id;
  const secondId = saved.tabs[1].id;
  browser('click', `button[data-tab-id="${secondId}"]`);
  wait('document.title.startsWith("Second pasted diagram") && !document.querySelector("#svg").disabled');
  assert.equal(evaluate('document.querySelector("#viewer svg").dataset.renderer'), 'native');
  browser('click', `button[data-tab-id="${firstId}"]`);
  wait('document.title.startsWith("First pasted diagram") && !document.querySelector("#svg").disabled');
  browser('click', '#edit');
  assert.equal(evaluate('document.querySelector("#source").value'), first);
  render();
  assert.equal(workspace().tabs.length, 2);
  browser('reload');
  wait('document.title.startsWith("First pasted diagram") && !document.querySelector("#svg").disabled');
  assert.equal(workspace().tabs.length, 2);
  browser('screenshot', join(output, 'multiple-pasted-diagrams.png'));
  checks.push('Multiple pasted fences preserve every diagram, persist independently, and do not duplicate on resubmission.');

  saved = workspace();
  paste(`${fence(flow)}\n\n${fence('flowchart TB\n A["Unclosed')}`);
  browser('click', '#source-form .primary');
  wait('!document.querySelector("#source-error").hidden');
  assert.match(evaluate('document.querySelector("#source-error").textContent'), /Mermaid block 2/);
  assert.deepEqual(workspace(), saved);
  assert.equal(evaluate('document.querySelectorAll("#viewer .node").length'), 2);
  assert.equal(evaluate('document.querySelector("#svg").disabled'), true);
  browser('click', '#cancel');
  wait('document.querySelector("#error").hidden && !document.querySelector("#svg").disabled');
  checks.push('A bad later fence keeps the previous diagram and tabs intact; Cancel restores exports.');

  const { errors } = browser('errors');
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'checks.json'), `${JSON.stringify({ checks, browserErrors: errors }, null, 2)}\n`);
  checks.forEach(check => console.log(`PASS ${check}`));
} catch (error) {
  browser('screenshot', join(output, 'paste-failure.png'));
  throw error;
} finally {
  browser('close');
}
console.log(`Paste verification saved to ${output}`);
