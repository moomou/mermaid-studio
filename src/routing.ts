import type { Box, DiagramLayout, Point, PositionedEdge } from './model.ts';
import { clipRoute } from './geometry.ts';
import { EDGE_FONT_SIZE, EDGE_LINE_HEIGHT, wrapText } from './text.ts';
import type { MeasureText } from './text.ts';

interface Port {
  anchor: Point;
  lead: Point;
  normal: Point;
}
interface Obstacle extends Box { owner?: string }
export const CROSS_ROUTE_GAP = 14;
export const BOUNDARY_ROUTE_GAP = 10;
const PORT_PITCH = 18;

function expand(box: Box, amount: number): Box {
  return { x: box.x - amount, y: box.y - amount, width: box.width + amount * 2, height: box.height + amount * 2 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function ports(box: Box, slots: number[] = [0, 0, 0, 0], count = 1): Port[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const offset = (side: number) => {
    const span = (side < 2 ? box.height : box.width) - 16;
    const pitch = count > 1 ? Math.min(PORT_PITCH, span / (count - 1)) : 0;
    return (slots[side] - (count - 1) / 2) * pitch;
  };
  return [
    { anchor: { x: box.x + box.width, y: cy + offset(0) }, normal: { x: 1, y: 0 } },
    { anchor: { x: box.x, y: cy + offset(1) }, normal: { x: -1, y: 0 } },
    { anchor: { x: cx + offset(2), y: box.y + box.height }, normal: { x: 0, y: 1 } },
    { anchor: { x: cx + offset(3), y: box.y }, normal: { x: 0, y: -1 } },
  ].map(port => ({ ...port, lead: { x: port.anchor.x + port.normal.x * 14, y: port.anchor.y + port.normal.y * 14 } }));
}

function lowerBound(values: number[], value: number, inclusive = false): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value || (inclusive && values[middle] === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function segments(points: Point[]): { a: Point; b: Point }[] {
  return points.slice(1).map((b, index) => ({ a: points[index], b }));
}

function border(box: Box): Point[] {
  return [
    { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }, { x: box.x, y: box.y },
  ];
}

function lineBoxes(points: Point[], padding: number): Box[] {
  return segments(points).map(({ a, b }) => expand({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
  }, padding));
}

class Heap {
  private items: { state: number; cost: number; priority: number }[] = [];
  push(item: { state: number; cost: number; priority: number }): void {
    let i = this.items.length;
    this.items.push(item);
    while (i) {
      const parent = (i - 1) >>> 1;
      if (this.items[parent].priority <= item.priority) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop(): { state: number; cost: number; priority: number } | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length || !last) return first;
    let i = 0;
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].priority < this.items[child].priority) child++;
      if (last.priority <= this.items[child].priority) break;
      this.items[i] = this.items[child];
      i = child;
    }
    this.items[i] = last;
    return first;
  }
}

function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    while (result.length > 1) {
      const a = result[result.length - 2];
      const b = result[result.length - 1];
      if ((a.x === b.x && b.x === point.x && (b.y - a.y) * (point.y - b.y) >= 0)
        || (a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0)) result.pop();
      else break;
    }
    result.push({ ...point });
  }
  return result;
}

// A visibility grid routes between independently laid-out regions. Boxes and
// captions are hard obstacles; parallel paths reserve physical clearance.
// Keeping this separate prevents return links from distorting the main flow.
class GridRouter {
  private xs: number[];
  private ys: number[];
  private nx: number;
  private size: number;
  private horizontal: Uint8Array;
  private vertical: Uint8Array;
  private traffic: Uint16Array;
  private regions: Int16Array;
  private layout: DiagramLayout;
  private obstacles: Obstacle[];
  private search?: { distance: Float64Array; previous: Int32Array };

  constructor(layout: DiagramLayout, obstacles: Obstacle[], allPorts: Port[]) {
    this.layout = layout;
    this.obstacles = obstacles;
    const xs = new Set([8, layout.width - 8]);
    const ys = new Set([48, layout.height - 8]);
    for (let x = 8; x < layout.width - 8; x += CROSS_ROUTE_GAP) xs.add(x);
    for (let y = 48; y < layout.height - 8; y += CROSS_ROUTE_GAP) ys.add(y);
    for (const box of obstacles) {
      xs.add(box.x); xs.add(box.x + box.width);
      ys.add(box.y); ys.add(box.y + box.height);
    }
    for (const port of allPorts) { xs.add(port.lead.x); ys.add(port.lead.y); }
    for (const section of layout.sections) {
      xs.add(section.x - 16); xs.add(section.x + section.width + 16);
      ys.add(section.y - 12); ys.add(section.y + section.height + 12);
    }
    this.xs = [...xs].filter(x => x >= 8 && x <= layout.width - 8).sort((a, b) => a - b);
    this.ys = [...ys].filter(y => y >= 48 && y <= layout.height - 8).sort((a, b) => a - b);
    this.nx = this.xs.length;
    this.size = this.nx * this.ys.length;
    if (this.size > 160_000) throw new Error('This diagram is too dense for separated routes. Split it into smaller diagrams or use the original Mermaid layout.');
    this.horizontal = new Uint8Array(this.size);
    this.vertical = new Uint8Array(this.size);
    this.traffic = new Uint16Array(this.size);
    this.regions = new Int16Array(this.size).fill(-1);
    for (const box of obstacles) this.block(box);
    for (const group of layout.groups) {
      if (group.group.paint.stroke !== 'none' && group.group.paint.strokeWidth !== 0) this.reserve(border(group), BOUNDARY_ROUTE_GAP);
    }
    layout.sections.forEach((section, index) => {
      const left = lowerBound(this.xs, section.x);
      const right = lowerBound(this.xs, section.x + section.width);
      for (let y = lowerBound(this.ys, section.y); y < lowerBound(this.ys, section.y + section.height); y++) {
        this.regions.fill(index, y * this.nx + left, y * this.nx + right);
      }
    });
  }

  private block(box: Box): void {
    const left = Math.max(0, lowerBound(this.xs, box.x, true) - 1);
    const right = lowerBound(this.xs, box.x + box.width);
    const top = Math.max(0, lowerBound(this.ys, box.y, true) - 1);
    const bottom = lowerBound(this.ys, box.y + box.height);
    for (let y = lowerBound(this.ys, box.y, true); y < bottom; y++) {
      this.horizontal.fill(1, y * this.nx + left, y * this.nx + right);
    }
    for (let y = top; y < bottom; y++) {
      this.vertical.fill(1, y * this.nx + lowerBound(this.xs, box.x, true), y * this.nx + right);
    }
  }

  addLabel(box: Box): void {
    const obstacle = expand(box, 3);
    this.obstacles.push(obstacle);
    this.block(obstacle);
  }

  reserve(points: Point[], gap = CROSS_ROUTE_GAP): void {
    for (const { a, b } of segments(points)) {
      if (a.x === b.x) {
        const left = lowerBound(this.xs, a.x - gap + 0.01);
        const right = lowerBound(this.xs, a.x + gap - 0.01);
        const top = Math.max(0, lowerBound(this.ys, Math.min(a.y, b.y), true) - 1);
        const bottom = lowerBound(this.ys, Math.max(a.y, b.y));
        for (let y = top; y < bottom; y++) this.vertical.fill(1, y * this.nx + left, y * this.nx + right);
      } else {
        const top = lowerBound(this.ys, a.y - gap + 0.01);
        const bottom = lowerBound(this.ys, a.y + gap - 0.01);
        const left = Math.max(0, lowerBound(this.xs, Math.min(a.x, b.x), true) - 1);
        const right = lowerBound(this.xs, Math.max(a.x, b.x));
        for (let y = top; y < bottom; y++) this.horizontal.fill(1, y * this.nx + left, y * this.nx + right);
      }
    }
  }

  route(start: Port, end: Port, source: string, target: string): Point[] | undefined {
    const index = (point: Point) => {
      const x = lowerBound(this.xs, point.x);
      const y = lowerBound(this.ys, point.y);
      return this.xs[x] === point.x && this.ys[y] === point.y ? y * this.nx + x : -1;
    };
    const first = index(start.lead);
    const last = index(end.lead);
    if (first < 0 || last < 0) return undefined;
    const sourceRegion = this.layout.sections.findIndex(section => section.section.id === source);
    const targetRegion = this.layout.sections.findIndex(section => section.section.id === target);
    const { distance, previous } = this.search ??= {
      distance: new Float64Array(this.size * 2),
      previous: new Int32Array(this.size * 2),
    };
    distance.fill(Infinity);
    previous.fill(-1);
    const point = (vertex: number): Point => ({ x: this.xs[vertex % this.nx], y: this.ys[Math.floor(vertex / this.nx)] });
    const firstState = first * 2 + (start.normal.x ? 0 : 1);
    const heap = new Heap();
    distance[firstState] = 0;
    heap.push({ state: firstState, cost: 0, priority: 0 });
    let item;
    while ((item = heap.pop())) {
      if (distance[item.state] !== item.cost) continue;
      const vertex = item.state >>> 1;
      if (vertex === last) {
        const path: Point[] = [];
        let state = item.state;
        while (state >= 0) {
          const step = state >>> 1;
          path.push(point(step));
          this.traffic[step] += 20;
          state = previous[state];
        }
        path.reverse();
        return simplify([start.anchor, ...path, end.anchor]);
      }
      const x = vertex % this.nx;
      const y = Math.floor(vertex / this.nx);
      const currentX = this.xs[x];
      const currentY = this.ys[y];
      for (let side = 0; side < 4; side++) {
        let next = -1;
        if (side === 0 && x > 0 && !this.horizontal[vertex - 1]) next = vertex - 1;
        else if (side === 1 && x + 1 < this.nx && !this.horizontal[vertex]) next = vertex + 1;
        else if (side === 2 && y > 0 && !this.vertical[vertex - this.nx]) next = vertex - this.nx;
        else if (side === 3 && y + 1 < this.ys.length && !this.vertical[vertex]) next = vertex + this.nx;
        if (next < 0) continue;
        const nextX = this.xs[next % this.nx];
        const nextY = this.ys[Math.floor(next / this.nx)];
        const dx = nextX - currentX;
        const dy = nextY - currentY;
        if (vertex === first && dx * start.normal.x + dy * start.normal.y < 0) continue;
        if (next === last && dx * end.normal.x + dy * end.normal.y > 0) continue;
        const direction = dx ? 0 : 1;
        const state = next * 2 + direction;
        const region = this.regions[next];
        const cost = item.cost + Math.abs(dx) + Math.abs(dy) + (direction === item.state % 2 ? 0 : 24)
          + this.traffic[next] + (region >= 0 && region !== sourceRegion && region !== targetRegion ? 160 : 0);
        if (cost >= distance[state]) continue;
        distance[state] = cost;
        previous[state] = item.state;
        heap.push({ state, cost, priority: cost + Math.abs(nextX - end.lead.x) + Math.abs(nextY - end.lead.y) });
      }
    }
    return undefined;
  }

  clear(port: Port, owner: string): boolean {
    const segment = {
      x: Math.min(port.anchor.x, port.lead.x) - 0.01,
      y: Math.min(port.anchor.y, port.lead.y) - 0.01,
      width: Math.abs(port.anchor.x - port.lead.x) + 0.02,
      height: Math.abs(port.anchor.y - port.lead.y) + 0.02,
    };
    return !this.obstacles.some(box => box.owner !== owner && overlaps(segment, box));
  }
}

function labelOnRoute(edge: PositionedEdge, blocked: Box[], measure: MeasureText): void {
  if (!edge.edge.label) return;
  const lines = wrapText(edge.edge.label, 128, EDGE_FONT_SIZE, measure);
  const width = Math.max(...lines.map(line => measure(line, EDGE_FONT_SIZE))) + 10;
  const height = lines.length * EDGE_LINE_HEIGHT + 4;
  const segments = edge.paths.flatMap(points => points.slice(1).map((b, index) => ({ a: points[index], b })));
  segments.sort((a, b) => (Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y)) - Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y));
  for (const offset of [0, 1, -1]) for (const { a, b } of segments) {
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const vertical = a.x === b.x;
      const box = {
        x: a.x + (b.x - a.x) * t - width / 2 + (vertical ? offset * (width / 2 + 5) : 0),
        y: a.y + (b.y - a.y) * t - height / 2 + (vertical ? 0 : offset * (height / 2 + 5)),
        width, height,
      };
      if (box.x < 4 || box.y < 48 || blocked.some(obstacle => overlaps(expand(box, 3), obstacle))) continue;
      edge.label = { ...box, lines };
      blocked.push(box);
      return;
    }
  }
  throw new Error(`No clear label position was found for "${edge.edge.label}".`);
}

export function routeConnections(layout: DiagramLayout, measure: MeasureText): void {
  if (!layout.structure.crossLinks.length) return;
  const entities = new Map<string, Box>([
    ...layout.nodes.map(node => [node.node.id, node] as const),
    ...layout.groups.map(group => [group.group.id, group] as const),
  ]);
  const entityPorts = new Map<string, Map<string, Port[]>>();
  for (const [id, box] of entities) {
    const links = layout.structure.crossLinks.filter(link => link.edge.source === id || link.edge.target === id);
    const orders = [0, 1, 2, 3].map(side => [...links].sort((a, b) => {
      const otherA = entities.get(a.edge.source === id ? a.edge.target : a.edge.source)!;
      const otherB = entities.get(b.edge.source === id ? b.edge.target : b.edge.source)!;
      return (side < 2 ? otherA.y + otherA.height / 2 - otherB.y - otherB.height / 2
        : otherA.x + otherA.width / 2 - otherB.x - otherB.width / 2) || a.number - b.number;
    }));
    entityPorts.set(id, new Map(links.map(link => [
      link.edge.id, ports(box, orders.map(order => order.indexOf(link)), links.length),
    ])));
  }
  const obstacles: Obstacle[] = [
    ...layout.nodes.map(node => ({ ...expand(node, 6), owner: node.node.id })),
    ...layout.groups.filter(group => group.depth >= 0).map(group => ({
      x: group.x, y: group.y, width: group.width, height: 16 + group.lines.length * 19, owner: group.group.id,
    })),
    ...layout.sections.map(section => ({
      x: section.x, y: section.y, width: section.width, height: section.headerHeight - 3,
    })),
    ...layout.edges.flatMap(edge => edge.label ? [expand(edge.label, 3)] : []),
  ];
  const router = new GridRouter(layout, obstacles, [...entityPorts.values()].flatMap(values => [...values.values()].flat()));
  const blockedLabels: Box[] = [
    ...obstacles,
    ...layout.groups.flatMap(group => lineBoxes(border(group), 3)),
    ...layout.edges.flatMap(edge => edge.paths.flatMap(path => lineBoxes(path, 2))),
  ];
  for (const link of layout.structure.crossLinks) {
    if (!entities.has(link.edge.source) || !entities.has(link.edge.target)) throw new Error('A cross-section connection has no endpoint.');
    const sourceSection = layout.sections.find(section => section.section.id === link.sourceSection)!;
    const targetSection = layout.sections.find(section => section.section.id === link.targetSection)!;
    const horizontal = sourceSection.x !== targetSection.x;
    const forward = horizontal ? targetSection.x > sourceSection.x : targetSection.y > sourceSection.y;
    const first = horizontal ? (forward ? 0 : 1) : (forward ? 2 : 3);
    const opposite = first ^ 1;
    const from = entityPorts.get(link.edge.source)!.get(link.edge.id)!;
    const to = entityPorts.get(link.edge.target)!.get(link.edge.id)!;
    const pairs = [[first, opposite], [first, horizontal ? 3 : 1], [horizontal ? 2 : 0, opposite],
      [horizontal ? 3 : 1, opposite], [opposite, first]];
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      if (!pairs.some(pair => pair[0] === a && pair[1] === b)) pairs.push([a, b]);
    }
    let points: Point[] | undefined;
    for (const [a, b] of pairs) {
      if (!router.clear(from[a], link.edge.source) || !router.clear(to[b], link.edge.target)) continue;
      points = router.route(from[a], to[b], link.sourceSection, link.targetSection);
      if (points) break;
    }
    if (!points) throw new Error(`Could not route "${link.edge.source}" to "${link.edge.target}" without crossing a node.`);
    const sourceNode = layout.nodes.find(node => node.node.id === link.edge.source);
    const targetNode = layout.nodes.find(node => node.node.id === link.edge.target);
    if (sourceNode) clipRoute(points, sourceNode, true);
    if (targetNode) clipRoute(points, targetNode, false);
    const edge: PositionedEdge = { edge: link.edge, paths: [points], sectionId: link.sourceSection, crossSection: true };
    labelOnRoute(edge, blockedLabels, measure);
    if (edge.label) {
      layout.width = Math.max(layout.width, edge.label.x + edge.label.width + 12);
      layout.height = Math.max(layout.height, edge.label.y + edge.label.height + 12);
      router.addLabel(edge.label);
    }
    layout.edges.push(edge);
    router.reserve(points);
    blockedLabels.push(...lineBoxes(points, 2));
  }
}
