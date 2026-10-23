import './style.css';
import ELK from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { examples } from './examples.ts';
import { parseSource, renderNative } from './parser.ts';
import { layoutGraph } from './layout.ts';
import { highlightSelection, renderDiagram } from './render.ts';
import type { Selection } from './render.ts';
import type { DiagramLayout } from './model.ts';
import { browserMeasure } from './text.ts';
import { Viewport } from './viewport.ts';
import { download, exportSvg, filename, pngBlob } from './export.ts';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="viewer" tabindex="0" role="region" aria-label="Diagram. Drag to pan, Control or Command plus scroll to zoom. Select a node or arrow to trace it."></div>
  <div id="tools" role="toolbar" aria-label="Graph controls">
    <button id="edit">Source</button><button id="open">Open</button><span class="divider"></span>
    <button id="svg" disabled>SVG</button><button id="png" disabled>PNG</button><span class="divider"></span>
    <button id="zoom-out" aria-label="Zoom out">&minus;</button><span id="zoom">100%</span><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit</button>
  </div>
  <div id="status" role="status">Rendering diagram...</div>
  <div id="error" role="alert" hidden></div>
  <dialog id="source-dialog">
    <form id="source-form">
      <label for="source">Mermaid source</label>
      <textarea id="source" spellcheck="false" wrap="off" aria-label="Mermaid source"></textarea>
      <div class="source-options"><label><input id="original" type="checkbox" /> Original Mermaid layout</label><label><input id="automatic" type="checkbox" checked /> Infer regions</label></div>
      <pre id="source-error" hidden></pre>
      <div class="dialog-actions"><button type="button" id="save-source">Save .mmd</button><span></span><button type="button" id="cancel">Cancel</button><button type="submit" class="primary">Render</button></div>
    </form>
  </dialog>
  <input id="file" type="file" accept=".mmd,.mermaid,.txt" hidden />
  <div id="native-mount" aria-hidden="true"></div>
`;

function get<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const item = document.getElementById(id);
  if (!item || item.tagName.toLowerCase() !== tag) throw new Error(`Missing ${tag}#${id}`);
  return item as HTMLElementTagNameMap[K];
}

const source = get('source', 'textarea');
const dialog = get('source-dialog', 'dialog');
const original = get('original', 'input');
const automatic = get('automatic', 'input');
const viewer = get('viewer', 'div');
const status = get('status', 'div');
const errorBox = get('error', 'div');
const sourceError = get('source-error', 'pre');
const svgButton = get('svg', 'button');
const pngButton = get('png', 'button');
const engine = new ELK({ workerFactory: () => new Worker(workerUrl) });
const measure = browserMeasure();
const viewport = new Viewport(viewer, scale => { get('zoom', 'span').textContent = `${Math.round(scale * 100)}%`; });
const storageKey = 'structured-mermaid-source';
let activeSource = examples[0].source;
let activeOriginal = false;
let activeAutomatic = true;
let title = 'Diagram';
let svg: SVGSVGElement | undefined;
let layout: DiagramLayout | undefined;
let selected: Selection;
let revision = 0;
let renderedRevision = -1;
let running = false;
let pending = { source: activeSource, original: false, automatic: true };
let cache: { key: string; layout: DiagramLayout } | undefined;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(text: string): void {
  status.textContent = text;
  status.hidden = !text;
}

try {
  activeSource = localStorage.getItem(storageKey) ?? activeSource;
} catch (error) {
  if (!(error instanceof DOMException)) throw error;
  notify('Browser storage is unavailable. Use Save .mmd to keep your source.');
}

function select(selection: Selection): void {
  if (!svg || !layout || renderedRevision !== revision) return;
  selected = selected?.id === selection?.id && selected?.kind === selection?.kind ? undefined : selection;
  highlightSelection(svg, layout, selected);
}

function showSource(): void {
  source.value = pending.source;
  original.checked = pending.original;
  automatic.checked = pending.automatic;
  if (!dialog.open) dialog.showModal();
  source.focus();
}

function request(value: string, native = original.checked, infer = automatic.checked): void {
  pending = { source: value, original: native, automatic: infer };
  revision++;
  svgButton.disabled = true;
  pngButton.disabled = true;
  notify('Rendering diagram...');
  void render();
}

async function render(): Promise<void> {
  if (running) return;
  running = true;
  const token = revision;
  const input = pending;
  try {
    const graph = await parseSource(input.source);
    if (token !== revision) return;
    let next: SVGSVGElement;
    let nextLayout: DiagramLayout | undefined;
    const native = input.original || graph.kind === 'native';
    if (native) {
      const markup = await renderNative(input.source, get('native-mount', 'div'));
      if (token !== revision) return;
      const template = document.createElement('template');
      template.innerHTML = markup;
      const candidate = template.content.querySelector('svg');
      if (!candidate) throw new Error('Mermaid did not return a diagram.');
      next = candidate;
      next.dataset.renderer = 'native';
    } else {
      const key = JSON.stringify([input.source, input.automatic]);
      if (cache?.key !== key) {
        const positioned = await layoutGraph(graph, engine, { automatic: input.automatic, detail: true, measure });
        if (token !== revision) return;
        cache = { key, layout: positioned };
      }
      nextLayout = cache.layout;
      next = renderDiagram(nextLayout, select);
    }
    if (token !== revision) return;
    svg = next;
    layout = nextLayout;
    selected = undefined;
    activeSource = input.source;
    activeOriginal = input.original;
    activeAutomatic = input.automatic;
    title = graph.title;
    renderedRevision = token;
    document.title = `${title} - Mermaid viewer`;
    viewer.style.backgroundColor = graph.background;
    document.body.style.backgroundColor = graph.background;
    next.style.backgroundColor = graph.background;
    viewport.set(next);
    if (dialog.open) dialog.close();
    errorBox.hidden = true;
    sourceError.hidden = true;
    svgButton.disabled = false;
    pngButton.disabled = native;
    pngButton.title = native ? 'Use SVG export for native Mermaid diagrams.' : 'Export the complete diagram as PNG';
    notify(graph.kind === 'native' ? graph.reason : graph.warnings.join(' '));
    try { localStorage.setItem(storageKey, activeSource); }
    catch (error) {
      if (!(error instanceof DOMException)) throw error;
      notify('Browser storage is unavailable. Use Save .mmd to keep your source.');
    }
  } catch (error) {
    if (token !== revision) return;
    const detail = message(error);
    sourceError.textContent = detail;
    sourceError.hidden = false;
    errorBox.textContent = `${detail}${svg ? '\nThe previous diagram is still shown; exports are paused. Edit the source or cancel to restore it.' : ''}`;
    errorBox.hidden = false;
    notify('');
  } finally {
    running = false;
    if (token !== revision) void render();
  }
}

function cancelEdit(): void {
  if (dialog.open) dialog.close();
  sourceError.hidden = true;
  errorBox.hidden = true;
  if (renderedRevision !== revision) request(activeSource, activeOriginal, activeAutomatic);
}

get('edit', 'button').addEventListener('click', showSource);
get('source-form', 'form').addEventListener('submit', event => { event.preventDefault(); request(source.value); });
get('cancel', 'button').addEventListener('click', cancelEdit);
dialog.addEventListener('cancel', event => { event.preventDefault(); cancelEdit(); });
source.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault(); get('source-form', 'form').requestSubmit();
  } else if (event.key === 'Tab') {
    event.preventDefault(); source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
  }
});
get('open', 'button').addEventListener('click', () => get('file', 'input').click());
get('file', 'input').addEventListener('change', async event => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return;
  try {
    if (input.files[0].size > 200_000) throw new Error('Open a Mermaid source file smaller than 200 KB.');
    request(await input.files[0].text(), false, true);
  } catch (error) {
    errorBox.textContent = message(error); errorBox.hidden = false;
  } finally { input.value = ''; }
});
get('save-source', 'button').addEventListener('click', () => download(new Blob([source.value], { type: 'text/plain;charset=utf-8' }), 'diagram.mmd'));
get('fit', 'button').addEventListener('click', () => viewport.fit());
get('zoom-in', 'button').addEventListener('click', () => viewport.zoom(1.2));
get('zoom-out', 'button').addEventListener('click', () => viewport.zoom(1 / 1.2));
viewer.addEventListener('click', event => {
  if (!(event.target instanceof Element) || !event.target.closest('[data-entity], .edge')) select(undefined);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !dialog.open) select(undefined); });

svgButton.addEventListener('click', () => {
  if (!svg || renderedRevision !== revision) return;
  try {
    download(new Blob([exportSvg(svg)], { type: 'image/svg+xml;charset=utf-8' }), `${filename(title)}.svg`);
  } catch (error) { notify(`SVG export failed: ${message(error)}`); }
});
pngButton.addEventListener('click', async () => {
  if (!svg || renderedRevision !== revision) return;
  const picture = svg;
  const name = `${filename(title)}.png`;
  pngButton.disabled = true;
  try { download(await pngBlob(picture), name); }
  catch (error) { notify(`PNG export failed: ${message(error)}`); }
  finally { pngButton.disabled = renderedRevision !== revision || svg?.dataset.renderer === 'native'; }
});
window.addEventListener('pagehide', event => {
  if (!event.persisted) { viewport.destroy(); engine.terminateWorker(); }
});
request(activeSource, false, true);
