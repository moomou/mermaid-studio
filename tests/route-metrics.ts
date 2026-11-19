import type { CurvePath, Point } from '../src/model.ts';

export interface RouteMetrics {
  length: number;
  sharpJoins: number;
  segments: number;
  maxJoinAngle: number;
}

export function curveMetrics(paths: CurvePath[]): RouteMetrics {
  const result = { length: 0, sharpJoins: 0, segments: 0, maxJoinAngle: 0 };
  const length = (point: Point) => Math.hypot(point.x, point.y);
  const vector = (a: Point, b: Point) => ({ x: b.x - a.x, y: b.y - a.y });
  for (const path of paths) {
    let start = path.start;
    let incoming: Point | undefined;
    for (const segment of path.segments) {
      const outgoing = [segment.control1, segment.control2, segment.end].map(point => vector(start, point)).find(point => length(point) > 1e-6);
      if (incoming && outgoing) {
        const angle = Math.acos(Math.max(-1, Math.min(1, (incoming.x * outgoing.x + incoming.y * outgoing.y) / length(incoming) / length(outgoing)))) * 180 / Math.PI;
        result.maxJoinAngle = Math.max(result.maxJoinAngle, angle);
        if (angle > 1) result.sharpJoins++;
      }
      let previous = start;
      for (let step = 1; step <= 32; step++) {
        const t = step / 32;
        const point = {
          x: (1 - t) ** 3 * start.x + 3 * (1 - t) ** 2 * t * segment.control1.x
            + 3 * (1 - t) * t ** 2 * segment.control2.x + t ** 3 * segment.end.x,
          y: (1 - t) ** 3 * start.y + 3 * (1 - t) ** 2 * t * segment.control1.y
            + 3 * (1 - t) * t ** 2 * segment.control2.y + t ** 3 * segment.end.y,
        };
        result.length += length(vector(previous, point));
        previous = point;
      }
      if (outgoing) {
        incoming = [segment.control2, segment.control1, start].map(point => vector(point, segment.end)).find(point => length(point) > 1e-6);
        result.segments++;
      }
      start = segment.end;
    }
  }
  return result;
}
