import type { Box, CurvePath, CurveSegment, Point, PositionedNode } from './model.ts';
import { nodePolygon } from './geometry.ts';

export interface Port { point: Point; normal: Point }
export type Side = 'top' | 'right' | 'bottom' | 'left';

export const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
export const advance = (point: Point, normal: Point, amount: number): Point => ({ x: point.x + normal.x * amount, y: point.y + normal.y * amount });

export function shapePort(box: Box, side: Side, node?: PositionedNode, offset = 0): Port {
  const normal = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } }[side];
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const delta = {
    x: normal.x * box.width / 2 + (normal.y ? offset : 0),
    y: normal.y * box.height / 2 + (normal.x ? offset : 0),
  };
  if (node && ['circle', 'doublecircle', 'ellipse'].includes(node.node.shape)) {
    const scale = 1 / Math.sqrt((delta.x / (box.width / 2)) ** 2 + (delta.y / (box.height / 2)) ** 2);
    const point = advance(center, delta, scale);
    const gradient = { x: (point.x - center.x) / box.width ** 2, y: (point.y - center.y) / box.height ** 2 };
    const length = Math.hypot(gradient.x, gradient.y);
    return { point, normal: { x: gradient.x / length, y: gradient.y / length } };
  }
  const polygon = node ? nodePolygon(node.node.shape, box) : undefined;
  if (polygon) for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const edge = { x: b.x - a.x, y: b.y - a.y };
    const denominator = delta.x * edge.y - delta.y * edge.x;
    if (Math.abs(denominator) < 1e-8) continue;
    const relative = { x: a.x - center.x, y: a.y - center.y };
    const t = (relative.x * edge.y - relative.y * edge.x) / denominator;
    const u = (relative.x * delta.y - relative.y * delta.x) / denominator;
    if (t >= 0 && u >= -1e-8 && u <= 1 + 1e-8) {
      if (u > 1e-6 && u < 1 - 1e-6) {
        const length = Math.hypot(edge.x, edge.y);
        const outward = { x: edge.y / length, y: -edge.x / length };
        return { point: advance(center, delta, t), normal: outward };
      }
      return { point: advance(center, delta, t), normal };
    }
  }
  return { point: advance(center, delta, 1), normal };
}

export function lineSegment(start: Point, end: Point): CurveSegment {
  return { control1: mix(start, end, 1 / 3), control2: mix(start, end, 2 / 3), end };
}

export function directCurve(start: Port, end: Port, handle?: number): CurvePath {
  const amount = handle ?? Math.max(20, Math.min(140, distance(start.point, end.point) * 0.4));
  return {
    start: start.point,
    segments: [{ control1: advance(start.point, start.normal, amount), control2: advance(end.point, end.normal, amount), end: end.point }],
  };
}

export function curvePoint(start: Point, segment: CurveSegment, t: number): Point {
  const a = mix(start, segment.control1, t);
  const b = mix(segment.control1, segment.control2, t);
  const c = mix(segment.control2, segment.end, t);
  return mix(mix(a, b, t), mix(b, c, t), t);
}

function split(start: Point, segment: CurveSegment): [CurveSegment, CurveSegment] {
  const a = mix(start, segment.control1, 0.5);
  const b = mix(segment.control1, segment.control2, 0.5);
  const c = mix(segment.control2, segment.end, 0.5);
  const d = mix(a, b, 0.5);
  const e = mix(b, c, 0.5);
  const middle = mix(d, e, 0.5);
  return [{ control1: a, control2: d, end: middle }, { control1: e, control2: c, end: segment.end }];
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / Math.max(1e-12, dx * dx + dy * dy)));
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

export function flattenCurve(path: CurvePath, tolerance = 0.25): Point[] {
  const points = [path.start];
  const visit = (start: Point, segment: CurveSegment, depth: number): void => {
    const flatness = Math.max(pointSegmentDistance(segment.control1, start, segment.end), pointSegmentDistance(segment.control2, start, segment.end));
    if (depth >= 12 || flatness <= tolerance) {
      points.push(segment.end);
      return;
    }
    const [left, right] = split(start, segment);
    visit(start, left, depth + 1);
    visit(left.end, right, depth + 1);
  };
  let start = path.start;
  for (const segment of path.segments) { visit(start, segment, 0); start = segment.end; }
  return points;
}

export function segmentIntersectsBox(a: Point, b: Point, box: Box): boolean {
  let low = 0;
  let high = 1;
  for (const [origin, delta, minimum, maximum] of [
    [a.x, b.x - a.x, box.x, box.x + box.width],
    [a.y, b.y - a.y, box.y, box.y + box.height],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (origin <= minimum || origin >= maximum) return false;
    } else {
      const t0 = (minimum - origin) / delta;
      const t1 = (maximum - origin) / delta;
      low = Math.max(low, Math.min(t0, t1));
      high = Math.min(high, Math.max(t0, t1));
      if (low >= high) return false;
    }
  }
  return high > 1e-6 && low < 1 - 1e-6;
}

export function curveIntersectsBox(path: CurvePath, box: Box): boolean {
  const visit = (start: Point, segment: CurveSegment, depth: number): boolean => {
    const points = [start, segment.control1, segment.control2, segment.end];
    if (Math.max(...points.map(point => point.x)) <= box.x || Math.min(...points.map(point => point.x)) >= box.x + box.width
      || Math.max(...points.map(point => point.y)) <= box.y || Math.min(...points.map(point => point.y)) >= box.y + box.height) return false;
    const flatness = Math.max(pointSegmentDistance(segment.control1, start, segment.end), pointSegmentDistance(segment.control2, start, segment.end));
    if (depth >= 12 || flatness < 0.05) return segmentIntersectsBox(start, segment.end, box);
    const [left, right] = split(start, segment);
    return visit(start, left, depth + 1) || visit(left.end, right, depth + 1);
  };
  let start = path.start;
  for (const segment of path.segments) {
    if (visit(start, segment, 0)) return true;
    start = segment.end;
  }
  return false;
}

export function smoothGuide(input: Point[], obstacles: Box[]): CurvePath {
  const points: Point[] = [];
  for (const point of input) {
    if (points.length && distance(points.at(-1)!, point) < 0.01) continue;
    while (points.length > 1) {
      const a = points.at(-2)!;
      const b = points.at(-1)!;
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      if (Math.abs(cross) > 0.01) break;
      points.pop();
    }
    if (points.length && distance(points.at(-1)!, point) < 0.01) continue;
    points.push(point);
  }
  const path: CurvePath = { start: points[0], segments: [] };
  let previous = points[0];
  for (let index = 1; index + 1 < points.length; index++) {
    const cornerAt = (fraction: number) => {
      const start = mix(points[index], points[index - 1], fraction);
      const end = mix(points[index], points[index + 1], fraction);
      return { start, segment: { control1: mix(start, points[index], 2 / 3), control2: mix(end, points[index], 2 / 3), end } };
    };
    let corner = cornerAt(0.5);
    for (let attempt = 0; attempt < 8 && obstacles.some(box => curveIntersectsBox({ start: corner.start, segments: [corner.segment] }, box)); attempt++) {
      corner = cornerAt(2 ** (-attempt - 2));
    }
    if (distance(previous, corner.start) > 0.01) path.segments.push(lineSegment(previous, corner.start));
    path.segments.push(corner.segment);
    previous = corner.segment.end;
  }
  if (points.length > 1 && distance(previous, points.at(-1)!) > 0.01) path.segments.push(lineSegment(previous, points.at(-1)!));
  return path;
}

export function insideNode(point: Point, node: PositionedNode): boolean {
  const { x, y, width, height } = node;
  if (['circle', 'doublecircle', 'ellipse'].includes(node.node.shape)) {
    return ((point.x - x - width / 2) / Math.max(1, width / 2 - 0.5)) ** 2
      + ((point.y - y - height / 2) / Math.max(1, height / 2 - 0.5)) ** 2 < 1;
  }
  const polygon = nodePolygon(node.node.shape, node);
  if (!polygon) return point.x > x + 0.5 && point.x < x + width - 0.5 && point.y > y + 0.5 && point.y < y + height - 0.5;
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) <= distance(a, b) * 0.5) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

export function curveIntersectsNode(path: CurvePath, node: PositionedNode): boolean {
  const points = flattenCurve(path, 0.02);
  if (points.some(point => insideNode(point, node))) return true;
  const polygon = nodePolygon(node.node.shape, node);
  if (!polygon && !['circle', 'doublecircle', 'ellipse'].includes(node.node.shape)) {
    return points.slice(1).some((point, index) => segmentIntersectsBox(points[index], point, {
      x: node.x + 0.5, y: node.y + 0.5, width: node.width - 1, height: node.height - 1,
    }));
  }
  return false;
}

export function curveCost(path: CurvePath): number {
  const points = flattenCurve(path);
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += distance(points[index - 1], points[index]);
  }
  let sharpness = 0;
  let start = path.start;
  for (const segment of path.segments) {
    const energy = (t: number): number => {
      const u = 1 - t;
      const dx = 3 * u * u * (segment.control1.x - start.x) + 6 * u * t * (segment.control2.x - segment.control1.x) + 3 * t * t * (segment.end.x - segment.control2.x);
      const dy = 3 * u * u * (segment.control1.y - start.y) + 6 * u * t * (segment.control2.y - segment.control1.y) + 3 * t * t * (segment.end.y - segment.control2.y);
      const ddx = 6 * u * (segment.control2.x - 2 * segment.control1.x + start.x) + 6 * t * (segment.end.x - 2 * segment.control2.x + segment.control1.x);
      const ddy = 6 * u * (segment.control2.y - 2 * segment.control1.y + start.y) + 6 * t * (segment.end.y - 2 * segment.control2.y + segment.control1.y);
      const speed2 = dx * dx + dy * dy;
      return speed2 < 1e-10 ? 0 : (dx * ddy - dy * ddx) ** 2 / speed2 ** 2.5;
    };
    const integrate = (a: number, b: number, fa: number, fm: number, fb: number, estimate: number, tolerance: number, depth: number): number => {
      const middle = (a + b) / 2;
      const left = energy((a + middle) / 2);
      const right = energy((middle + b) / 2);
      const l = (middle - a) * (fa + 4 * left + fm) / 6;
      const r = (b - middle) * (fm + 4 * right + fb) / 6;
      if (depth >= 12 || Math.abs(l + r - estimate) < tolerance * 15) return l + r;
      return integrate(a, middle, fa, left, fm, l, tolerance / 2, depth + 1)
        + integrate(middle, b, fm, right, fb, r, tolerance / 2, depth + 1);
    };
    const fa = energy(0);
    const fm = energy(0.5);
    const fb = energy(1);
    sharpness += integrate(0, 1, fa, fm, fb, (fa + 4 * fm + fb) / 6, 0.0001, 0);
    start = segment.end;
  }
  return length + sharpness * 1200;
}

export function curveBounds(path: CurvePath): Box {
  const points = [path.start];
  let start = path.start;
  for (const segment of path.segments) {
    points.push(segment.end);
    for (const axis of ['x', 'y'] as const) {
      const a = -start[axis] + 3 * segment.control1[axis] - 3 * segment.control2[axis] + segment.end[axis];
      const b = 2 * (start[axis] - 2 * segment.control1[axis] + segment.control2[axis]);
      const c = segment.control1[axis] - start[axis];
      const discriminant = b * b - 4 * a * c;
      const roots = Math.abs(a) < 1e-8 ? Math.abs(b) < 1e-8 ? [] : [-c / b]
        : discriminant < 0 ? [] : [(-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a)];
      for (const t of roots) if (t > 0 && t < 1) points.push(curvePoint(start, segment, t));
    }
    start = segment.end;
  }
  const x = Math.min(...points.map(point => point.x));
  const y = Math.min(...points.map(point => point.y));
  return { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y };
}

export function curveData(path: CurvePath): string {
  return `M ${path.start.x} ${path.start.y}${path.segments.map(segment =>
    ` C ${segment.control1.x} ${segment.control1.y} ${segment.control2.x} ${segment.control2.y} ${segment.end.x} ${segment.end.y}`).join('')}`;
}
