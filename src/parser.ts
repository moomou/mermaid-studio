import mermaid from 'mermaid';
import { JSON_SCHEMA, load } from 'js-yaml';
import type { FlowDB } from 'mermaid/dist/diagrams/flowchart/flowDb.js';
import type { DiagramDB } from 'mermaid/dist/diagram-api/types.js';
import type { FlowClass } from 'mermaid/dist/diagrams/flowchart/types.js';
import type {
  DiagramGroup, Direction, FlowGraph, Marker, NativeDiagram, Paint, Shape,
} from './model.ts';

const config = {
  startOnLoad: false,
  securityLevel: 'strict' as const,
  suppressErrorRendering: true,
  maxTextSize: 50_000,
  maxEdges: 500,
  theme: 'base' as const,
  fontFamily: 'Arial, sans-serif',
  themeVariables: {
    primaryColor: '#f0f5f3',
    primaryTextColor: '#243d3a',
    primaryBorderColor: '#96aaa4',
    lineColor: '#788c87',
    secondaryColor: '#f7f3e7',
    tertiaryColor: '#f5f7fa',
    clusterBkg: '#f7f8fa',
    clusterBorder: '#bbc9c4',
  },
};

// Mermaid has a shared configuration/database. Serialize parsing and native rendering,
// and return an owned snapshot before the next operation can reset that database.
let queue: Promise<unknown> = Promise.resolve();
function withMermaid<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function isFlowDatabase(db: DiagramDB): db is FlowDB {
  return 'getVertices' in db && typeof db.getVertices === 'function'
    && 'getEdges' in db && typeof db.getEdges === 'function'
    && 'getSubGraphs' in db && typeof db.getSubGraphs === 'function'
    && 'getClasses' in db && typeof db.getClasses === 'function';
}

export function plainText(value: string, markdown = false): string {
  const template = document.createElement('template');
  template.innerHTML = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/#(\d+);/g, '&#$1;')
    .replace(/#([a-zA-Z]+);/g, '&$1;');
  let text = template.content.textContent ?? '';
  if (markdown) {
    text = text.replace(/\*\*(.*?)\*\*/gs, '$1').replace(/__(.*?)__/gs, '$1')
      .replace(/`([^`]+)`/g, '$1').replace(/\*([^*\n]+)\*/g, '$1');
  }
  return text.replace(/\r\n?/g, '\n').trim();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function metadataFromSource(source: string): { title?: string; background: string } {
  const frontmatter = source.trimStart().match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/);
  if (!frontmatter) return { background: '#fff' };
  const metadata: unknown = load(frontmatter[1], { schema: JSON_SCHEMA });
  if (!record(metadata)) return { background: '#fff' };
  const variables = record(metadata.config) && record(metadata.config.themeVariables) ? metadata.config.themeVariables : {};
  return {
    title: typeof metadata.title === 'string' ? plainText(metadata.title) : undefined,
    background: typeof variables.background === 'string' ? color(variables.background) ?? '#fff' : '#fff',
  };
}

function direction(value: string | undefined): Direction | undefined {
  if (value === 'TD') return 'TB';
  if (value === 'TB' || value === 'BT' || value === 'LR' || value === 'RL') return value;
  return undefined;
}

const shapes: Record<string, Shape> = {
  square: 'rect', rect: 'rect', rounded: 'round', round: 'round',
  stadium: 'stadium', pill: 'stadium', diamond: 'diamond', diam: 'diamond',
  decision: 'diamond', hexagon: 'hexagon', hex: 'hexagon', prepare: 'hexagon',
  circle: 'circle', doublecircle: 'doublecircle', 'double-circle': 'doublecircle',
  ellipse: 'ellipse', subroutine: 'subroutine', 'sub-process': 'subroutine',
  fr: 'subroutine', 'fr-rect': 'subroutine', cylinder: 'cylinder', cyl: 'cylinder',
  db: 'cylinder', database: 'cylinder', trapezoid: 'trapezoid', trap: 'trapezoid',
  'trap-b': 'trapezoid', inv_trapezoid: 'inv_trapezoid', 'trap-t': 'inv_trapezoid',
  lean_right: 'lean_right', 'lean-r': 'lean_right', 'in-out': 'lean_right',
  lean_left: 'lean_left', 'lean-l': 'lean_left', 'out-in': 'lean_left',
  odd: 'odd',
};

function color(value: string): string | undefined {
  if (/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%/+-]+\))$/i.test(value)) return value;
  return undefined;
}

export function readPaint(styles: string[]): Paint {
  const paint: Paint = {};
  for (const entry of styles) {
    const colon = entry.indexOf(':');
    if (colon < 0) continue;
    const key = entry.slice(0, colon).trim().toLowerCase();
    const value = entry.slice(colon + 1).replace(/\s*!important\s*$/, '').trim();
    if (key === 'fill' || key === 'stroke' || key === 'color') {
      const safe = color(value);
      if (safe) paint[key] = safe;
    } else if (key === 'stroke-width' && /^\d+(?:\.\d+)?(?:px)?$/.test(value)) {
      paint.strokeWidth = Math.min(12, Number.parseFloat(value));
    } else if (key === 'stroke-dasharray' && /^(?:\d+(?:\.\d+)?[ ,]*)+$/.test(value)) {
      paint.dash = value;
    }
  }
  return paint;
}

function stylesFor(classes: Map<string, FlowClass>, ids: string[], local: string[] = []): Paint {
  return readPaint([
    ...(classes.get('default')?.styles ?? []),
    ...ids.flatMap(id => classes.get(id)?.styles ?? []),
    ...local,
  ]);
}

function markers(type: string | undefined): { startMarker: Marker; endMarker: Marker } {
  let endMarker: Marker = 'none';
  if (type?.endsWith('_point')) endMarker = 'arrow';
  else if (type?.endsWith('_circle')) endMarker = 'circle';
  else if (type?.endsWith('_cross')) endMarker = 'cross';
  return { startMarker: type?.startsWith('double_') ? endMarker : 'none', endMarker };
}

export function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') return url.href;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  return undefined;
}

export function validateSource(source: string): void {
  if (!source.trim()) throw new Error('Add a Mermaid diagram to get started, for example: flowchart LR\\n  A --> B');
  if (source.length > config.maxTextSize) throw new Error('This diagram exceeds the 50,000-character limit. Split it into smaller diagrams.');
}

export async function parseSource(source: string): Promise<FlowGraph | NativeDiagram> {
  validateSource(source);
  return withMermaid(async () => {
    mermaid.initialize(config);
    const metadata = metadataFromSource(source);
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source, { title: metadata.title });
    const db = diagram.db;
    if (!diagram.type.startsWith('flowchart') || !isFlowDatabase(db)) {
      return {
        kind: 'native',
        title: plainText(db.getDiagramTitle?.() || db.getAccTitle?.() || 'Untitled diagram'),
        background: metadata.background,
        diagramType: diagram.type,
        reason: 'Structured layout currently supports flowcharts. This diagram is rendered by Mermaid without changing its syntax.',
      };
    }

    const rawNodes = db.getVertices();
    const rawGroups = db.getSubGraphs();
    const rawEdges = db.getEdges();
    const classes = db.getClasses();
    const groupIds = new Set(rawGroups.map(group => group.id));
    const unsupported = [...rawNodes.values()].filter(node =>
      !groupIds.has(node.id) && (node.img || node.icon || (node.type && !shapes[node.type])));
    if (unsupported.length || rawEdges.some(edge => edge.animate || edge.animation)) {
      return {
        kind: 'native',
        title: plainText(db.getDiagramTitle() || db.getAccTitle() || 'Untitled diagram'),
        background: metadata.background,
        diagramType: diagram.type,
        reason: unsupported.length
          ? 'This flowchart uses a shape, image, or icon not yet supported by structured layout. Mermaid renders it faithfully instead.'
          : 'Animated edges use native Mermaid rendering.',
      };
    }
    const nodeCount = [...rawNodes.keys()].filter(id => !groupIds.has(id)).length;
    if (nodeCount + rawGroups.length > 200) {
      throw new Error('Structured layout is limited to 200 nodes and groups to keep the browser responsive. Split this diagram into smaller views.');
    }

    const parentOf = new Map<string, string>();
    for (const group of rawGroups) {
      for (const child of group.nodes) {
        if (child === group.id) throw new Error(`Subgraph "${group.id}" cannot contain itself.`);
        parentOf.set(child, group.id);
      }
    }
    for (const id of parentOf.keys()) {
      const seen = new Set([id]);
      let parent = parentOf.get(id);
      while (parent) {
        if (seen.has(parent)) throw new Error('Subgraph containment contains a cycle.');
        seen.add(parent);
        parent = parentOf.get(parent);
      }
    }
    const groups: DiagramGroup[] = rawGroups.map(group => ({
      id: group.id,
      label: plainText(group.title, group.labelType === 'markdown'),
      parent: parentOf.get(group.id),
      direction: direction(group.dir),
      paint: stylesFor(classes, group.classes, rawNodes.get(group.id)?.styles),
    }));
    const nodes = [...rawNodes.values()].filter(node => !groupIds.has(node.id)).map(node => ({
      id: node.id,
      label: plainText(node.text ?? node.id, node.labelType === 'markdown'),
      shape: shapes[node.type ?? 'rect'],
      parent: parentOf.get(node.id),
      paint: stylesFor(classes, node.classes, node.styles),
      link: safeLink(node.link),
    }));
    const knownIds = new Set([...nodes.map(node => node.id), ...groupIds]);
    const warnings: string[] = [];
    if ([...rawNodes.values()].some(node => node.haveCallback)) {
      warnings.push('JavaScript click callbacks are disabled. Select a node to inspect its connections.');
    }
    return {
      kind: 'flowchart',
      title: plainText(db.getDiagramTitle() || db.getAccTitle() || 'Untitled diagram'),
      description: plainText(db.getAccDescription()),
      background: metadata.background,
      direction: direction(db.getDirection()) ?? 'TB',
      nodes,
      groups,
      edges: rawEdges.map((edge, index) => {
        if (!knownIds.has(edge.start) || !knownIds.has(edge.end)) {
          throw new Error(`Edge ${index + 1} refers to an unknown node or subgraph.`);
        }
        return {
          id: `edge-${index}`,
          source: edge.start,
          target: edge.end,
          label: plainText(edge.text, edge.labelType === 'markdown'),
          stroke: edge.stroke ?? 'normal',
          ...markers(edge.type),
          paint: stylesFor(classes, edge.classes, [...(rawEdges.defaultStyle ?? []), ...(edge.style ?? [])]),
          length: edge.length ?? 1,
        };
      }),
      warnings,
    };
  });
}

let nativeId = 0;
export async function renderNative(source: string, container: HTMLElement): Promise<string> {
  validateSource(source);
  return withMermaid(async () => {
    mermaid.initialize(config);
    const id = `meridian-native-${++nativeId}`;
    try {
      const result = await mermaid.render(id, source, container);
      return result.svg;
    } finally {
      container.replaceChildren();
    }
  });
}
