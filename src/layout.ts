import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api.js';
import type {
  Box, DiagramEdge, DiagramLayout, DiagramNode, Direction, FlowGraph,
  PositionedEdge, PositionedSection, Section, Structure, TextLine,
} from './model.ts';
import { buildStructure } from './structure.ts';
import { approximateMeasure, EDGE_FONT_SIZE, EDGE_LINE_HEIGHT, NODE_FONT_SIZE, NODE_LINE_HEIGHT, nodeLines, wrapText } from './text.ts';
import type { MeasureText } from './text.ts';
import { alignPorts, clipRoute } from './geometry.ts';
import { routeConnections } from './routing.ts';

export interface LayoutSettings {
  automatic: boolean;
  detail: boolean;
  measure?: MeasureText;
  strategy?: 'adaptive' | 'regions';
  aspectRatio?: number;
}

interface NodeSize {
  width: number;
  height: number;
  lines: TextLine[];
}

const directions: Record<Direction, string> = { TB: 'DOWN', BT: 'UP', LR: 'RIGHT', RL: 'LEFT' };
function measureNode(node: DiagramNode, detail: boolean, measure: MeasureText): NodeSize {
  const round = node.shape === 'circle' || node.shape === 'doublecircle' || node.shape === 'ellipse';
  const decision = node.shape === 'diamond' || node.shape === 'hexagon';
  const paragraphs = detail || decision ? node.label.split('\n') : [node.label.split('\n')[0]];
  const naturalWidth = Math.max(0, ...paragraphs.map(line => measure(line, NODE_FONT_SIZE)));
  let width = Math.min(260, Math.max(64, naturalWidth + 28));
  if (node.shape === 'diamond') width = Math.min(280, Math.max(96, naturalWidth * 1.7 + 32));
  if (node.shape === 'hexagon') width = Math.min(280, Math.max(96, naturalWidth + 48));
  if (round) width = Math.min(200, Math.max(56, naturalWidth + 36));
  const textWidth = node.shape === 'diamond' ? width * 0.55
    : node.shape === 'hexagon' ? width * 0.6 : round ? width * 0.72 : width - 28;
  const lines = nodeLines(node.label, textWidth, detail || decision, measure);
  if (decision) lines.forEach(line => { line.secondary = false; });
  const textHeight = lines.length * NODE_LINE_HEIGHT;
  let height = Math.max(40, textHeight + 20);
  if (node.shape === 'diamond') height = Math.max(64, textHeight * 2 + 20);
  if (node.shape === 'cylinder') height += 10;
  if (node.shape === 'circle' || node.shape === 'doublecircle') {
    width = Math.max(width, height);
    height = width;
  }
  return { width, height, lines };
}

function groupDepth(id: string, parents: Map<string, string | undefined>): number {
  let depth = 0;
  let parent = parents.get(id);
  while (parent) { depth++; parent = parents.get(parent); }
  return depth;
}

function number(value: number | undefined, context: string): number {
  if (value === undefined || !Number.isFinite(value)) throw new Error(`The layout engine returned an invalid ${context}.`);
  return value;
}

export async function layoutGraph(
  graph: FlowGraph,
  engine: Pick<ELK, 'layout'>,
  settings: LayoutSettings,
): Promise<DiagramLayout> {
  const structure = buildStructure(graph, settings.automatic);
  if (!structure.sections.length) throw new Error('Add at least one node to this flowchart.');
  if (settings.strategy === 'regions') return layoutSections(graph, engine, settings, structure);
  const aspectRatio = Math.max(0.25, Math.min(4, settings.aspectRatio ?? 1.6));
  const section: Section = {
    id: 'section-0', index: 0, label: '', inferred: false,
    nodeIds: graph.nodes.map(node => node.id), groupIds: graph.groups.map(group => group.id),
  };
  const compact: Structure = {
    sections: [section], crossLinks: [],
    sectionByEntity: new Map([...section.nodeIds, ...section.groupIds].map(id => [id, section.id])),
  };
  let connected: DiagramLayout | undefined;
  let failure: unknown;
  try {
    connected = await layoutSections(graph, engine, settings, compact);
  } catch (error) {
    failure = error;
  }
  if (structure.sections.length > 1) {
    try {
      const regions = await layoutSections(graph, engine, settings, structure);
      // Extra reading regions must earn their added headings and cross-region wires.
      if (!connected || layoutCost(regions, aspectRatio) < layoutCost(connected, aspectRatio) * 0.88) return regions;
    } catch (error) {
      if (!connected) throw error;
    }
  }
  if (!connected) throw failure;
  return connected;
}

function layoutCost(layout: DiagramLayout, aspectRatio: number): number {
  let length = 0;
  let bends = 0;
  const visible = layout.edges.filter(edge => edge.edge.stroke !== 'invisible');
  for (const edge of visible) for (const path of edge.paths) {
    bends += Math.max(0, path.length - 2);
    path.slice(1).forEach((point, index) => {
      length += Math.abs(point.x - path[index].x) + Math.abs(point.y - path[index].y);
    });
  }
  return Math.max(layout.width / aspectRatio, layout.height) + Math.sqrt(layout.width * layout.height) * 0.15
    + (length * 0.1 + bends * 8) / Math.max(1, visible.length);
}

async function layoutSections(
  graph: FlowGraph,
  engine: Pick<ELK, 'layout'>,
  settings: LayoutSettings,
  structure: Structure,
): Promise<DiagramLayout> {
  const measure = settings.measure ?? approximateMeasure;
  const guided = structure.sections.length > 1;
  const result: DiagramLayout = {
    graph, structure, nodes: [], groups: [], edges: [], sections: [], width: 0, height: 0, detail: settings.detail, titleLines: [],
  };
  const localLayouts: { section: Section; root: ElkNode; lifted?: string }[] = [];
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const groups = new Map(graph.groups.map(group => [group.id, group]));
  const edges = new Map(graph.edges.map(edge => [edge.id, edge]));
  const parents = new Map([...graph.nodes, ...graph.groups].map(entity => [entity.id, entity.parent]));
  const sizes = new Map<string, NodeSize>();
  const groupLines = new Map<string, string[]>();
  const edgeLines = new Map<string, string[]>();
  for (const node of graph.nodes) sizes.set(node.id, measureNode(node, settings.detail, measure));

  for (const section of structure.sections) {
    const topGroups = section.groupIds.filter(id => !groups.get(id)!.parent);
    const lifted = topGroups.length === 1
      && section.nodeIds.every(id => {
        let root = id;
        while (parents.get(root)) root = parents.get(root)!;
        return root === topGroups[0];
      }) ? topGroups[0] : undefined;
    const localDirection = (lifted && groups.get(lifted)?.direction) || graph.direction;
    const vertical = localDirection === 'TB' || localDirection === 'BT';
    const options: LayoutOptions = {
      'elk.algorithm': 'layered',
      'elk.direction': directions[localDirection],
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': '[top=8,left=12,bottom=12,right=12]',
      'elk.spacing.nodeNode': '22',
      'elk.layered.spacing.nodeNodeBetweenLayers': '24',
      'elk.layered.spacing.edgeNodeBetweenLayers': '8',
      'elk.spacing.edgeNode': '10',
      'elk.spacing.edgeEdge': '9',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.separateConnectedComponents': 'true',
    };
    const root: ElkNode = { id: `layout-${section.id}`, children: [], edges: [], layoutOptions: options };
    const elkEntities = new Map<string, ElkNode>();
    if (lifted) elkEntities.set(lifted, root);
    for (const id of section.groupIds) {
      if (id === lifted) continue;
      const group = groups.get(id)!;
      const lines = wrapText(group.label, 240, 16, measure);
      groupLines.set(id, lines);
      const headerHeight = 16 + lines.length * 19;
      const minimumWidth = Math.max(96, ...lines.map(line => measure(line, 16) + 24));
      const minimumHeight = headerHeight + 34;
      elkEntities.set(id, {
        id: `group:${id}`, children: [], edges: [],
        width: minimumWidth, height: minimumHeight,
        layoutOptions: {
          'elk.direction': directions[group.direction ?? graph.direction],
          'elk.padding': `[top=${headerHeight},left=12,bottom=12,right=12]`,
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          // Layered ELK transposes compound minimum sizes in vertical layouts.
          'elk.nodeSize.minimum': vertical ? `(${minimumHeight},${minimumWidth})` : `(${minimumWidth},${minimumHeight})`,
        },
      });
    }
    for (const id of section.nodeIds) {
      const size = sizes.get(id)!;
      elkEntities.set(id, { id: `node:${id}`, width: size.width, height: size.height });
    }
    for (const id of [...section.groupIds, ...section.nodeIds]) {
      if (id === lifted) continue;
      const parent = parents.get(id);
      const container = parent ? elkEntities.get(parent) : root;
      if (!container?.children) throw new Error(`Cannot place "${id}" inside its declared subgraph.`);
      container.children.push(elkEntities.get(id)!);
    }
    const localEdges = graph.edges.filter(edge =>
      structure.sectionByEntity.get(edge.source) === section.id
      && structure.sectionByEntity.get(edge.target) === section.id);
    for (const edge of localEdges) {
      const source = elkEntities.get(edge.source)!;
      const target = elkEntities.get(edge.target)!;
      const ancestorIds = (id: string): string[] => {
        const ancestors: string[] = [];
        let parent = parents.get(id);
        while (parent) { ancestors.push(parent); parent = parents.get(parent); }
        return ancestors;
      };
      const sourceAncestors = ancestorIds(edge.source);
      const targetAncestors = new Set(ancestorIds(edge.target));
      const common = sourceAncestors.find(id => targetAncestors.has(id));
      const container = common ? elkEntities.get(common)! : root;
      const lines = wrapText(edge.label, 160, EDGE_FONT_SIZE, measure);
      edgeLines.set(edge.id, lines);
      const elkEdge: ElkExtendedEdge = {
        id: edge.id,
        sources: [source.id], targets: [target.id],
        layoutOptions: {
          'elk.layered.priority.direction': edge.stroke === 'dotted' ? '0' : '10',
          'elk.layered.layering.minLength': String(Math.max(1, edge.length)),
        },
        labels: edge.label && edge.stroke !== 'invisible' ? [{
          text: edge.label,
          width: Math.max(...lines.map(line => measure(line, EDGE_FONT_SIZE))) + 10,
          height: lines.length * EDGE_LINE_HEIGHT + 6,
          layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' },
        }] : [],
      };
      container.edges!.push(elkEdge);
    }
    const laidOut = await engine.layout(root);
    localLayouts.push({ section, root: laidOut, lifted });
  }

  const horizontal = graph.direction === 'TB' || graph.direction === 'BT';
  const outerPadding = guided ? 36 : 16;
  const titled = graph.title !== 'Untitled diagram';
  const minimumWidth = guided ? 256 : titled ? Math.min(320, measure(graph.title, 20)) : 0;
  const sectionIndex = new Map(structure.sections.map((section, index) => [section.id, index]));
  const gaps = structure.sections.map((_, index) => {
    const crossing = structure.crossLinks.filter(link => {
      const a = sectionIndex.get(link.sourceSection)!;
      const b = sectionIndex.get(link.targetSection)!;
      return Math.min(a, b) <= index && Math.max(a, b) > index;
    }).length;
    return Math.max(64, 32 + crossing * 18);
  });
  const widths = localLayouts.map(local => Math.max(minimumWidth, number(local.root.width, 'section width')));
  const maxWidth = Math.max(...widths);
  const diagramWidth = (horizontal ? widths.reduce((a, b) => a + b, 0)
    + gaps.slice(0, -1).reduce((a, b) => a + b, 0) : maxWidth) + 2 * outerPadding;
  result.titleLines = titled ? wrapText(graph.title, diagramWidth - 32, 20, measure) : [];
  const titleHeight = result.titleLines.length ? 16 + result.titleLines.length * 24 : 0;
  let cursor = outerPadding + (horizontal ? 0 : titleHeight);
  const sectionTitles = localLayouts.map(({ section, lifted }, index) => guided
    ? wrapText(section.label, widths[index] - 54, 13, measure)
    : lifted ? wrapText(groups.get(lifted)!.label, widths[index] - 24, 16, measure) : []);
  const headerHeight = guided ? Math.max(42, ...sectionTitles.map(lines => 20 + lines.length * 17))
    : sectionTitles[0].length ? 16 + sectionTitles[0].length * 19 : 0;
  const maxHeight = Math.max(...localLayouts.map(local => number(local.root.height, 'section height')));
  const coordinateById = new Map<string, Box>();
  const pendingEdges: { edge: ElkExtendedEdge; origin: { x: number; y: number }; sectionId: string }[] = [];
  localLayouts.forEach(({ section, root, lifted }, index) => {
    const width = horizontal ? widths[index] : maxWidth;
    const height = number(root.height, 'section height') + headerHeight;
    const card: PositionedSection = {
      section, lines: sectionTitles[index], headerHeight,
      x: horizontal ? cursor : outerPadding,
      y: horizontal ? outerPadding + titleHeight : cursor,
      width, height,
    };
    result.sections.push(card);
    const contentX = card.x + (width - number(root.width, 'section width')) / 2;
    const contentY = card.y + headerHeight;
    const visit = (item: ElkNode, x: number, y: number) => {
      const box = {
        x, y, width: number(item.width, 'entity width'), height: number(item.height, 'entity height'),
      };
      coordinateById.set(item.id, box);
      if (item.id.startsWith('node:')) {
        const id = item.id.slice(5);
        result.nodes.push({ ...box, node: nodes.get(id)!, ...sizes.get(id)!, sectionId: section.id });
      } else if (item.id.startsWith('group:')) {
        const id = item.id.slice(6);
        result.groups.push({
          ...box, group: groups.get(id)!, sectionId: section.id,
          lines: groupLines.get(id)!, depth: groupDepth(id, parents),
        });
      }
      for (const edge of item.edges ?? []) pendingEdges.push({ edge, origin: { x, y }, sectionId: section.id });
      for (const child of item.children ?? []) visit(child, x + number(child.x, 'x coordinate'), y + number(child.y, 'y coordinate'));
    };
    visit(root, contentX, contentY);
    if (lifted) {
      result.groups.push({
        group: groups.get(lifted)!, ...card, sectionId: section.id, lines: [],
        depth: -1,
      });
    }
    cursor += (horizontal ? width : height) + gaps[index];
  });
  for (const { edge, origin, sectionId } of pendingEdges) {
    const offset = edge.container ? coordinateById.get(edge.container) : origin;
    if (!offset) throw new Error(`Cannot locate edge container "${edge.container}".`);
    const original = edges.get(edge.id)!;
    const paths = (edge.sections ?? []).map(part => alignPorts(
      [part.startPoint, ...(part.bendPoints ?? []), part.endPoint]
        .map(point => ({ x: point.x + offset.x, y: point.y + offset.y }))));
    const source = result.nodes.find(node => node.node.id === original.source);
    const target = result.nodes.find(node => node.node.id === original.target);
    if (paths.length) {
      if (source) clipRoute(paths[0], source, true);
      if (target) clipRoute(paths.at(-1)!, target, false);
    }
    if (!paths.length && original.stroke !== 'invisible') throw new Error(`No route was produced for "${original.source}" to "${original.target}".`);
    const positioned: PositionedEdge = { edge: original, paths, sectionId };
    const label = edge.labels?.[0];
    if (label) positioned.label = {
      x: offset.x + number(label.x, 'edge label x'), y: offset.y + number(label.y, 'edge label y'),
      width: number(label.width, 'edge label width'), height: number(label.height, 'edge label height'),
      lines: edgeLines.get(edge.id)!,
    };
    result.edges.push(positioned);
  }
  result.width = horizontal ? cursor - gaps.at(-1)! + outerPadding : maxWidth + 2 * outerPadding;
  result.height = horizontal ? titleHeight + maxHeight + headerHeight + 2 * outerPadding : cursor - gaps.at(-1)! + outerPadding;
  routeConnections(result, measure);
  assertComplete(result);
  return result;
}

function assertComplete(layout: DiagramLayout): void {
  const rendered = new Set(layout.nodes.map(node => node.node.id));
  if (rendered.size !== layout.graph.nodes.length || layout.nodes.length !== rendered.size) {
    throw new Error('Layout did not preserve every node exactly once.');
  }
  const visible = layout.graph.edges.filter(edge => edge.stroke !== 'invisible');
  const represented = layout.edges.filter(edge => edge.edge.stroke !== 'invisible').map(edge => edge.edge.id);
  if (new Set(represented).size !== visible.length || represented.length !== visible.length) {
    throw new Error('Layout did not preserve every visible connection exactly once.');
  }
  const overlaps = (a: Box, b: Box): boolean => a.x + 0.1 < b.x + b.width && b.x + 0.1 < a.x + a.width
    && a.y + 0.1 < b.y + b.height && b.y + 0.1 < a.y + a.height;
  for (const [index, node] of layout.nodes.entries()) {
    if (layout.nodes.slice(index + 1).some(other => overlaps(node, other))) {
      throw new Error('The layout engine placed overlapping nodes.');
    }
  }
  for (const route of layout.edges.filter(edge => edge.edge.stroke !== 'invisible')) {
    if (route.label && layout.nodes.some(node => overlaps(route.label!, node))) {
      throw new Error('The layout engine placed an edge label over a node.');
    }
    for (const path of route.paths) for (let index = 1; index < path.length; index++) {
      const a = path[index - 1];
      const b = path[index];
      for (const node of layout.nodes) {
        if (node.node.id === route.edge.source || node.node.id === route.edge.target) continue;
        const vertical = Math.abs(a.x - b.x) < 0.01;
        const enters = vertical
          ? a.x > node.x + 1 && a.x < node.x + node.width - 1
            && Math.max(a.y, b.y) > node.y + 1 && Math.min(a.y, b.y) < node.y + node.height - 1
          : a.y > node.y + 1 && a.y < node.y + node.height - 1
            && Math.max(a.x, b.x) > node.x + 1 && Math.min(a.x, b.x) < node.x + node.width - 1;
        if (enters) throw new Error('The layout engine routed a connection through another node.');
      }
    }
  }
}

export function edgeDescription(edge: DiagramEdge, graph: FlowGraph): string {
  const labels = new Map([...graph.nodes, ...graph.groups].map(entity => [entity.id, entity.label.split('\n')[0]]));
  const direction = edge.startMarker !== 'none' ? ' <-> ' : edge.endMarker !== 'none' ? ' -> ' : ' -- ';
  return `${labels.get(edge.source)}${direction}${labels.get(edge.target)}${edge.label ? `: ${edge.label}` : ''}`;
}
