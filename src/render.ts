import type { Box, DiagramLayout, Paint, Point, PositionedNode } from './model.ts';
import { edgeDescription } from './layout.ts';
import { nodePolygon } from './geometry.ts';
import { EDGE_FONT_SIZE, EDGE_LINE_HEIGHT, NODE_FONT_SIZE, NODE_LINE_HEIGHT } from './text.ts';
import { curveData } from './curves.ts';

const SVG = 'http://www.w3.org/2000/svg';

export type Selection = { kind: 'node' | 'group' | 'edge'; id: string } | undefined;

function element<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, string | number> = {}, text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function rectangle(box: Box, attributes: Record<string, string | number> = {}): SVGRectElement {
  return element('rect', { x: box.x, y: box.y, width: box.width, height: box.height, ...attributes });
}

function interactive(node: SVGElement, label: string, select: () => void): void {
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', label);
  node.addEventListener('click', event => { event.stopPropagation(); select(); });
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(); }
  });
}

function paintAttributes(paint: Paint, defaults: { fill: string; stroke: string }): Record<string, string | number> {
  return {
    fill: paint.fill ?? defaults.fill, stroke: paint.stroke ?? defaults.stroke,
    'stroke-width': paint.strokeWidth ?? 1,
    ...(paint.dash ? { 'stroke-dasharray': paint.dash } : {}),
  };
}

function nodeShape(node: PositionedNode, paint: Record<string, string | number>): SVGElement[] {
  const { x, y, width: w, height: h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const polygon = nodePolygon(node.node.shape, node);
  if (polygon) return [element('polygon', {
    points: polygon.map(point => `${point.x},${point.y}`).join(' '), 'stroke-linejoin': 'round', ...paint,
  })];
  switch (node.node.shape) {
    case 'circle':
    case 'doublecircle':
    case 'ellipse': {
      const shape = element('ellipse', { cx, cy, rx: w / 2, ry: h / 2, ...paint });
      return node.node.shape === 'doublecircle'
        ? [shape, element('ellipse', { cx, cy, rx: w / 2 - 5, ry: h / 2 - 5, ...paint, fill: 'none' })] : [shape];
    }
    case 'cylinder':
      return [
        element('path', { d: `M ${x} ${y + 8} a ${w / 2} 8 0 0 1 ${w} 0 v ${h - 16} a ${w / 2} 8 0 0 1 ${-w} 0 Z`, ...paint }),
        element('ellipse', { cx, cy: y + 8, rx: w / 2, ry: 8, ...paint }),
      ];
    case 'subroutine':
      return [
        rectangle(node, { ...paint }),
        element('path', { d: `M ${x + 8} ${y} V ${y + h} M ${x + w - 8} ${y} V ${y + h}`, ...paint, fill: 'none' }),
      ];
    default:
      return [rectangle(node, { rx: node.node.shape === 'stadium' ? h / 2 : node.node.shape === 'round' ? 7 : 1, ...paint })];
  }
}

function pathData(points: Point[]): string {
  if (!points.length) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const point = points[i];
    const next = points[i + 1];
    const before = Math.hypot(point.x - previous.x, point.y - previous.y);
    const after = Math.hypot(next.x - point.x, next.y - point.y);
    const radius = Math.min(4, before / 2, after / 2);
    if (!radius) continue;
    const a = { x: point.x + (previous.x - point.x) / before * radius, y: point.y + (previous.y - point.y) / before * radius };
    const b = { x: point.x + (next.x - point.x) / after * radius, y: point.y + (next.y - point.y) / after * radius };
    path += ` L ${a.x} ${a.y} Q ${point.x} ${point.y} ${b.x} ${b.y}`;
  }
  const end = points.at(-1)!;
  return `${path} L ${end.x} ${end.y}`;
}

let renderId = 0;
export function renderDiagram(layout: DiagramLayout, select: (selection: Selection) => void): SVGSVGElement {
  const prefix = `graph-${++renderId}`;
  const paper = layout.graph.background;
  const svg = element('svg', {
    xmlns: SVG, width: layout.width, height: layout.height,
    viewBox: `0 0 ${layout.width} ${layout.height}`, role: 'group',
    'aria-label': layout.graph.title, 'data-renderer': 'structured',
    'data-layout': layout.sections.length > 1 ? 'regions' : 'compact',
    'data-node-count': layout.graph.nodes.length, 'data-edge-count': layout.graph.edges.length,
  });
  svg.append(element('title', {}, layout.graph.title));
  const guidance = layout.sections.length > 1 ? `${layout.sections.length} reading regions. Region numbers suggest a reading order, not execution timing.` : 'Compact connected layout.';
  svg.append(element('desc', {}, `${layout.graph.description}\n${guidance} Every node, declared boundary, and visible connection is drawn. Select a node or arrow to trace its connections. No steps are collapsed.`));
  const defs = element('defs');
  defs.append(element('style', {}, `
    text { font-family: Arial, sans-serif; fill: #192a26; }
    .node-label, .node-detail { font-size: ${NODE_FONT_SIZE}px; font-weight: 400; }
    .group-label { font-size: 16px; fill: #283931; paint-order: stroke; stroke-width: 4px; stroke-linejoin: round; }
    .section-title { font-size: 13px; fill: #667771; }
    .edge-label { font-size: ${EDGE_FONT_SIZE}px; fill: #354b43; }
    [role="button"] { cursor: pointer; outline: none; }
    .node:focus > .node-outline, .node:hover > .node-outline { stroke: #287d80; stroke-width: 2; }
    .is-dimmed { opacity: .28; }
    .node.is-selected > .node-outline { stroke: #247f83; stroke-width: 2; }
    .edge.is-selected > .edge-line { stroke: #247f83; stroke-width: 2; opacity: 1; }
    .group.is-selected > rect { stroke: #247f83; stroke-width: 2; }
  `));
  for (const marker of ['arrow', 'circle', 'cross']) {
    const mark = element('marker', {
      id: `${prefix}-${marker}`, markerWidth: marker === 'cross' ? 9 : 7, markerHeight: marker === 'cross' ? 9 : 7,
      refX: marker === 'cross' ? 9 : marker === 'circle' ? 7 : 6.5, refY: marker === 'cross' ? 4.5 : 3.5,
      orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse', viewBox: marker === 'cross' ? '0 0 9 9' : '0 0 7 7',
    });
    if (marker === 'arrow') mark.append(element('path', { d: 'M 0 0 L 7 3.5 L 0 7 Z', fill: 'context-stroke' }));
    if (marker === 'circle') mark.append(element('circle', { cx: 3.5, cy: 3.5, r: 2.8, fill: 'context-stroke', stroke: 'context-stroke', 'stroke-width': 1.2 }));
    if (marker === 'cross') mark.append(element('path', { d: 'M 1 1 L 8 8 M 8 1 L 1 8', stroke: 'context-stroke', 'stroke-width': 1.4 }));
    defs.append(mark);
  }
  svg.append(defs, rectangle({ x: 0, y: 0, width: layout.width, height: layout.height }, { fill: paper }));
  layout.titleLines.forEach((line, index) => svg.append(element('text', {
    x: layout.width / 2, y: 28 + index * 24, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 500,
  }, line)));
  const captions = element('g', { 'pointer-events': 'none', 'aria-hidden': 'true' });

  for (const region of layout.sections) {
    const declared = layout.groups.find(group => group.sectionId === region.section.id && group.depth === -1);
    const group = element('g', { class: 'section', 'data-section': region.section.id });
    if (declared) group.append(rectangle(region, {
      rx: 9, 'stroke-dasharray': '6 6',
      ...paintAttributes(declared.group.paint, { fill: 'none', stroke: '#adbcb0' }),
    }));
    const guided = layout.sections.length > 1;
    if (guided) group.append(element('text', { x: region.x + 12, y: region.y + 25, 'font-size': 11, fill: '#667771' }, String(region.section.index + 1).padStart(2, '0')));
    region.lines.forEach((line, index) => group.append(element('text', {
      x: region.x + (guided ? 37 : 12), y: region.y + 25 + index * (guided ? 17 : 19),
      class: guided ? 'section-title' : 'group-label',
      ...(!guided && declared?.group.paint.color ? { style: `fill:${declared.group.paint.color}` } : {}),
    }, line)));
    if (declared) {
      group.dataset.entity = declared.group.id;
      group.classList.add('group');
      interactive(group, `Subgraph: ${declared.group.label}`, () => select({ kind: 'group', id: declared.group.id }));
    }
    svg.append(group);
  }

  for (const box of [...layout.groups].sort((a, b) => a.depth - b.depth)) {
    if (box.depth === -1) continue;
    const group = element('g', { class: 'group', 'data-entity': box.group.id, 'data-section': box.sectionId });
    const paint = paintAttributes(box.group.paint, { fill: 'none', stroke: '#aeb9ae' });
    group.append(rectangle(box, { rx: 9, 'stroke-dasharray': '6 6', ...paint }));
    if (box.caption) captions.append(rectangle(box.caption, { fill: paint.fill === 'none' ? paper : paint.fill }));
    box.lines.forEach((line, index) => captions.append(element('text', {
      x: box.caption ? box.caption.x + 2 : box.x + 10, y: box.y + 24 + index * 19, class: 'group-label',
      style: `stroke:${paint.fill === 'none' ? paper : paint.fill};${box.group.paint.color ? `fill:${box.group.paint.color}` : ''}`,
    }, line)));
    group.append(element('title', {}, `Declared subgraph: ${box.group.label}`));
    interactive(group, `Subgraph: ${box.group.label}`, () => select({ kind: 'group', id: box.group.id }));
    svg.append(group);
  }

  const labels = element('g', { class: 'edge-labels', 'pointer-events': 'none' });
  const orderedEdges = [...layout.edges].sort((a, b) => Number(b.edge.stroke === 'dotted') - Number(a.edge.stroke === 'dotted'));
  for (const line of orderedEdges) {
    const edge = line.edge;
    if (edge.stroke === 'invisible') continue;
    const group = element('g', {
      class: 'edge', 'data-edge': edge.id, 'data-source': edge.source, 'data-target': edge.target,
      'data-cross-section': String(Boolean(line.crossSection)),
    });
    const paths = line.curves?.map(curveData) ?? line.paths.map(pathData);
    for (const [index, path] of paths.entries()) {
      const attributes: Record<string, string | number> = {
        d: path, fill: 'none',
        stroke: edge.paint.stroke ?? (edge.stroke === 'dotted' ? '#81938b' : '#4c6258'),
        'stroke-width': edge.paint.strokeWidth ?? (edge.stroke === 'thick' ? 3 : 1.3),
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'edge-line',
      };
      if (edge.paint.dash || edge.stroke === 'dotted') attributes['stroke-dasharray'] = edge.paint.dash ?? '2 5';
      if (edge.startMarker !== 'none' && index === 0) attributes['marker-start'] = `url(#${prefix}-${edge.startMarker})`;
      if (edge.endMarker !== 'none' && index === paths.length - 1) attributes['marker-end'] = `url(#${prefix}-${edge.endMarker})`;
      if (!line.curves) group.append(element('path', { d: attributes.d, fill: 'none', stroke: paper, 'stroke-width': (Number(attributes['stroke-width']) + 3), 'stroke-linejoin': 'round' }));
      group.append(element('path', attributes));
      group.append(element('path', { d: attributes.d, fill: 'none', stroke: 'transparent', 'stroke-width': 12 }));
    }
    if (line.label) {
      const label = line.label;
      const caption = element('g', { 'data-label-for': edge.id });
      caption.append(rectangle(label, { rx: 2, fill: paper, 'fill-opacity': 0.97 }));
      label.lines.forEach((text, index) => caption.append(element('text', {
        x: label.x + label.width / 2, y: label.y + EDGE_FONT_SIZE + 2 + index * EDGE_LINE_HEIGHT, 'text-anchor': 'middle', class: 'edge-label',
        ...(edge.paint.color ? { style: `fill:${edge.paint.color}` } : {}),
      }, text)));
      labels.append(caption);
    }
    const description = edgeDescription(edge, layout.graph);
    group.append(element('title', {}, description));
    interactive(group, description, () => select({ kind: 'edge', id: edge.id }));
    svg.append(group);
  }
  svg.append(captions);

  for (const box of layout.nodes) {
    const group = element(box.node.link ? 'a' : 'g', {
      class: 'node', 'data-entity': box.node.id, 'data-section': box.sectionId,
      ...(box.node.link ? {
        href: box.node.link, target: '_blank', rel: 'noopener noreferrer',
        'aria-label': box.node.label || box.node.id,
      } : {}),
    });
    const paint = paintAttributes(box.node.paint, {
      fill: box.node.shape === 'diamond' ? '#fff7d5' : '#fffdf7',
      stroke: '#34473c',
    });
    const shapes = nodeShape(box, paint);
    shapes[0].classList.add('node-outline');
    group.append(...shapes);
    const textHeight = box.lines.length * NODE_LINE_HEIGHT;
    let baseline = box.y + (box.height - textHeight) / 2 + NODE_FONT_SIZE;
    if (box.node.shape === 'cylinder') baseline += 3;
    for (const line of box.lines) {
      group.append(element('text', {
        x: box.x + box.width / 2, y: baseline, 'text-anchor': 'middle',
        class: line.secondary ? 'node-detail' : 'node-label',
        ...(box.node.paint.color ? { style: `fill:${box.node.paint.color}` } : {}),
      }, line.text));
      baseline += NODE_LINE_HEIGHT;
    }
    group.append(element('title', {}, box.node.label || box.node.id));
    if (!box.node.link) interactive(group, box.node.label || box.node.id, () => select({ kind: 'node', id: box.node.id }));
    svg.append(group);
  }
  svg.append(labels);
  return svg;
}

export function highlightSelection(svg: SVGSVGElement, layout: DiagramLayout, selection: Selection): void {
  const entities = new Set<string>();
  const edges = new Set<string>();
  if (selection?.kind === 'edge') {
    const edge = layout.graph.edges.find(edge => edge.id === selection.id);
    if (edge) { entities.add(edge.source); entities.add(edge.target); edges.add(edge.id); }
  } else if (selection) {
    entities.add(selection.id);
    if (selection.kind === 'group') {
      let grew = true;
      while (grew) {
        grew = false;
        for (const entity of [...layout.graph.nodes, ...layout.graph.groups]) {
          if (entity.parent && entities.has(entity.parent) && !entities.has(entity.id)) {
            entities.add(entity.id); grew = true;
          }
        }
      }
    }
    for (const edge of layout.graph.edges) {
      if (entities.has(edge.source) || entities.has(edge.target)) edges.add(edge.id);
    }
    for (const edge of layout.graph.edges.filter(edge => edges.has(edge.id))) {
      entities.add(edge.source); entities.add(edge.target);
    }
  }
  for (const node of svg.querySelectorAll<SVGElement>('.node, .edge, [data-label-for]')) {
    const active = node.dataset.entity ? entities.has(node.dataset.entity) : edges.has(node.dataset.edge ?? node.dataset.labelFor ?? '');
    node.classList.toggle('is-dimmed', Boolean(selection) && !active);
    node.classList.toggle('is-selected', Boolean(selection) && active);
  }
  for (const group of svg.querySelectorAll<SVGElement>('.group')) {
    group.classList.toggle('is-selected', selection?.kind === 'group' && group.dataset.entity === selection.id);
  }
}
