import ELK from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { parseSource, renderNative } from '../src/parser.ts';
import { layoutGraph } from '../src/layout.ts';
import { renderDiagram } from '../src/render.ts';
import { browserMeasure } from '../src/text.ts';
import { renderingCases } from './fixtures/rendering-cases.ts';

interface PanelMetrics {
  width: number;
  height: number;
  fittedFont: number;
  nodes: number;
  edges: number;
  layout?: string;
}

interface Comparison {
  id: string;
  native?: PanelMetrics;
  studio?: PanelMetrics;
  error?: string;
}

declare global {
  interface Window {
    renderComparisons: (ids: string[]) => Promise<Comparison[]>;
    comparisonResults: Comparison[];
  }
}

const engine = new ELK({ workerFactory: () => new Worker(workerUrl) });
const measure = browserMeasure();
const main = document.querySelector<HTMLElement>('#comparisons')!;
const mount = document.querySelector<HTMLElement>('#mount')!;

function panel(parent: HTMLElement, name: string, svg: SVGSVGElement): PanelMetrics {
  const container = document.createElement('div');
  container.className = 'panel';
  const caption = document.createElement('div');
  caption.className = 'caption';
  const drawing = document.createElement('div');
  drawing.className = 'drawing';
  drawing.append(svg);
  container.append(caption, drawing);
  parent.append(container);
  const { x, y, width, height } = svg.viewBox.baseVal;
  const scale = Math.min((drawing.clientWidth - 24) / width, (drawing.clientHeight - 24) / height, 1.3);
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  svg.style.left = `${(drawing.clientWidth - width * scale) / 2}px`;
  svg.style.top = `${(drawing.clientHeight - height * scale) / 2}px`;
  svg.style.transform = `scale(${scale})`;
  svg.style.backgroundColor ||= '#fff';
  const label = svg.querySelector('.node-label, .nodeLabel, .messageText') ?? svg.querySelector('text');
  const font = label ? Number.parseFloat(getComputedStyle(label).fontSize) : 16;
  const metrics = {
    width: Math.round(width), height: Math.round(height), fittedFont: Math.round(font * scale * 10) / 10,
    nodes: svg.querySelectorAll('.node').length,
    edges: svg.querySelectorAll('.edge, .flowchart-link').length,
    layout: svg.dataset.layout,
  };
  caption.textContent = `${name} | ${metrics.width} x ${metrics.height} | fitted label ${metrics.fittedFont}px`;
  svg.dataset.originalViewBox = `${x} ${y} ${width} ${height}`;
  return metrics;
}

window.renderComparisons = async ids => {
  main.replaceChildren();
  const results: Comparison[] = [];
  for (const id of ids) {
    const example = renderingCases.find(item => item.id === id);
    if (!example) throw new Error(`Unknown comparison case: ${id}`);
    const article = document.createElement('article');
    const heading = document.createElement('h2');
    heading.textContent = id;
    const pair = document.createElement('div');
    pair.className = 'pair';
    article.append(heading, pair);
    main.append(article);
    const result: Comparison = { id };
    try {
      const markup = await renderNative(example.source, mount);
      const template = document.createElement('template');
      template.innerHTML = markup;
      const native = template.content.querySelector('svg')!;
      const graph = await parseSource(example.source);
      native.style.backgroundColor = graph.background;
      result.native = panel(pair, 'Standard Mermaid', native);
      const studio = graph.kind === 'flowchart'
        ? renderDiagram(await layoutGraph(graph, engine, {
          automatic: true, detail: true, measure, aspectRatio: (pair.clientWidth / 2 - 24) / 366,
        }), () => {})
        : native.cloneNode(true) as SVGSVGElement;
      result.studio = panel(pair, graph.kind === 'flowchart' ? 'Mermaid Studio' : 'Mermaid Studio (native)', studio);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      const failure = document.createElement('div');
      failure.className = 'panel failure';
      failure.textContent = result.error;
      pair.append(failure);
    }
    results.push(result);
  }
  window.comparisonResults = results;
  return results;
};

window.addEventListener('pagehide', () => engine.terminateWorker());
const selected = new URLSearchParams(location.search).get('case');
await window.renderComparisons(selected ? selected.split(',') : ['branch-tb', 'checkout']);
