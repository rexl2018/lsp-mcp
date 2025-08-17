/**
 * Types for HierarchyTree tool - multi-level call hierarchy analysis
 */

export interface HierarchyNode {
  /** Unique identifier for the node */
  id: string;
  /** Function/method name */
  name: string;
  /** Symbol kind (function, method, class, etc.) */
  kind: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Character number */
  character: number;
  /** Hierarchy level depth */
  level: number;
  /** Child nodes */
  children: HierarchyNode[];
  /** Whether this node has been visited (for circular detection) */
  visited: boolean;
}

export interface HierarchyTreeOptions {
  /** Symbol to analyze */
  symbol: string;
  /** Call direction */
  direction: 'incoming' | 'outgoing' | 'both';
  /** Maximum recursion depth */
  depth: number;

  /** Optional symbol location (file path, line number and column) */
  symbolLocation?: {
    /** File path where the symbol is located */
    filePath: string;
    /** Line number (1-based) where the symbol is located */
    line: number;
    /** Column number (0-based) where the symbol is located */
    column?: number;
  };
  /** Include detailed information in output */
  includeDetails: boolean;
  /** Maximum number of nodes to prevent oversized graphs */
  maxNodes: number;
  /** Paths to skip (glob patterns similar to .gitignore) */
  skipPaths?: string[];
}

export interface HierarchyTreeResult {
  /** Generated Mermaid graph string */
  mermaidGraph: string;
  /** Metadata about the analysis */
  metadata: {
    /** Total number of nodes in the tree */
    totalNodes: number;
    /** Maximum depth reached */
    maxDepthReached: number;
    /** Whether circular references were detected */
    hasCircularReferences: boolean;
    /** Number of nodes that were skipped due to limits */
    skippedNodes: number;
  };
  /** Error message if analysis failed */
  error?: string;
  /** Suggestion for resolving errors */
  suggestion?: string;
}

export interface CallHierarchyItem {
  /** Symbol name */
  name: string;
  /** Symbol kind */
  kind: string;
  /** File URI */
  uri: string;
  /** Range in the file */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** Selection range */
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface CircularReference {
  /** Node that creates the circular reference */
  node: HierarchyNode;
  /** Path to the circular reference */
  path: string[];
}

export interface BuilderStats {
  /** Number of nodes processed */
  nodesProcessed: number;
  /** Number of API calls made */
  apiCalls: number;
  /** Processing time in milliseconds */
  processingTime: number;
  /** Circular references found */
  circularReferences: CircularReference[];
}

export type HierarchyDirection = 'incoming' | 'outgoing' | 'both';

export interface MermaidNodeStyle {
  /** Node shape */
  shape: 'rectangle' | 'rounded' | 'circle' | 'diamond';
  /** Node color */
  color?: string;
  /** Text color */
  textColor?: string;
  /** Border style */
  borderStyle?: 'solid' | 'dashed' | 'dotted';
}

export interface MermaidGeneratorOptions {
  /** Include file details in node labels */
  includeDetails: boolean;
  /** Graph direction */
  direction: HierarchyDirection;
  /** Custom node styling */
  nodeStyle?: MermaidNodeStyle;
  /** Maximum label length */
  maxLabelLength?: number;
}