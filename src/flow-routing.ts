import type { Box, CurvePath, DiagramEdge, DiagramLayout, Direction, FlowGraph, Point, PositionedEdge, PositionedNode } from './model.ts';
import type { MeasureText } from './text.ts';
import { EDGE_FONT_SIZE, EDGE_LINE_HEIGHT, wrapText } from './text.ts';
import { advance, curveBounds, curveCost, curveIntersectsBox, curveIntersectsNode, directCurve, distance, flattenCurve, lineSegment, mix, shapePort, smoothGuide } from './curves.ts';
import type { Port, Side } from './curves.ts';

export function forwardEdges(graph: FlowGraph): Set<string> {
  const outgoing = new Map<string, DiagramEdge[]>();
  for (const edge of graph.edges) {
    if (edge.stroke === 'invisible' || edge.stroke === 'dotted' || edge.source === edge.target) continue;
    const edges = outgoing.get(edge.source) ?? [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }
  const state = new Map<string, number>();
  const forward = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) {
      if (state.get(edge.target) === 1) continue;
      forward.add(edge.id);
      if (!state.has(edge.target)) visit(edge.target);
    }
    state.set(id, 2);
  };
  for (const entity of [...graph.nodes, ...graph.groups]) if (!state.has(entity.id)) visit(entity.id);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges.filter(edge => forward.has(edge.id))) {
    const targets = adjacency.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    adjacency.set(edge.source, targets);
  }
  for (const edge of graph.edges.filter(edge => edge.stroke === 'dotted' && edge.source !== edge.target)) {
    const pending = [edge.target];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const target of adjacency.get(id) ?? []) pending.push(target);
    }
    if (visited.has(edge.source)) continue;
    forward.add(edge.id);
    const targets = adjacency.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    adjacency.set(edge.source, targets);
  }
  return forward;
}

interface Entity { box: Box; node?: PositionedNode; sectionId: string }
const exits: Record<Direction, Side> = { TB: 'bottom', BT: 'top', LR: 'right', RL: 'left' };
const opposite: Record<Side, Side> = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
const center = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const expanded = (box: Box, padding: number): Box => ({ x: box.x - padding, y: box.y - padding, width: box.width + padding * 2, height: box.height + padding * 2 });
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const styleKey = (edge: DiagramEdge): string => JSON.stringify([
  edge.stroke, edge.startMarker, edge.endMarker, edge.paint.fill, edge.paint.stroke,
  edge.paint.color, edge.paint.strokeWidth, edge.paint.dash,
]);

function frameDirection(layout: DiagramLayout, sectionId: string): Direction {
  return layout.groups.find(group => group.depth === -1 && group.sectionId === sectionId)?.group.direction ?? layout.graph.direction;
}

function families(edges: DiagramEdge[], endpoint: 'source' | 'target'): Map<string, Map<string, DiagramEdge[]>> {
  const result = new Map<string, Map<string, DiagramEdge[]>>();
  for (const edge of edges) {
    let styles = result.get(edge[endpoint]);
    if (!styles) { styles = new Map(); result.set(edge[endpoint], styles); }
    const key = styleKey(edge);
    const members = styles.get(key) ?? [];
    members.push(edge);
    styles.set(key, members);
  }
  return result;
}

function withStems(curve: CurvePath, start: Port, end: Port): CurvePath {
  const segments = [...curve.segments];
  if (distance(start.point, curve.start) > 0.01) segments.unshift(lineSegment(start.point, curve.start));
  if (distance(segments.at(-1)?.end ?? curve.start, end.point) > 0.01) {
    segments.push(lineSegment(segments.at(-1)?.end ?? curve.start, end.point));
  }
  return { start: start.point, segments };
}

function selfLoop(entity: Entity, index: number, side: Side, reach = 28): CurvePath {
  const vertical = side === 'left' || side === 'right';
  const span = (vertical ? entity.box.height : entity.box.width) * 0.27;
  const start = shapePort(entity.box, side, entity.node, -span);
  const end = shapePort(entity.box, side, entity.node, span);
  const normal = shapePort(entity.box, side, entity.node).normal;
  const middle = advance(center(entity.box), normal, (vertical ? entity.box.width : entity.box.height) / 2 + reach + index * 40);
  const tangent = vertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const outward = Math.max(16, reach * 0.65) + index * 24;
  const turn = Math.max(20, span * 1.5);
  return {
    start: start.point,
    segments: [
      { control1: advance(start.point, start.normal, outward), control2: advance(middle, tangent, -turn), end: middle },
      { control1: advance(middle, tangent, turn), control2: advance(end.point, end.normal, outward), end: end.point },
    ],
  };
}

function parallelCurve(start: Port, end: Port, offset: number, direction: Direction): CurvePath {
  const vertical = direction === 'TB' || direction === 'BT';
  const middle = mix(start.point, end.point, 0.5);
  if (vertical) middle.x += offset; else middle.y += offset;
  const axis = { TB: { x: 0, y: 1 }, BT: { x: 0, y: -1 }, LR: { x: 1, y: 0 }, RL: { x: -1, y: 0 } }[direction];
  const handle = Math.max(12, Math.min(48, distance(start.point, end.point) / 4));
  return {
    start: start.point,
    segments: [
      { control1: advance(start.point, start.normal, handle), control2: advance(middle, axis, -handle), end: middle },
      { control1: advance(middle, axis, handle), control2: advance(end.point, end.normal, handle), end: end.point },
    ],
  };
}

function feedbackLane(
  sourceFrame: Box, targetFrame: Box, labelWidth: number, labelHeight: number,
  port: (endpoint: 'source' | 'target', side: Side) => Port,
  clear: (path: CurvePath) => boolean,
): { path: CurvePath; label: CurvePath } | undefined {
  const horizontal = Math.abs(sourceFrame.x - targetFrame.x) > Math.abs(sourceFrame.y - targetFrame.y);
  const convert = (point: Point): Point => horizontal ? point : { x: point.y, y: point.x };
  const side = (value: Side): Side => horizontal ? value : ({ top: 'left', right: 'bottom', bottom: 'right', left: 'top' } as const)[value];
  const end = port('target', side('right'));
  const endPoint = convert(end.point);
  const endJunction = advance(endPoint, convert(end.normal), 24);
  const lane = horizontal ? targetFrame.x + targetFrame.width + 32 : targetFrame.y + targetFrame.height + 32;
  for (const candidate of ['left', 'bottom', 'top', 'right'] as Side[]) {
    const start = port('source', side(candidate));
    const startPoint = convert(start.point);
    const normal = convert(start.normal);
    const minimumLabelLength = (Math.abs(start.normal.x) * labelWidth + Math.abs(start.normal.y) * labelHeight) + 24;
    const labelLength = candidate === 'left' ? Math.max(minimumLabelLength, startPoint.x - lane - 24)
      : candidate === 'bottom' ? 0 : minimumLabelLength;
    const junction = advance(startPoint, normal, labelLength);
    const label: CurvePath = { start: start.point, segments: [lineSegment(start.point, convert(junction))] };
    if (!clear(label)) continue;
    if (Math.abs(junction.y - endJunction.y) < 96) {
      const core = directCurve(
        { point: convert(junction), normal: start.normal },
        { point: convert(endJunction), normal: end.normal },
        Math.max(24, Math.min(140, Math.abs(junction.x - endJunction.x) / 2)),
      );
      const path = withStems(core, start, end);
      if (clear(path)) return { path, label };
      continue;
    }
    const travel = junction.y > endJunction.y ? -1 : 1;
    const branchEnd = { x: lane, y: junction.y + (normal.y === -travel ? 0 : travel * 48) };
    const laneEnd = { x: lane, y: endJunction.y - travel * 32 };
    const branch = directCurve(
      { point: convert(junction), normal: start.normal },
      { point: convert(branchEnd), normal: convert({ x: 0, y: -travel }) },
      normal.y === -travel ? Math.max(48, Math.sqrt(Math.abs(junction.x - lane) * 16))
        : Math.max(12, Math.min(Math.abs(junction.x - lane), Math.abs(junction.y - branchEnd.y)) * 0.65),
    );
    const turn = directCurve(
      { point: convert(laneEnd), normal: convert({ x: 0, y: travel }) },
      { point: convert(endJunction), normal: end.normal },
      Math.max(12, Math.min(Math.abs(laneEnd.x - endJunction.x), Math.abs(laneEnd.y - endJunction.y)) * 0.65),
    );
    const path: CurvePath = {
      start: start.point,
      segments: [
        ...(labelLength ? [lineSegment(start.point, convert(junction))] : []), ...branch.segments,
        lineSegment(convert(branchEnd), convert(laneEnd)), ...turn.segments,
        lineSegment(convert(endJunction), end.point),
      ],
    };
    if (clear(path)) return { path, label: labelLength ? label : branch };
  }
  return undefined;
}

function regionBridge(start: Port, end: Port, source: Box, target: Box): { path: CurvePath; label: CurvePath } | undefined {
  if (Math.abs(source.y - target.y) <= Math.abs(source.x - target.x)
    || !start.normal.x || start.normal.x !== -end.normal.x
    || (end.point.x - start.point.x) * start.normal.x >= 0) return undefined;
  const direction = Math.sign(start.normal.x);
  const gap = source.y < target.y ? (source.y + source.height + target.y) / 2 : (target.y + target.height + source.y) / 2;
  const right = Math.max(source.x + source.width, target.x + target.width) + 32;
  const left = Math.min(source.x, target.x) - 32;
  const exit = { x: direction > 0 ? right : left, y: gap };
  const entry = { x: direction > 0 ? left : right, y: gap };
  const sourceControl = exit.x + direction * 64;
  const targetControl = entry.x - direction * 64;
  return {
    path: {
      start: start.point,
      segments: [
        { control1: { x: sourceControl, y: start.point.y }, control2: { x: sourceControl, y: gap }, end: exit },
        lineSegment(exit, entry),
        { control1: { x: targetControl, y: gap }, control2: { x: targetControl, y: end.point.y }, end: end.point },
      ],
    },
    label: { start: exit, segments: [lineSegment(exit, entry)] },
  };
}

function pointAt(path: CurvePath, fraction: number): { point: Point; normal: Point } {
  const points = flattenCurve(path);
  const lengths = points.slice(1).map((point, index) => distance(points[index], point));
  let remaining = lengths.reduce((a, b) => a + b, 0) * fraction;
  for (let index = 0; index < lengths.length; index++) {
    if (remaining <= lengths[index] || index + 1 === lengths.length) {
      const length = Math.max(0.001, lengths[index]);
      return {
        point: mix(points[index], points[index + 1], remaining / length),
        normal: { x: -(points[index + 1].y - points[index].y) / length, y: (points[index + 1].x - points[index].x) / length },
      };
    }
    remaining -= lengths[index];
  }
  return { point: path.start, normal: { x: 0, y: -1 } };
}

export function positionGroupCaptions(layout: DiagramLayout, measure: MeasureText, forward = forwardEdges(layout.graph)): void {
  const entities = new Map<string, Entity>([
    ...layout.nodes.map(node => [node.node.id, { box: node, node, sectionId: node.sectionId }] as const),
    ...layout.groups.map(group => [group.group.id, { box: group, sectionId: group.sectionId }] as const),
  ]);
  const parents = new Map([...layout.graph.nodes, ...layout.graph.groups].map(entity => [entity.id, entity.parent]));
  for (const group of layout.groups.filter(group => group.depth >= 0)) {
    const members = layout.nodes.filter(node => {
      let parent = parents.get(node.node.id);
      while (parent) { if (parent === group.group.id) return true; parent = parents.get(parent); }
      return false;
    });
    const width = Math.max(0, ...group.lines.map(line => measure(line, 16))) + 4;
    const direction = frameDirection(layout, group.sectionId);
    const memberIds = new Set(members.map(node => node.node.id));
    const crossings = layout.graph.edges.filter(edge => forward.has(edge.id)
      && memberIds.has(edge.source) !== memberIds.has(edge.target))
      .map(edge => {
        const inner = entities.get(memberIds.has(edge.source) ? edge.source : edge.target)!;
        const outer = entities.get(memberIds.has(edge.source) ? edge.target : edge.source)!;
        return center(outer.box).y < group.y ? center(inner.box).x : Infinity;
      });
    const axis = Math.min(...crossings);
    const x = direction === 'TB' || direction === 'BT' ? Math.min(group.x + 8, axis - width - 16) : group.x + 8;
    const caption = { x, y: group.y + 7, width, height: group.lines.length * 19 + 3 };
    if (layout.nodes.some(node => overlaps(caption, expanded(node, 3)))) caption.x = Number.isFinite(axis) ? axis + 16 : group.x + 8;
    group.caption = caption;
  }
}

export function routeFlowConnections(
  layout: DiagramLayout,
  measure: MeasureText,
  options: { forward?: Set<string>; fit?: boolean; preserve?: Set<string> } = {},
): void {
  const forward = options.forward ?? forwardEdges(layout.graph);
  const entities = new Map<string, Entity>([
    ...layout.nodes.map(node => [node.node.id, { box: node, node, sectionId: node.sectionId }] as const),
    ...layout.groups.map(group => [group.group.id, { box: group, sectionId: group.sectionId }] as const),
  ]);
  positionGroupCaptions(layout, measure, forward);
  const captions: Box[] = [
    ...layout.groups.flatMap(group => group.caption ? [group.caption] : []),
    ...layout.sections.filter(section => section.headerHeight > 0).map(section => ({
      x: section.x + 8, y: section.y + 10, width: Math.max(0, ...section.lines.map(line => measure(line, 13))) + 42, height: section.lines.length * 17 + 3,
    })),
  ];
  const original = new Map(layout.edges.map(edge => [edge.edge.id, edge]));
  const visible = layout.graph.edges.filter(edge => edge.stroke !== 'invisible');
  const primary = visible.filter(edge => forward.has(edge.id));
  const outgoingFamilies = families(primary, 'source');
  const incomingFamilies = families(visible, 'target');
  const placed: PositionedEdge[] = [];
  const labelPaths = new Map<string, CurvePath>();
  type Endpoint = 'source' | 'target';
  const docks: { edge: DiagramEdge; endpoint: Endpoint; point: Point }[] = [];
  const available = (edge: DiagramEdge, endpoint: Endpoint, point: Point): boolean =>
    entities.get(edge.source)!.sectionId === entities.get(edge.target)!.sectionId
    || !docks.some(dock => edge[endpoint] === dock.edge[dock.endpoint] && distance(point, dock.point) < 10
      && !(endpoint === dock.endpoint && styleKey(edge) === styleKey(dock.edge)
        && forward.has(edge.id) === forward.has(dock.edge.id)));
  const remember = (route: PositionedEdge): void => {
    const last = route.curves?.at(-1)?.segments.at(-1)?.end;
    if (!last || !route.curves?.length) return;
    docks.push({ edge: route.edge, endpoint: 'source', point: route.curves[0].start },
      { edge: route.edge, endpoint: 'target', point: last });
  };
  for (const route of original.values()) if (options.preserve?.has(route.edge.id)) remember(route);
  for (const edge of visible) {
    const retained = original.get(edge.id);
    if (options.preserve?.has(edge.id) && retained?.curves) { placed.push(retained); continue; }
    const source = entities.get(edge.source)!;
    const target = entities.get(edge.target)!;
    const direction = frameDirection(layout, source.sectionId);
    const vertical = direction === 'TB' || direction === 'BT';
    const port = (endpoint: Endpoint, side: Side, offset = 0): Port => {
      const entity = endpoint === 'source' ? source : target;
      const extent = (side === 'top' || side === 'bottom' ? entity.box.width : entity.box.height) / 2 - 6;
      for (let step = 0; step <= Math.ceil(extent / 12) * 2; step++) {
        const delta = step ? Math.ceil(step / 2) * (step % 2 ? 12 : -12) : 0;
        if (Math.abs(offset + delta) > extent) continue;
        const candidate = shapePort(entity.box, side, entity.node, offset + delta);
        if (available(edge, endpoint, candidate.point)) return candidate;
      }
      return shapePort(entity.box, side, entity.node, offset);
    };
    const sourceCenter = center(source.box);
    const targetCenter = center(target.box);
    const crossSection = source.sectionId !== target.sectionId;
    const outgoing = outgoingFamilies.get(edge.source)?.get(styleKey(edge)) ?? [];
    const incoming = incomingFamilies.get(edge.target)?.get(styleKey(edge)) ?? [];
    const parallel = visible.filter(other => other.source === edge.source && other.target === edge.target && other.stroke !== 'dotted');
    const companions = visible.filter(other => other.source === edge.source && other.target === edge.target);
    const feedback = !forward.has(edge.id);
    const localOutgoing = primary.filter(other => other.source === edge.source && entities.get(other.target)!.sectionId === source.sectionId);
    const fork = localOutgoing.length === 2 && new Set(localOutgoing.map(other => other.target)).size === 2;
    const secondaryParallel = edge.stroke === 'dotted' && companions.some(other => styleKey(other) !== styleKey(edge));
    let startSide = exits[direction];
    let endSide = opposite[startSide];
    const forwardProjection = (targetCenter.x - sourceCenter.x) * (startSide === 'right' ? 1 : startSide === 'left' ? -1 : 0)
      + (targetCenter.y - sourceCenter.y) * (startSide === 'bottom' ? 1 : startSide === 'top' ? -1 : 0);
    if (crossSection) {
      const sourceFrame = layout.sections.find(section => section.section.id === source.sectionId)!;
      const targetFrame = layout.sections.find(section => section.section.id === target.sectionId)!;
      const horizontal = Math.abs(sourceFrame.x - targetFrame.x) > Math.abs(sourceFrame.y - targetFrame.y);
      startSide = horizontal ? targetFrame.x > sourceFrame.x ? 'right' : 'left' : targetFrame.y > sourceFrame.y ? 'bottom' : 'top';
      endSide = opposite[startSide];
      const targetDirection = frameDirection(layout, target.sectionId);
      if (!vertical) startSide = exits[direction];
      if (targetDirection === 'LR' || targetDirection === 'RL') endSide = opposite[exits[targetDirection]];
    } else if (feedback && forwardProjection < -1) {
      startSide = endSide = direction === 'TB' ? 'left' : direction === 'BT' ? 'right' : direction === 'LR' ? 'bottom' : 'top';
      const styles = [...new Set(visible.filter(other => other.target === edge.target && !forward.has(other.id)).map(styleKey))];
      if (styles.indexOf(styleKey(edge)) % 2 === 1) startSide = endSide = opposite[startSide];
    } else if (feedback) {
      const horizontal = Math.abs(targetCenter.x - sourceCenter.x) > Math.abs(targetCenter.y - sourceCenter.y);
      startSide = horizontal ? targetCenter.x > sourceCenter.x ? 'right' : 'left' : targetCenter.y > sourceCenter.y ? 'bottom' : 'top';
      endSide = opposite[startSide];
    } else if (source.node?.node.shape === 'diamond' && fork) {
      const ordered = [...localOutgoing].sort((a, b) => {
        const x = center(entities.get(a.target)!.box);
        const y = center(entities.get(b.target)!.box);
        return (vertical ? x.x - y.x : x.y - y.y) || visible.indexOf(a) - visible.indexOf(b);
      });
      startSide = vertical ? ordered[0] === edge ? 'left' : 'right' : ordered[0] === edge ? 'top' : 'bottom';
    }
    if (!crossSection && secondaryParallel) {
      startSide = endSide = direction === 'TB' ? 'right' : direction === 'BT' ? 'left' : direction === 'LR' ? 'top' : 'bottom';
    } else if (!crossSection && edge.stroke === 'dotted' && !feedback
      && visible.some(other => other.target === edge.target && styleKey(other) !== styleKey(edge))) {
      endSide = vertical ? sourceCenter.x < targetCenter.x ? 'left' : 'right' : sourceCenter.y < targetCenter.y ? 'top' : 'bottom';
      startSide = opposite[endSide];
    }
    const hasIncomingReturn = (id: string) => visible.some(other => other.target === id && !forward.has(other.id) && other.source !== other.target);
    const hasOutgoingReturn = (id: string) => visible.some(other => other.source === id && !forward.has(other.id) && other.source !== other.target);
    const returnOffset = direction === 'BT' || direction === 'RL' ? 1 : -1;
    const startOffset = !crossSection && feedback && forwardProjection < -1 && hasIncomingReturn(edge.source)
      ? returnOffset * Math.min(10, (vertical ? source.box.height : source.box.width) / 4) : 0;
    const endOffset = !crossSection && feedback && forwardProjection < -1 && hasOutgoingReturn(edge.target)
      ? -returnOffset * Math.min(10, (vertical ? target.box.height : target.box.width) / 4) : 0;
    const parallelStyles = [...new Set(parallel.map(styleKey))];
    const lane = parallelStyles.length > 1 && !secondaryParallel && !feedback ? parallelStyles.indexOf(styleKey(edge)) - (parallelStyles.length - 1) / 2 : 0;
    const styleStartOffset = lane * Math.min(20, (startSide === 'left' || startSide === 'right' ? source.box.height - 16 : source.box.width - 16) / Math.max(1, parallelStyles.length - 1));
    const styleEndOffset = lane * Math.min(20, (endSide === 'left' || endSide === 'right' ? target.box.height - 16 : target.box.width - 16) / Math.max(1, parallelStyles.length - 1));
    const start = port('source', startSide, startOffset + styleStartOffset);
    const end = port('target', endSide, endOffset + styleEndOffset);
    if (!crossSection && !feedback && fork && source.node?.node.shape === 'diamond') {
      const span = distance(start.point, end.point);
      start.normal = { x: (end.point.x - start.point.x) / span, y: (end.point.y - start.point.y) / span };
    }
    const padding = (edge.paint.strokeWidth ?? (edge.stroke === 'thick' ? 3 : 1.3)) / 2 + 1.5;
    const obstacles = [
      ...[...entities.entries()].filter(([id, entity]) => entity.node && id !== edge.source && id !== edge.target).map(([, entity]) => expanded(entity.box, padding)),
      ...captions.filter(box => !overlaps(box, source.box) && !overlaps(box, target.box)),
      ...[...original.values()].flatMap(other => options.preserve?.has(other.edge.id) && other.label ? [expanded(other.label, 2)] : []),
    ];
    const clear = (path: CurvePath) => !obstacles.some(box => curveIntersectsBox(path, box))
      && !(source.node && curveIntersectsNode(path, source.node))
      && !(target.node && curveIntersectsNode(path, target.node))
      && available(edge, 'source', path.start)
      && available(edge, 'target', path.segments.at(-1)?.end ?? path.start);
    let curve: CurvePath | undefined;
    let labelPath: CurvePath | undefined;
    if (crossSection && !feedback) {
      const sourceFrame = layout.sections.find(section => section.section.id === source.sectionId)!;
      const targetFrame = layout.sections.find(section => section.section.id === target.sectionId)!;
      const bridge = regionBridge(start, end, sourceFrame, targetFrame);
      if (bridge && clear(bridge.path)) { curve = bridge.path; labelPath = bridge.label; }
    }
    if (crossSection && feedback && incoming.length > 1) {
      const sourceFrame = layout.sections.find(section => section.section.id === source.sectionId)!;
      const targetFrame = layout.sections.find(section => section.section.id === target.sectionId)!;
      if (layout.structure.sections.find(section => section.id === source.sectionId)!.index
        > layout.structure.sections.find(section => section.id === target.sectionId)!.index) {
        const lines = wrapText(edge.label, 160, EDGE_FONT_SIZE, measure);
        const result = feedbackLane(sourceFrame, targetFrame,
          edge.label ? Math.max(...lines.map(line => measure(line, EDGE_FONT_SIZE))) + 10 : 0,
          edge.label ? lines.length * EDGE_LINE_HEIGHT + 6 : 0, port, clear);
        if (result) { curve = result.path; labelPath = result.label; }
      }
    }
    if (edge.source === edge.target) {
      const loops = visible.filter(other => other.source === edge.source && other.target === edge.target);
      const preferred: Side = direction === 'TB' ? 'right' : direction === 'BT' ? 'left' : direction === 'LR' ? 'top' : 'bottom';
      for (const side of [preferred, opposite[preferred]]) {
        const containers = layout.groups.filter(group => overlaps(group, source.box));
        const labelLines = wrapText(edge.label, 160, EDGE_FONT_SIZE, measure);
        const labelSize = side === 'left' || side === 'right'
          ? Math.max(0, ...labelLines.map(line => measure(line, EDGE_FONT_SIZE))) + 10 : labelLines.length * EDGE_LINE_HEIGHT + 6;
        const border = side === 'right' ? Math.max(0, ...containers.map(group => group.x + group.width - source.box.x - source.box.width))
          : side === 'left' ? Math.max(0, ...containers.map(group => source.box.x - group.x))
            : side === 'top' ? Math.max(0, ...containers.map(group => source.box.y - group.y))
              : Math.max(0, ...containers.map(group => group.y + group.height - source.box.y - source.box.height));
        const candidate = selfLoop(source, loops.indexOf(edge), side, Math.max(28, border + labelSize / 2 + 12));
        if (clear(candidate)) { curve = candidate; break; }
      }
    } else if (!curve) {
      const span = distance(start.point, end.point);
      const stem = 24;
      const lines = wrapText(edge.label, 160, EDGE_FONT_SIZE, measure);
      const labelExtent = vertical ? lines.length * EDGE_LINE_HEIGHT + 6
        : Math.max(...lines.map(line => measure(line, EDGE_FONT_SIZE))) + 10;
      const sourceLabel = !feedback && !crossSection && incoming.length > 2 && !!edge.label;
      const targetLabel = !feedback && !crossSection && outgoing.length > 2 && !!edge.label;
      const startStem = sourceLabel ? labelExtent + 24
        : outgoing.length > 2 && source.node?.node.shape !== 'diamond' && parallel.length === 1 ? stem : 0;
      const targetStem = targetLabel ? labelExtent + 24 : incoming.length > 2 && parallel.length === 1 ? stem : 0;
      const startJunction: Port = { point: advance(start.point, start.normal, startStem), normal: start.normal };
      const endJunction: Port = { point: advance(end.point, end.normal, targetStem), normal: end.normal };
      const candidates: { path: CurvePath; label: CurvePath }[] = [];
      if (secondaryParallel) {
        const offset = direction === 'TB' || direction === 'RL' ? 80 : -80;
        const main = parallelCurve(startJunction, endJunction, offset, direction);
        candidates.push({ path: withStems(main, start, end), label: main });
      } else if (parallel.length > 1 && !feedback) {
        const main = parallelCurve(startJunction, endJunction, (parallel.indexOf(edge) - (parallel.length - 1) / 2) * 48, direction);
        candidates.push({ path: withStems(main, start, end), label: main });
      } else {
        const dx = endJunction.point.x - startJunction.point.x;
        const dy = endJunction.point.y - startJunction.point.y;
        const aligned = Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01;
        const outward = dx * start.normal.x + dy * start.normal.y > 0.01
          && dx * end.normal.x + dy * end.normal.y < -0.01;
        if (aligned && outward && ((!feedback && !startStem && !targetStem)
          || (start.normal.x === -end.normal.x && start.normal.y === -end.normal.y))) {
          const main = { start: startJunction.point, segments: [lineSegment(startJunction.point, endJunction.point)] };
          candidates.push({ path: withStems(main, start, end), label: main });
        }
        for (const factor of [0.4, 0.6, 0.25]) {
          let handle = Math.max(20, Math.min(160, span * factor));
          if (start.normal.x === -end.normal.x && start.normal.y === -end.normal.y) {
            const projection = (endJunction.point.x - startJunction.point.x) * start.normal.x
              + (endJunction.point.y - startJunction.point.y) * start.normal.y;
            if (projection > 0) handle = Math.min(handle, projection / 2);
          }
          if (!crossSection && feedback && forwardProjection < -1) {
            const containers = layout.groups.filter(group => group.group.paint.stroke !== 'none'
              && (overlaps(group, source.box) || overlaps(group, target.box)));
            let outside = 0;
            if (containers.length) {
              if (startSide === 'left') outside = (Math.max(start.point.x, end.point.x) - Math.min(...containers.map(group => group.x)) + 24) / 0.75;
              if (startSide === 'right') outside = (Math.max(...containers.map(group => group.x + group.width)) + 24 - Math.min(start.point.x, end.point.x)) / 0.75;
              if (startSide === 'top') outside = (Math.max(start.point.y, end.point.y) - Math.min(...containers.map(group => group.y)) + 24) / 0.75;
              if (startSide === 'bottom') outside = (Math.max(...containers.map(group => group.y + group.height)) + 24 - Math.min(start.point.y, end.point.y)) / 0.75;
            }
            handle = Math.max(handle, 72, outside);
          }
          const main = directCurve(startJunction, endJunction, handle);
          candidates.push({ path: withStems(main, start, end), label: main });
        }
      }
      const selected = candidates.filter(candidate => clear(candidate.path))
        .map(candidate => ({ ...candidate, cost: curveCost(candidate.path) })).sort((a, b) => a.cost - b.cost)[0];
      if (selected) {
        curve = selected.path;
        labelPath = sourceLabel ? { start: start.point, segments: [lineSegment(start.point, startJunction.point)] }
          : targetLabel ? { start: endJunction.point, segments: [lineSegment(endJunction.point, end.point)] } : selected.label;
      }
    }
    if (!curve && edge.source !== edge.target) {
      let best = Infinity;
      const sourceSides: Side[] = source.node?.node.shape === 'diamond' && fork
        ? [startSide] : [startSide, ...(['top', 'right', 'bottom', 'left'] as Side[]).filter(side => side !== startSide)];
      const targetSides: Side[] = [endSide, ...(['top', 'right', 'bottom', 'left'] as Side[]).filter(side => side !== endSide)];
      for (const a of sourceSides) for (const b of targetSides) {
        if (!crossSection && feedback && forwardProjection < -1
          && (a !== b || (vertical ? a === 'top' || a === 'bottom' : a === 'left' || a === 'right'))) continue;
        const alternativeStart = port('source', a);
        const alternativeEnd = port('target', b);
        for (const factor of [0.35, 0.65]) {
          const candidate = directCurve(alternativeStart, alternativeEnd, Math.max(20, Math.min(180, distance(alternativeStart.point, alternativeEnd.point) * factor)));
          if (!clear(candidate)) continue;
          const cost = curveCost(candidate) + (a === startSide ? 0 : 160) + (b === endSide ? 0 : 80);
          if (cost < best) { best = cost; curve = candidate; labelPath = candidate; }
        }
      }
    }
    const previous = original.get(edge.id);
    if (!curve) {
      const guide = previous?.paths[0];
      if (guide?.length) {
        const points = [start.point, advance(start.point, start.normal, 16), ...guide.slice(1, -1), advance(end.point, end.normal, 16), end.point];
        const candidate = smoothGuide(points, obstacles);
        if (clear(candidate)) curve = candidate;
        if (!curve && crossSection) {
          const guided = smoothGuide(guide, obstacles);
          if (clear(guided)) curve = guided;
        }
      }
    }
    if (!curve) throw new Error(`No smooth, clear connection could be drawn from "${edge.source}" to "${edge.target}".`);
    const positioned: PositionedEdge = {
      edge, paths: previous?.paths ?? [], curves: [curve], sectionId: source.sectionId, crossSection,
    };
    if (labelPath) labelPaths.set(edge.id, labelPath);
    placed.push(positioned);
    remember(positioned);
  }
  for (const positioned of placed) {
    const edge = positioned.edge;
    if (options.preserve?.has(edge.id)) continue;
    if (edge.label) {
      const lines = wrapText(edge.label, 160, EDGE_FONT_SIZE, measure);
      const width = Math.max(...lines.map(line => measure(line, EDGE_FONT_SIZE))) + 10;
      const height = lines.length * EDGE_LINE_HEIGHT + 6;
      const path = labelPaths.get(edge.id) ?? positioned.curves![0];
      const blocked = [...layout.nodes.map(node => expanded(node, 4)), ...captions, ...placed.flatMap(other => other.label ? [expanded(other.label, 3)] : [])];
      const parents = new Map([...layout.graph.nodes, ...layout.graph.groups].map(entity => [entity.id, entity.parent]));
      const inside = (id: string, group: string) => {
        let parent = parents.get(id);
        while (parent) { if (parent === group) return true; parent = parents.get(parent); }
        return false;
      };
      const borders = layout.groups.filter(group => !inside(edge.source, group.group.id) || !inside(edge.target, group.group.id)).flatMap(group => [
        { x: group.x - 2, y: group.y, width: 4, height: group.height },
        { x: group.x + group.width - 2, y: group.y, width: 4, height: group.height },
        { x: group.x, y: group.y - 2, width: group.width, height: 4 },
        { x: group.x, y: group.y + group.height - 2, width: group.width, height: 4 },
      ]);
      for (const fraction of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
        const location = pointAt(path, fraction);
        const offset = Math.abs(location.normal.x) * width / 2 + Math.abs(location.normal.y) * height / 2 + 2;
        for (const sign of [0, 1, -1]) {
          const point = advance(location.point, location.normal, sign * offset);
          const box = { x: point.x - width / 2, y: point.y - height / 2, width, height };
          if (blocked.some(obstacle => overlaps(box, obstacle)) || borders.some(border => overlaps(box, border))) continue;
          if (placed.some(other => other !== positioned && other.curves?.some(otherPath =>
            curveIntersectsBox(otherPath, expanded(box, Math.max(2, (other.edge.paint.strokeWidth ?? 1.3) / 2 + 1)))))) continue;
          positioned.label = { ...box, lines };
          break;
        }
        if (positioned.label) break;
      }
      if (!positioned.label) throw new Error(`No clear midpoint label position was found for "${edge.label}".`, {
        cause: { path, nodes: layout.nodes.map(node => ({ id: node.node.id, x: node.x, y: node.y, width: node.width, height: node.height })), labels: placed.flatMap(other => other.label ? [other.label] : []) },
      });
    }
  }
  layout.edges = [...placed, ...layout.edges.filter(edge => edge.edge.stroke === 'invisible')];
  if (options.fit === false) return;
  const points = [...placed.flatMap(edge => [
    ...edge.curves!.flatMap(path => {
      const box = curveBounds(path);
      return [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }];
    }),
    ...(edge.label ? [{ x: edge.label.x, y: edge.label.y }, { x: edge.label.x + edge.label.width, y: edge.label.y + edge.label.height }] : []),
  ]), ...layout.groups.flatMap(group => group.caption ? [
    { x: group.caption.x, y: group.caption.y },
    { x: group.caption.x + group.caption.width, y: group.caption.y + group.caption.height },
  ] : [])];
  const dx = Math.max(0, 16 - Math.min(...points.map(point => point.x)));
  const dy = Math.max(0, 48 - Math.min(...points.map(point => point.y)));
  if (dx || dy) {
    for (const box of [...layout.nodes, ...layout.groups, ...layout.sections, ...layout.groups.flatMap(group => group.caption ? [group.caption] : [])]) {
      box.x += dx; box.y += dy;
    }
    for (const edge of layout.edges) {
      for (const path of edge.paths) for (const point of path) { point.x += dx; point.y += dy; }
      for (const path of edge.curves ?? []) {
        path.start = advance(path.start, { x: dx, y: dy }, 1);
        for (const segment of path.segments) for (const key of ['control1', 'control2', 'end'] as const) {
          segment[key] = advance(segment[key], { x: dx, y: dy }, 1);
        }
      }
      if (edge.label) { edge.label.x += dx; edge.label.y += dy; }
    }
  }
  layout.width = Math.max(layout.width + dx, ...points.map(point => point.x + dx + 16));
  layout.height = Math.max(layout.height + dy, ...points.map(point => point.y + dy + 16));
}
