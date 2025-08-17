/**
 * Hierarchy builder for recursive call hierarchy analysis
 * Core logic for building multi-level call trees
 */

import * as vscode from 'vscode';
import { findSymbols } from './symbolFinder';
import { HierarchyNode, HierarchyTreeOptions, BuilderStats, CallHierarchyItem } from '../types/hierarchy';
import { CircularDetector, createCircularDetector } from './circularDetector';
import { matchesAnyPattern } from './pathMatcher';

export class HierarchyTreeBuilder {
  private circularDetector: CircularDetector;
  private stats: BuilderStats;
  private startTime: number;

  constructor() {
    this.circularDetector = createCircularDetector();
    this.stats = {
      nodesProcessed: 0,
      apiCalls: 0,
      processingTime: 0,
      circularReferences: []
    };
    this.startTime = Date.now();
  }

  /**
   * Build hierarchy tree from root symbol
   */
  async buildTree(options: HierarchyTreeOptions): Promise<HierarchyNode[]> {
    this.reset();
    this.startTime = Date.now();

    try {
      // Find the root symbol
      const rootItems = await this.findSymbol(options.symbol, options.symbolLocation);
      if (rootItems.length === 0) {
        throw new Error(`Symbol '${options.symbol}' not found`);
      }

      const rootNodes: HierarchyNode[] = [];

      // Process each root item (there might be multiple matches)
      for (const rootItem of rootItems.slice(0, 3)) { // Limit to 3 root matches
        const rootNode = this.createNodeFromItem(rootItem, 0);
        
        if (options.direction === 'both') {
          // Handle both directions
          await this.buildBothDirections(rootNode, options);
        } else {
          // Handle single direction
          await this.recursiveBuild(rootNode, options, 0);
        }
        
        rootNodes.push(rootNode);
        
        // Check node limit
        if (this.stats.nodesProcessed >= options.maxNodes) {
          break;
        }
      }

      this.stats.processingTime = Date.now() - this.startTime;
      this.stats.circularReferences = this.circularDetector.getCircularReferences();

      return rootNodes;
    } catch (error) {
      this.stats.processingTime = Date.now() - this.startTime;
      throw error;
    }
  }

  /**
   * Build hierarchy in both directions
   */
  private async buildBothDirections(
    rootNode: HierarchyNode,
    options: HierarchyTreeOptions
  ): Promise<void> {
    // Create separate options for each direction
    const incomingOptions = { ...options, direction: 'incoming' as const };
    const outgoingOptions = { ...options, direction: 'outgoing' as const };

    // Build incoming calls
    await this.recursiveBuild(rootNode, incomingOptions, 0);
    
    // Reset circular detector for outgoing calls
    this.circularDetector.reset();
    
    // Build outgoing calls
    await this.recursiveBuild(rootNode, outgoingOptions, 0);
  }

  /**
   * Recursive hierarchy building
   */
  private async recursiveBuild(
    node: HierarchyNode,
    options: HierarchyTreeOptions,
    currentDepth: number
  ): Promise<void> {
    // Check depth limit
    if (currentDepth >= options.depth) {
      return;
    }

    // Check node count limit
    if (this.stats.nodesProcessed >= options.maxNodes) {
      return;
    }

    // Check for circular reference
    if (this.circularDetector.isCircular(node)) {
      return;
    }

    // Check if node should be skipped based on skipPaths
    if (options.skipPaths && options.skipPaths.length > 0) {
      if (matchesAnyPattern(node.file, options.skipPaths)) {
        console.log(`[HierarchyTree] Skipping node ${node.name} at ${node.file} due to skipPaths match`);
        return;
      }
    }

    // Mark node as visited
    this.circularDetector.markVisited(node);
    this.stats.nodesProcessed++;

    try {
      // Get call hierarchy for this node
      const callItems = await this.getCallHierarchy(node, options.direction);
      this.stats.apiCalls++;

      // Process each call item
      for (const callItem of callItems) {
        // Check limits again
        if (this.stats.nodesProcessed >= options.maxNodes) {
          break;
        }

        const childNode = this.createNodeFromItem(callItem, currentDepth + 1);
        
        // Check if this node should be skipped based on skipPaths
        if (options.skipPaths && options.skipPaths.length > 0) {
          if (matchesAnyPattern(childNode.file, options.skipPaths)) {
            console.log(`[HierarchyTree] Skipping child node ${childNode.name} at ${childNode.file} due to skipPaths match`);
            continue;
          }
        }
        
        // Check if this would create a circular reference
        if (!this.circularDetector.isInCurrentPath(childNode)) {
          node.children.push(childNode);
          
          // Recursively build child hierarchy
          await this.recursiveBuild(childNode, options, currentDepth + 1);
        }
      }
    } finally {
      // Unmark node when backtracking
      this.circularDetector.unmarkVisited(node);
    }
  }

  /**
   * Find symbol in workspace
   */
  private async findSymbol(symbolName: string, symbolLocation?: { filePath: string, line: number }): Promise<CallHierarchyItem[]> {
    const symbols = await findSymbols(symbolName, symbolLocation);
    return symbols.map(s => this.symbolToCallHierarchyItem(s));
  }

  /**
   * Get call hierarchy for a node
   */
  private async getCallHierarchy(
    node: HierarchyNode,
    direction: 'incoming' | 'outgoing' | 'both'
  ): Promise<CallHierarchyItem[]> {
    // Handle 'both' direction by combining results
    if (direction === 'both') {
      const [incoming, outgoing] = await Promise.all([
        this.getCallHierarchy(node, 'incoming'),
        this.getCallHierarchy(node, 'outgoing')
      ]);
      return [...incoming, ...outgoing];
    }
    try {
      const uri = vscode.Uri.parse(node.file);
      
      // Open document to get precise position
      const document = await vscode.workspace.openTextDocument(uri);
      const line = document.lineAt(node.line - 1);
      const lineText = line.text;
      
      // Extract function name without parentheses for search
      const searchQuery = node.name.replace(/\(.*\)$/, '');
      const symbolStartChar = lineText.indexOf(searchQuery);
      
      let position: vscode.Position;
      if (symbolStartChar !== -1) {
        // Position cursor in the middle of the symbol name for better results
        position = new vscode.Position(
          node.line - 1,
          symbolStartChar + Math.floor(searchQuery.length / 2)
        );
      } else {
        // Fallback to start position
        position = new vscode.Position(node.line - 1, 0);
      }

      console.error(`[HierarchyTree] Getting ${direction} calls for ${node.name} at ${node.file}:${node.line}, position: ${position.line}:${position.character}`);

      // Prepare call hierarchy
      const callHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        uri,
        position
      );

      console.error(`[HierarchyTree] prepareCallHierarchy returned ${callHierarchyItems?.length || 0} items`);
      if (callHierarchyItems && callHierarchyItems.length > 0) {
        console.error(`[HierarchyTree] First item:`, callHierarchyItems[0]);
      }

      if (!callHierarchyItems || callHierarchyItems.length === 0) {
        console.error(`[HierarchyTree] No call hierarchy items found for ${node.name}`);
        return [];
      }

      // Get incoming or outgoing calls
      const command = direction === 'incoming' 
        ? 'vscode.provideIncomingCalls'
        : 'vscode.provideOutgoingCalls';

      console.error(`[HierarchyTree] Executing ${command}`);
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | vscode.CallHierarchyOutgoingCall[]>(
        command,
        callHierarchyItems[0]
      );

      console.error(`[HierarchyTree] ${command} returned ${calls?.length || 0} calls`);
      if (calls && calls.length > 0) {
        console.error(`[HierarchyTree] First call:`, calls[0]);
      }

      if (!calls) {
        return [];
      }

      // Convert to our format
      const result = calls.map(call => {
        const item = direction === 'incoming' 
          ? (call as vscode.CallHierarchyIncomingCall).from
          : (call as vscode.CallHierarchyOutgoingCall).to;
        return this.vscodeItemToCallHierarchyItem(item);
      });

      console.log(`[HierarchyTree] Converted ${result.length} calls to CallHierarchyItem format`);
      return result;
    } catch (error) {
      console.warn(`Failed to get call hierarchy for ${node.name}:`, error);
      return [];
    }
  }

  /**
   * Create hierarchy node from call hierarchy item
   */
  private createNodeFromItem(item: CallHierarchyItem, level: number): HierarchyNode {
    return {
      id: `${item.name}:${item.uri}:${item.range.start.line}`,
      name: item.name,
      kind: item.kind,
      file: item.uri,
      line: item.range.start.line + 1, // Convert to 1-based
      level,
      children: [],
      visited: false
    };
  }

  /**
   * Convert VSCode SymbolInformation to CallHierarchyItem
   */
  private symbolToCallHierarchyItem(symbol: vscode.SymbolInformation): CallHierarchyItem {
    return {
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind],
      uri: symbol.location.uri.toString(),
      range: {
        start: {
          line: symbol.location.range.start.line,
          character: symbol.location.range.start.character
        },
        end: {
          line: symbol.location.range.end.line,
          character: symbol.location.range.end.character
        }
      },
      selectionRange: {
        start: {
          line: symbol.location.range.start.line,
          character: symbol.location.range.start.character
        },
        end: {
          line: symbol.location.range.end.line,
          character: symbol.location.range.end.character
        }
      }
    };
  }

  /**
   * Convert VSCode CallHierarchyItem to our format
   */
  private vscodeItemToCallHierarchyItem(item: vscode.CallHierarchyItem): CallHierarchyItem {
    return {
      name: item.name,
      kind: vscode.SymbolKind[item.kind],
      uri: item.uri.toString(),
      range: {
        start: {
          line: item.range.start.line,
          character: item.range.start.character
        },
        end: {
          line: item.range.end.line,
          character: item.range.end.character
        }
      },
      selectionRange: {
        start: {
          line: item.selectionRange.start.line,
          character: item.selectionRange.start.character
        },
        end: {
          line: item.selectionRange.end.line,
          character: item.selectionRange.end.character
        }
      }
    };
  }

  /**
   * Get builder statistics
   */
  getStats(): BuilderStats {
    return {
      ...this.stats,
      processingTime: Date.now() - this.startTime
    };
  }

  /**
   * Reset builder state
   */
  private reset(): void {
    this.circularDetector.reset();
    this.stats = {
      nodesProcessed: 0,
      apiCalls: 0,
      processingTime: 0,
      circularReferences: []
    };
  }

  /**
   * Check if builder has reached limits
   */
  hasReachedLimits(maxNodes: number): boolean {
    return this.stats.nodesProcessed >= maxNodes;
  }

  /**
   * Get maximum depth reached in the tree
   */
  getMaxDepthReached(nodes: HierarchyNode[]): number {
    let maxDepth = 0;
    
    const traverse = (node: HierarchyNode) => {
      maxDepth = Math.max(maxDepth, node.level);
      for (const child of node.children) {
        traverse(child);
      }
    };
    
    for (const node of nodes) {
      traverse(node);
    }
    
    return maxDepth;
  }
}

/**
 * Create a new hierarchy tree builder
 */
export function createHierarchyTreeBuilder(): HierarchyTreeBuilder {
  return new HierarchyTreeBuilder();
}

/**
 * Count total nodes in hierarchy tree
 */
export function countNodes(nodes: HierarchyNode[]): number {
  let count = 0;
  
  const traverse = (node: HierarchyNode) => {
    count++;
    for (const child of node.children) {
      traverse(child);
    }
  };
  
  for (const node of nodes) {
    traverse(node);
  }
  
  return count;
}

/**
 * Flatten hierarchy tree to array
 */
export function flattenHierarchy(nodes: HierarchyNode[]): HierarchyNode[] {
  const result: HierarchyNode[] = [];
  
  const traverse = (node: HierarchyNode) => {
    result.push(node);
    for (const child of node.children) {
      traverse(child);
    }
  };
  
  for (const node of nodes) {
    traverse(node);
  }
  
  return result;
}