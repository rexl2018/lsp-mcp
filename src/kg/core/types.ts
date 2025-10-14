export type NodeType =
  | 'File'
  | 'Class'
  | 'Interface'
  | 'Method'
  | 'Function'
  | 'Variable'
  | 'Enum'
  | 'Namespace'
  | 'Module'
  | 'Package'
  | 'Type'
  | 'Struct'
  | 'Func'
  | 'Map'
  | 'Slice'
  | 'Channel';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Node {
  id: string;
  type: NodeType;
  name: string;
  filePath: string;
  range?: Range;
  detail?: string;
  description?: string;
  tags?: string[];
  createTime: number;
  updateTime: number;
}

export type EdgeType =
  | 'DEFINES'
  | 'CONTAINS'
  | 'REFERENCES'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'IMPORTS'
  | 'EXPORTS';

export interface Edge {
  type: EdgeType;
  from: string;
  to: string;
  filePath?: string;
  range?: Range;
  description?: string;
  tags?: string[];
  createTime: number;
  updateTime: number;
}

export interface GraphJSON {
  nodes: Node[];
  edges: Edge[];
}