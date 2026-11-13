export type Direction = 'TB' | 'BT' | 'LR' | 'RL';
export type Marker = 'none' | 'arrow' | 'circle' | 'cross';
export type Stroke = 'normal' | 'thick' | 'dotted' | 'invisible';
export type Shape =
  | 'rect' | 'round' | 'stadium' | 'diamond' | 'hexagon'
  | 'circle' | 'doublecircle' | 'ellipse' | 'subroutine' | 'cylinder'
  | 'trapezoid' | 'inv_trapezoid' | 'lean_right' | 'lean_left' | 'odd';

export interface Paint {
  fill?: string;
  stroke?: string;
  color?: string;
  strokeWidth?: number;
  dash?: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  shape: Shape;
  parent?: string;
  paint: Paint;
  link?: string;
}

export interface DiagramGroup {
  id: string;
  label: string;
  parent?: string;
  direction?: Direction;
  paint: Paint;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  stroke: Stroke;
  startMarker: Marker;
  endMarker: Marker;
  paint: Paint;
  length: number;
}

export interface FlowGraph {
  kind: 'flowchart';
  title: string;
  description: string;
  direction: Direction;
  background: string;
  nodes: DiagramNode[];
  groups: DiagramGroup[];
  edges: DiagramEdge[];
  warnings: string[];
}

export interface NativeDiagram {
  kind: 'native';
  title: string;
  background: string;
  diagramType: string;
  reason: string;
}

export interface Section {
  id: string;
  index: number;
  label: string;
  inferred: boolean;
  nodeIds: string[];
  groupIds: string[];
}

export interface CrossLink {
  number: number;
  edge: DiagramEdge;
  sourceSection: string;
  targetSection: string;
}

export interface Structure {
  sections: Section[];
  sectionByEntity: Map<string, string>;
  crossLinks: CrossLink[];
}

export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export interface TextLine { text: string; secondary: boolean }

export interface PositionedNode extends Box {
  node: DiagramNode;
  lines: TextLine[];
  sectionId: string;
}

export interface PositionedGroup extends Box {
  group: DiagramGroup;
  sectionId: string;
  lines: string[];
  depth: number;
}

export interface PositionedEdge {
  edge: DiagramEdge;
  paths: Point[][];
  label?: Box & { lines: string[] };
  sectionId: string;
  crossSection?: boolean;
}

export interface PositionedSection extends Box {
  section: Section;
  lines: string[];
  headerHeight: number;
}

export interface DiagramLayout {
  graph: FlowGraph;
  structure: Structure;
  nodes: PositionedNode[];
  groups: PositionedGroup[];
  edges: PositionedEdge[];
  sections: PositionedSection[];
  width: number;
  height: number;
  detail: boolean;
  titleLines: string[];
}
