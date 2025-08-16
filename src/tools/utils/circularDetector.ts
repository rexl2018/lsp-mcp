/**
 * Circular reference detection for HierarchyTree tool
 * Prevents infinite recursion in call hierarchy analysis
 */

import { HierarchyNode, CircularReference } from '../types/hierarchy';

export class CircularDetector {
  private visitedNodes = new Set<string>();
  private nodeStack: string[] = [];
  private circularReferences: CircularReference[] = [];

  /**
   * Generate unique identifier for a node
   */
  private generateNodeId(node: HierarchyNode): string {
    return `${node.name}:${node.file}:${node.line}`;
  }

  /**
   * Check if a node has been visited (creates circular reference)
   */
  isCircular(node: HierarchyNode): boolean {
    const nodeId = this.generateNodeId(node);
    return this.visitedNodes.has(nodeId);
  }

  /**
   * Mark a node as visited and add to current path
   */
  markVisited(node: HierarchyNode): void {
    const nodeId = this.generateNodeId(node);
    
    if (this.visitedNodes.has(nodeId)) {
      // Record circular reference
      const circularRef: CircularReference = {
        node,
        path: [...this.nodeStack, nodeId]
      };
      this.circularReferences.push(circularRef);
      return;
    }

    this.visitedNodes.add(nodeId);
    this.nodeStack.push(nodeId);
    node.visited = true;
  }

  /**
   * Remove a node from current path (when backtracking)
   */
  unmarkVisited(node: HierarchyNode): void {
    const nodeId = this.generateNodeId(node);
    const index = this.nodeStack.indexOf(nodeId);
    if (index !== -1) {
      this.nodeStack.splice(index, 1);
    }
  }

  /**
   * Check if we're currently in a path to this node (immediate circular reference)
   */
  isInCurrentPath(node: HierarchyNode): boolean {
    const nodeId = this.generateNodeId(node);
    return this.nodeStack.includes(nodeId);
  }

  /**
   * Get all detected circular references
   */
  getCircularReferences(): CircularReference[] {
    return [...this.circularReferences];
  }

  /**
   * Check if any circular references were detected
   */
  hasCircularReferences(): boolean {
    return this.circularReferences.length > 0;
  }

  /**
   * Get current path as string for debugging
   */
  getCurrentPath(): string {
    return this.nodeStack.join(' -> ');
  }

  /**
   * Reset detector state for new analysis
   */
  reset(): void {
    this.visitedNodes.clear();
    this.nodeStack = [];
    this.circularReferences = [];
  }

  /**
   * Get statistics about visited nodes
   */
  getStats() {
    return {
      totalVisited: this.visitedNodes.size,
      currentDepth: this.nodeStack.length,
      circularReferencesFound: this.circularReferences.length
    };
  }

  /**
   * Create a safe copy of a node for circular reference tracking
   */
  createSafeNodeCopy(node: HierarchyNode): HierarchyNode {
    return {
      ...node,
      children: [], // Don't copy children to avoid deep copying
      visited: false
    };
  }

  /**
   * Validate that a path doesn't contain immediate cycles
   */
  validatePath(path: string[]): boolean {
    const seen = new Set<string>();
    for (const nodeId of path) {
      if (seen.has(nodeId)) {
        return false; // Found duplicate in path
      }
      seen.add(nodeId);
    }
    return true;
  }

  /**
   * Find the shortest circular path if one exists
   */
  findShortestCircularPath(startNode: HierarchyNode): string[] | null {
    const nodeId = this.generateNodeId(startNode);
    
    for (const circularRef of this.circularReferences) {
      const refNodeId = this.generateNodeId(circularRef.node);
      if (refNodeId === nodeId) {
        return circularRef.path;
      }
    }
    
    return null;
  }
}

/**
 * Utility function to create a new circular detector instance
 */
export function createCircularDetector(): CircularDetector {
  return new CircularDetector();
}

/**
 * Check if two nodes represent the same symbol location
 */
export function isSameNode(node1: HierarchyNode, node2: HierarchyNode): boolean {
  return (
    node1.name === node2.name &&
    node1.file === node2.file &&
    node1.line === node2.line
  );
}

/**
 * Generate a human-readable description of a circular reference
 */
export function describeCircularReference(circularRef: CircularReference): string {
  const { node, path } = circularRef;
  return `Circular reference detected: ${node.name} (${node.file}:${node.line}) creates cycle in path: ${path.join(' -> ')}`;
}