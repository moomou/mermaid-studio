import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api.js';
import type {
  Box, DiagramEdge, DiagramLayout, DiagramNode, Direction, FlowGraph,
  PositionedEdge, PositionedSection, Section, TextLine,
} from './model.ts';
import { buildStructure } from './structure.ts';
import { approximateMeasure, nodeLines, wrapText } from './text.ts';
import type { MeasureText } from './text.ts';
import { alignPorts, clipRoute } from './geometry.ts';
import { routeConnections } from './routing.ts';

export interface LayoutSettings {
  automatic: boolean;
  detail: boolean;
  measure?: MeasureText;
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
  const naturalWidth = Math.max(0, ...paragraphs.map(line => measure(line, 12.5)));
  let width = Math.min(252, Math.max(84, naturalWidth + 32));
  if (node.shape === 'diamond') width = Math.min(276, Math.max(176, naturalWidth * 1.5 + 36));
  if (round) width = Math.min(190, Math.max(76, naturalWidth + 36));
  const textWidth = node.shape === 'diamond' ? width * 0.66 : round ? width * 0.72 : width - 32;
  const lines = nodeLines(node.label, textWidth, detail || decision, measure);
  if (decision) lines.forEach(line => { line.secondary = false; });
  const textHeight = lines.length * 14;
  let height = Math.max(38, textHeight + 16);
  if (node.shape === 'diamond') height = Math.max(76, textHeight * 1.8 + 16);
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
  const measure = settings.measure ?? approximateMeasure;
  const structure = buildStructure(graph, settings.automatic);
  if (!structure.sections.length) throw new Error('Add at least one node to this flowchart.');
  const result: DiagramLayout = {
    graph, structure, nodes: [], groups: [], edges: [], sections: [], width: 0, height: 0, detail: settings.detail,
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
    const options: LayoutOptions = {
      'elk.algorithm': 'layered',
      'elk.direction': directions[(lifted && groups.get(lifted)?.direction) || graph.direction],
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': '[top=8,left=12,bottom=12,right=12]',
      'elk.spacing.nodeNode': '22',
      'elk.layered.spacing.nodeNodeBetweenLayers': '18',
      'elk.layered.spacing.edgeNodeBetweenLayers': '8',
      'elk.spacing.edgeNode': '10',
      'elk.spacing.edgeEdge': '9',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
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
      const minimumWidth = Math.max(settings.detail ? 236 : 204, ...lines.map(line => measure(line, 16) + 24));
      elkEntities.set(id, {
        id: `group:${id}`, children: [], edges: [],
        width: minimumWidth, height: headerHeight + 34,
        layoutOptions: {
          'elk.direction': directions[group.direction ?? graph.direction],
          'elk.padding': `[top=${headerHeight},left=12,bottom=12,right=12]`,
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          'elk.nodeSize.minimum': `(${minimumWidth},${headerHeight + 34})`,
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
      const lines = wrapText(edge.label, 128, 10, measure);
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
          width: Math.max(...lines.map(line => measure(line, 10))) + 10,
          height: lines.length * 13 + 6,
          layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' },
        }] : [],
      };
      container.edges!.push(elkEdge);
    }
    const laidOut = await engine.layout(root);
    localLayouts.push({ section, root: laidOut, lifted });
  }

  const horizontal = graph.direction === 'TB' || graph.direction === 'BT';
  const outerPadding = 36;
  const titleHeight = 48;
  const sectionIndex = new Map(structure.sections.map((section, index) => [section.id, index]));
  const gaps = structure.sections.map((_, index) => {
    const crossing = structure.crossLinks.filter(link => {
      const a = sectionIndex.get(link.sourceSection)!;
      const b = sectionIndex.get(link.targetSection)!;
      return Math.min(a, b) <= index && Math.max(a, b) > index;
    }).length;
    return Math.max(64, 32 + crossing * 18);
  });
  let cursor = outerPadding + (horizontal ? 0 : titleHeight);
  const sectionTitles = localLayouts.map(({ section, root }) =>
    wrapText(section.label, Math.max(256, number(root.width, 'section width')) - 54, 13, measure));
  const headerHeight = Math.max(42, ...sectionTitles.map(lines => 20 + lines.length * 17));
  const maxWidth = Math.max(256, ...localLayouts.map(local => number(local.root.width, 'section width')));
  const maxHeight = Math.max(...localLayouts.map(local => number(local.root.height, 'section height')));
  const coordinateById = new Map<string, Box>();
  const pendingEdges: { edge: ElkExtendedEdge; origin: { x: number; y: number }; sectionId: string }[] = [];
  localLayouts.forEach(({ section, root, lifted }, index) => {
    const width = horizontal ? Math.max(256, number(root.width, 'section width')) : maxWidth;
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
}

export function edgeDescription(edge: DiagramEdge, graph: FlowGraph): string {
  const labels = new Map([...graph.nodes, ...graph.groups].map(entity => [entity.id, entity.label.split('\n')[0]]));
  const direction = edge.startMarker !== 'none' ? ' <-> ' : edge.endMarker !== 'none' ? ' -> ' : ' -- ';
  return `${labels.get(edge.source)}${direction}${labels.get(edge.target)}${edge.label ? `: ${edge.label}` : ''}`;
}
