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
import { diagramSources, MAX_IMPORT_BYTES } from './import.ts';
import {
  activateTab, activeTab, addTab, addTabs, closeTab, createWorkspace, decodeWorkspace, encodeWorkspace,
  oppositeTheme, resolveTheme, updateTab,
} from './workspace.ts';
import type { DiagramTab, Theme, Workspace } from './workspace.ts';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="topbar">
    <div id="tab-strip">
      <div id="tabs" role="tablist" aria-label="Open diagrams"></div>
      <button id="new-tab" aria-label="New diagram" title="New diagram">+</button>
    </div>
    <div id="tools" role="toolbar" aria-label="Graph controls">
      <button id="edit">Source</button><button id="open" title="Open a Mermaid or Markdown file">Open</button><span class="divider"></span>
      <button id="svg" disabled>SVG</button><button id="png" disabled>PNG</button><span class="divider"></span>
      <button id="zoom-out" aria-label="Zoom out">&minus;</button><span id="zoom">100%</span><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit</button><span class="divider"></span>
      <button id="theme">Dark</button>
    </div>
  </div>
  <div id="viewer" tabindex="0" role="tabpanel" aria-label="Diagram. Drag to pan, Control or Command plus scroll to zoom. Select a node or arrow to trace it."></div>
  <footer id="version" aria-label="Application version">Version <time id="build-date"></time></footer>
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
  <input id="file" type="file" accept=".mmd,.mermaid,.md,.markdown,.mdown,.txt" hidden />
  <div id="native-mount" aria-hidden="true"></div>
`;

function get<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const item = document.getElementById(id);
  if (!item || item.tagName.toLowerCase() !== tag) throw new Error(`Missing ${tag}#${id}`);
  return item as HTMLElementTagNameMap[K];
}

const builtAt = import.meta.env.VITE_BUILD_DATE;
if (builtAt) {
  const date = get('build-date', 'time');
  date.dateTime = builtAt;
  date.textContent = `${builtAt.slice(0, 19).replace('T', ' ')} UTC`;
  date.title = `Production build: ${builtAt}`;
} else {
  get('version', 'footer').textContent = 'Development build';
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
const tabs = get('tabs', 'div');
const themeButton = get('theme', 'button');
let engine: InstanceType<typeof ELK> | undefined;
const measure = browserMeasure();
const viewport = new Viewport(viewer, scale => { get('zoom', 'span').textContent = `${Math.round(scale * 100)}%`; });
const workspaceStorageKey = 'mermaid-studio-workspace-v1';
const legacyStorageKey = 'structured-mermaid-source';
const themeStorageKey = 'mermaid-studio-theme';
const newDiagramSource = 'flowchart LR\n  A[Start] --> B[Finish]\n';
let title = 'Diagram';
let svg: SVGSVGElement | undefined;
let layout: DiagramLayout | undefined;
let selected: Selection;
let revision = 0;
let renderedRevision = -1;
let running = false;
let cache: { tabId: string; source: string; automatic: boolean; aspectRatio: number; layout: DiagramLayout } | undefined;
let editAfterRender: string | undefined;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const notices = new Set<string>();
let storageAvailable = true;

function readStorage(key: string): string | null {
  if (!storageAvailable) return null;
  try {
    return localStorage.getItem(key);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    storageAvailable = false;
    notices.add('Browser storage is unavailable. Tabs and theme changes will last for this session only.');
    return null;
  }
}

let generatedId = 0;
function newTabId(): string {
  generatedId++;
  return typeof crypto.randomUUID === 'function'
    ? `diagram-${crypto.randomUUID()}`
    : `diagram-${Date.now().toString(36)}-${generatedId}`;
}

function loadWorkspace(): Workspace {
  const saved = readStorage(workspaceStorageKey);
  if (saved) {
    try {
      return decodeWorkspace(saved);
    } catch (error) {
      notices.add(`${message(error)} The previous single diagram was used instead.`);
    }
  }
  return createWorkspace(readStorage(legacyStorageKey) ?? examples[0].source, newTabId());
}

let workspace = loadWorkspace();
let pending = (() => {
  const item = activeTab(workspace);
  return { tabId: item.id, source: item.source, original: item.original, automatic: item.automatic };
})();
let persistedWorkspace: Workspace | undefined;
let displayedWorkspace: Workspace | undefined;
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const savedTheme = readStorage(themeStorageKey);
if (savedTheme !== null && savedTheme !== 'light' && savedTheme !== 'dark') {
  notices.add('The saved color theme was invalid, so the system preference was used.');
}
let followsSystemTheme = savedTheme !== 'light' && savedTheme !== 'dark';
let theme: Theme = resolveTheme(savedTheme, systemTheme.matches);
let liveStatus = 'Rendering diagram...';

function refreshStatus(): void {
  const text = [liveStatus, ...notices].filter(Boolean).join(' ');
  status.textContent = text;
  status.hidden = !text;
}

function notify(text: string): void {
  liveStatus = text;
  refreshStatus();
}

function writeStorage(key: string, value: string): void {
  if (!storageAvailable) return;
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    storageAvailable = false;
    notices.add('Browser storage is unavailable. Tabs and theme changes will last for this session only.');
    refreshStatus();
  }
}

function persistWorkspace(): void {
  if (!storageAvailable) { persistedWorkspace = undefined; return; }
  if (workspace === persistedWorkspace) return;
  writeStorage(workspaceStorageKey, encodeWorkspace(workspace));
  writeStorage(legacyStorageKey, activeTab(workspace).source);
  persistedWorkspace = storageAvailable ? workspace : undefined;
}

function applyTheme(next: Theme, persist = false): void {
  theme = next;
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? 'Light' : 'Dark';
  themeButton.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  themeButton.setAttribute('aria-label', themeButton.title);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#10171b' : '#f7f8fa');
  if (persist) {
    followsSystemTheme = false;
    writeStorage(themeStorageKey, theme);
  }
}

function tabLabel(item: DiagramTab, index: number): string {
  return item.title === 'Untitled diagram' ? `Diagram ${index + 1}` : item.title;
}

function renderTabs(): void {
  if (workspace === displayedWorkspace) return;
  const focusedId = document.activeElement instanceof HTMLButtonElement
    ? document.activeElement.dataset.tabId
    : undefined;
  tabs.replaceChildren(...workspace.tabs.map((item, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = `tab-item${item.id === workspace.activeId ? ' is-active' : ''}`;
    wrapper.setAttribute('role', 'presentation');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab';
    button.dataset.tabId = item.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(item.id === workspace.activeId));
    button.setAttribute('aria-controls', 'viewer');
    button.tabIndex = item.id === workspace.activeId ? 0 : -1;
    button.textContent = tabLabel(item, index);
    button.title = button.textContent;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.dataset.closeTab = item.id;
    close.disabled = workspace.tabs.length === 1;
    close.setAttribute('aria-label', `Close ${button.textContent}`);
    close.title = workspace.tabs.length === 1 ? 'At least one diagram must remain open' : `Close ${button.textContent}`;
    close.textContent = '\u00d7';
    wrapper.append(button, close);
    return wrapper;
  }));
  displayedWorkspace = workspace;
  if (focusedId) focusTab(focusedId);
}

function focusTab(id: string): void {
  requestAnimationFrame(() => {
    [...tabs.querySelectorAll<HTMLButtonElement>('[data-tab-id]')]
      .find(button => button.dataset.tabId === id)?.focus();
  });
}

function selectDiagramTab(id: string, focus = false): void {
  if (id === workspace.activeId) {
    if (focus) focusTab(id);
    return;
  }
  workspace = activateTab(workspace, id);
  renderTabs();
  persistWorkspace();
  const item = activeTab(workspace);
  request(item.source, item.original, item.automatic, item.id);
  if (focus) focusTab(id);
}

function addDiagramTab(sourceValue = newDiagramSource, edit = false): DiagramTab {
  const item: DiagramTab = {
    id: newTabId(),
    title: 'Untitled diagram',
    source: newDiagramSource,
    original: false,
    automatic: true,
  };
  workspace = addTab(workspace, item);
  renderTabs();
  persistWorkspace();
  if (edit) editAfterRender = item.id;
  request(sourceValue, false, true, item.id);
  return item;
}

function closeDiagramTab(id: string): void {
  const wasActive = id === workspace.activeId;
  if (editAfterRender === id) editAfterRender = undefined;
  if (cache?.tabId === id) cache = undefined;
  workspace = closeTab(workspace, id);
  renderTabs();
  persistWorkspace();
  if (wasActive) {
    const item = activeTab(workspace);
    request(item.source, item.original, item.automatic, item.id);
  }
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

function request(
  value: string,
  native = original.checked,
  infer = automatic.checked,
  tabId = workspace.activeId,
): void {
  pending = { tabId, source: value, original: native, automatic: infer };
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
    const aspectRatio = viewer.clientWidth / Math.max(1, viewer.clientHeight);
    const cached = cache?.source === input.source && cache.automatic === input.automatic
      && cache.aspectRatio === aspectRatio ? cache.layout : undefined;
    const graph = cached?.graph ?? await parseSource(input.source);
    if (token !== revision) return;
    let next: SVGSVGElement;
    let nextLayout: DiagramLayout | undefined;
    let native = input.original || graph.kind === 'native';
    let fallback = '';
    if (!native && graph.kind === 'flowchart') {
      try {
        nextLayout = cached;
        if (!nextLayout) {
          engine ??= new ELK({ workerFactory: () => new Worker(workerUrl) });
          nextLayout = await layoutGraph(graph, engine, { automatic: input.automatic, detail: true, measure, aspectRatio });
          if (token !== revision) return;
          cache = { tabId: input.tabId, source: input.source, automatic: input.automatic, aspectRatio, layout: nextLayout };
        }
      } catch (error) {
        if (token !== revision) return;
        native = true;
        fallback = `Structured layout could not keep this diagram clear: ${message(error)} Showing the original Mermaid layout instead.`;
      }
    }
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
      if (!nextLayout) throw new Error('No structured layout was produced.');
      next = renderDiagram(nextLayout, select);
    }
    if (token !== revision) return;
    svg = next;
    layout = nextLayout;
    selected = undefined;
    workspace = updateTab(workspace, input.tabId, {
      source: input.source,
      original: input.original,
      automatic: input.automatic,
      title: graph.title,
    });
    const tabIndex = workspace.tabs.findIndex(item => item.id === input.tabId);
    title = tabLabel(workspace.tabs[tabIndex], tabIndex);
    renderedRevision = token;
    document.title = `${title} - Mermaid Studio`;
    next.style.backgroundColor = graph.background;
    viewport.set(next);
    if (dialog.open) dialog.close();
    source.value = '';
    errorBox.hidden = true;
    errorBox.textContent = '';
    sourceError.hidden = true;
    sourceError.textContent = '';
    svgButton.disabled = false;
    pngButton.disabled = native;
    pngButton.title = native ? 'Use SVG export for native Mermaid diagrams.' : 'Export the complete diagram as PNG';
    renderTabs();
    persistWorkspace();
    notify(graph.kind === 'native' ? graph.reason : [fallback, ...graph.warnings].filter(Boolean).join(' '));
    if (editAfterRender === input.tabId) {
      editAfterRender = undefined;
      queueMicrotask(showSource);
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
  source.value = '';
  sourceError.hidden = true;
  errorBox.hidden = true;
  if (renderedRevision !== revision) {
    const item = activeTab(workspace);
    request(item.source, item.original, item.automatic, item.id);
  }
}

get('new-tab', 'button').addEventListener('click', () => { addDiagramTab(newDiagramSource, true); });
get('edit', 'button').addEventListener('click', showSource);
get('source-form', 'form').addEventListener('submit', event => { event.preventDefault(); request(source.value); });
get('cancel', 'button').addEventListener('click', cancelEdit);
dialog.addEventListener('cancel', event => { event.preventDefault(); cancelEdit(); });
themeButton.addEventListener('click', () => { applyTheme(oppositeTheme(theme), true); });
systemTheme.addEventListener('change', event => {
  if (followsSystemTheme) applyTheme(event.matches ? 'dark' : 'light');
});
tabs.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const close = event.target.closest<HTMLButtonElement>('[data-close-tab]');
  if (close?.dataset.closeTab) {
    closeDiagramTab(close.dataset.closeTab);
    return;
  }
  const tab = event.target.closest<HTMLButtonElement>('[data-tab-id]');
  if (tab?.dataset.tabId) selectDiagramTab(tab.dataset.tabId);
});
tabs.addEventListener('keydown', event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.tabId) return;
  const index = workspace.tabs.findIndex(item => item.id === target.dataset.tabId);
  let next = index;
  if (event.key === 'ArrowLeft') next = (index - 1 + workspace.tabs.length) % workspace.tabs.length;
  else if (event.key === 'ArrowRight') next = (index + 1) % workspace.tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = workspace.tabs.length - 1;
  else return;
  event.preventDefault();
  selectDiagramTab(workspace.tabs[next].id, true);
});
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
  const file = input.files[0];
  const open = get('open', 'button');
  open.disabled = true;
  notify('Opening diagrams...');
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Open a Mermaid or Markdown file smaller than 200 KB.');
    const values = diagramSources(await file.text(), file.name);
    const items: DiagramTab[] = [];
    for (const [index, value] of values.entries()) {
      try {
        const graph = await parseSource(value);
        items.push({
          id: newTabId(), title: graph.title, source: value, original: false, automatic: true,
        });
      } catch (error) {
        throw new Error(`Diagram ${index + 1} in "${file.name}": ${message(error)}`, { cause: error });
      }
    }
    const first = items[0];
    workspace = activateTab(addTabs(workspace, items), first.id);
    renderTabs();
    persistWorkspace();
    request(first.source, first.original, first.automatic, first.id);
  } catch (error) {
    errorBox.textContent = message(error); errorBox.hidden = false;
    notify('');
  } finally { input.value = ''; open.disabled = false; }
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
  if (!event.persisted) { viewport.destroy(); engine?.terminateWorker(); }
});
applyTheme(theme);
renderTabs();
refreshStatus();
request(pending.source, pending.original, pending.automatic, pending.tabId);
