/**
 * Mermaid graph generator for HierarchyTree tool
 * Converts hierarchy data into Mermaid diagram format
 */

import { HierarchyNode, HierarchyDirection, MermaidGeneratorOptions, MermaidNodeStyle } from '../types/hierarchy';

export class MermaidGenerator {
  private nodeDefinitions = new Set<string>();
  private connections = new Set<string>();
  private nodeCounter = 0;
  private nodeIdMap = new Map<string, string>();

  /**
   * Generate Mermaid graph from hierarchy nodes
   */
  generateGraph(
    nodes: HierarchyNode[],
    options: MermaidGeneratorOptions
  ): string {
    this.reset();
    
    const lines = ['graph TD'];
    
    // Add graph styling
    this.addGraphStyling(lines, options);
    
    // Process all nodes
    this.processNodes(nodes, lines, options);
    
    // Add node definitions
    this.addNodeDefinitions(lines);
    
    // Add connections
    this.addConnections(lines);
    
    return lines.join('\n');
  }

  /**
   * Process hierarchy nodes recursively
   */
  private processNodes(
    nodes: HierarchyNode[],
    lines: string[],
    options: MermaidGeneratorOptions
  ): void {
    for (const node of nodes) {
      const nodeId = this.getOrCreateNodeId(node);
      const nodeLabel = this.createNodeLabel(node, options);
      
      // Add node definition
      this.nodeDefinitions.add(`    ${nodeId}["${nodeLabel}"]`);
      
      // Process children and create connections
      for (const child of node.children) {
        const childId = this.getOrCreateNodeId(child);
        const childLabel = this.createNodeLabel(child, options);
        
        // Add child node definition
        this.nodeDefinitions.add(`    ${childId}["${childLabel}"]`);
        
        // Create connection based on direction
        const connection = this.createConnection(nodeId, childId, options.direction);
        this.connections.add(connection);
      }
      
      // Recursively process children
      this.processNodes(node.children, lines, options);
    }
  }

  /**
   * Create a unique node ID
   */
  private getOrCreateNodeId(node: HierarchyNode): string {
    const nodeKey = `${node.name}:${node.file}:${node.line}`;
    
    if (!this.nodeIdMap.has(nodeKey)) {
      const nodeId = `node${this.nodeCounter++}`;
      this.nodeIdMap.set(nodeKey, nodeId);
    }
    
    return this.nodeIdMap.get(nodeKey)!;
  }

  /**
   * Create node label with optional details
   */
  private createNodeLabel(node: HierarchyNode, options: MermaidGeneratorOptions): string {
    let label = this.sanitizeLabel(node.name);
    
    if (options.includeDetails) {
      const fileName = this.getFileName(node.file);
      label += `<br/>${fileName}:${node.line}`;
    }
    
    // Truncate if too long
    if (options.maxLabelLength && label.length > options.maxLabelLength) {
      label = label.substring(0, options.maxLabelLength - 3) + '...';
    }
    
    return label;
  }

  /**
   * Create connection between nodes
   */
  private createConnection(
    fromId: string,
    toId: string,
    direction: HierarchyDirection
  ): string {
    switch (direction) {
      case 'incoming':
        return `    ${toId} --> ${fromId}`;
      case 'outgoing':
        return `    ${fromId} --> ${toId}`;
      case 'both':
        return `    ${fromId} <--> ${toId}`;
      default:
        return `    ${fromId} --> ${toId}`;
    }
  }

  /**
   * Add graph styling
   */
  private addGraphStyling(lines: string[], options: MermaidGeneratorOptions): void {
    // Add title comment
    lines.push('    %% Call Hierarchy Tree');
    lines.push('');
    
    // Add custom styling if provided
    if (options.nodeStyle) {
      this.addNodeStyling(lines, options.nodeStyle);
    }
  }

  /**
   * Add node styling definitions
   */
  private addNodeStyling(lines: string[], style: MermaidNodeStyle): void {
    const styleLines = [];
    
    if (style.color) {
      styleLines.push(`fill:${style.color}`);
    }
    
    if (style.textColor) {
      styleLines.push(`color:${style.textColor}`);
    }
    
    if (style.borderStyle) {
      const borderMap = {
        solid: 'stroke-width:2px',
        dashed: 'stroke-dasharray: 5 5',
        dotted: 'stroke-dasharray: 2 2'
      };
      styleLines.push(borderMap[style.borderStyle]);
    }
    
    if (styleLines.length > 0) {
      lines.push(`    classDef default ${styleLines.join(',')};`);
      lines.push('');
    }
  }

  /**
   * Add node definitions to the graph
   */
  private addNodeDefinitions(lines: string[]): void {
    if (this.nodeDefinitions.size > 0) {
      lines.push('    %% Node definitions');
      this.nodeDefinitions.forEach(def => lines.push(def));
      lines.push('');
    }
  }

  /**
   * Add connections to the graph
   */
  private addConnections(lines: string[]): void {
    if (this.connections.size > 0) {
      lines.push('    %% Connections');
      this.connections.forEach(conn => lines.push(conn));
    }
  }

  /**
   * Sanitize label for Mermaid format
   */
  private sanitizeLabel(label: string): string {
    return label
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/&/g, '&amp;');
  }

  /**
   * Extract filename from full path
   */
  private getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  /**
   * Reset generator state
   */
  private reset(): void {
    this.nodeDefinitions.clear();
    this.connections.clear();
    this.nodeCounter = 0;
    this.nodeIdMap.clear();
  }

  /**
   * Get statistics about the generated graph
   */
  getStats() {
    return {
      nodeCount: this.nodeDefinitions.size,
      connectionCount: this.connections.size,
      uniqueNodes: this.nodeIdMap.size
    };
  }
}

/**
 * Utility function to create a new Mermaid generator
 */
export function createMermaidGenerator(): MermaidGenerator {
  return new MermaidGenerator();
}

/**
 * Generate a simple Mermaid graph from hierarchy nodes
 */
export function generateSimpleMermaidGraph(
  nodes: HierarchyNode[],
  direction: HierarchyDirection = 'incoming'
): string {
  const generator = new MermaidGenerator();
  const options: MermaidGeneratorOptions = {
    includeDetails: false,
    direction,
    maxLabelLength: 50
  };
  
  return generator.generateGraph(nodes, options);
}

/**
 * Generate a detailed Mermaid graph with file information
 */
export function generateDetailedMermaidGraph(
  nodes: HierarchyNode[],
  direction: HierarchyDirection = 'incoming'
): string {
  const generator = new MermaidGenerator();
  const options: MermaidGeneratorOptions = {
    includeDetails: true,
    direction,
    maxLabelLength: 80,
    nodeStyle: {
      shape: 'rounded',
      color: '#f9f9f9',
      textColor: '#333',
      borderStyle: 'solid'
    }
  };
  
  return generator.generateGraph(nodes, options);
}

/**
 * Validate Mermaid graph syntax (basic validation)
 */
export function validateMermaidGraph(graph: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const lines = graph.split('\n');
  
  // Check for required graph declaration
  if (!lines.some(line => line.trim().startsWith('graph'))) {
    errors.push('Missing graph declaration');
  }
  
  // Check for balanced brackets in node definitions
  for (const line of lines) {
    const openBrackets = (line.match(/\[/g) || []).length;
    const closeBrackets = (line.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      errors.push(`Unbalanced brackets in line: ${line.trim()}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}