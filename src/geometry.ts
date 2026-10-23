import type { Box, Point, PositionedNode, Shape } from './model.ts';

export function alignPorts(points: Point[]): Point[] {
  // Compound ELK ports are rounded independently. Remove their subpixel offsets
  // before intersecting the route with a node's actual outline.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (Math.abs(a.x - b.x) <= 1) b.x = a.x;
    else if (Math.abs(a.y - b.y) <= 1) b.y = a.y;
  }
  return points;
}

export function nodePolygon(shape: Shape, box: Box): Point[] | undefined {
  const { x, y, width: w, height: h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (shape) {
    case 'diamond': return [{ x: cx, y }, { x: x + w, y: cy }, { x: cx, y: y + h }, { x, y: cy }];
    case 'hexagon': return [{ x: x + 18, y }, { x: x + w - 18, y }, { x: x + w, y: cy },
      { x: x + w - 18, y: y + h }, { x: x + 18, y: y + h }, { x, y: cy }];
    case 'trapezoid': return [{ x: x + 18, y }, { x: x + w - 18, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    case 'inv_trapezoid': return [{ x, y }, { x: x + w, y }, { x: x + w - 18, y: y + h }, { x: x + 18, y: y + h }];
    case 'lean_right': return [{ x: x + 16, y }, { x: x + w, y }, { x: x + w - 16, y: y + h }, { x, y: y + h }];
    case 'lean_left': return [{ x, y }, { x: x + w - 16, y }, { x: x + w, y: y + h }, { x: x + 16, y: y + h }];
    case 'odd': return [{ x: x + 16, y }, { x: x + w, y }, { x: x + w, y: y + h },
      { x: x + 16, y: y + h }, { x, y: cy }];
    default: return undefined;
  }
}

// ELK routes to rectangular bounds. Extend only the final, orthogonal segment
// to the actual polygon/ellipse, rather than leaving arrows floating in its corners.
export function clipRoute(points: Point[], node: PositionedNode, start: boolean): void {
  if (points.length < 2) return;
  const index = start ? 0 : points.length - 1;
  const point = points[index];
  const previous = points[start ? 1 : points.length - 2];
  const vertical = Math.abs(previous.x - point.x) < 0.001;
  const forward = vertical ? point.y > previous.y : point.x > previous.x;
  const { x, y, width, height } = node;
  const polygon = nodePolygon(node.node.shape, node);
  let intersections: number[] = [];
  if (polygon) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const denominator = vertical ? b.x - a.x : b.y - a.y;
      if (Math.abs(denominator) < 0.001) continue;
      const t = ((vertical ? point.x : point.y) - (vertical ? a.x : a.y)) / denominator;
      if (t < 0 || t > 1) continue;
      intersections.push(vertical ? a.y + t * (b.y - a.y) : a.x + t * (b.x - a.x));
    }
  } else if (node.node.shape === 'circle' || node.node.shape === 'doublecircle' || node.node.shape === 'ellipse') {
    const ratio = vertical ? (point.x - x - width / 2) / (width / 2) : (point.y - y - height / 2) / (height / 2);
    const delta = Math.sqrt(Math.max(0, 1 - ratio * ratio)) * (vertical ? height / 2 : width / 2);
    const center = vertical ? y + height / 2 : x + width / 2;
    intersections = [center - delta, center + delta];
  }
  if (!intersections.length) return;
  const position = forward ? Math.min(...intersections) : Math.max(...intersections);
  points[index] = vertical ? { x: point.x, y: position } : { x: position, y: point.y };
}
