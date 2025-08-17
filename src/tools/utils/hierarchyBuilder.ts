/**
 * Hierarchy builder for recursive call hierarchy analysis
 * Core logic for building multi-level call trees
 */

import * as vscode from 'vscode';
import { HierarchyNode, HierarchyTreeOptions, BuilderStats, CallHierarchyItem } from '../types/hierarchy';
import { CircularDetector, createCircularDetector } from './circularDetector';

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
    // Import necessary modules
    const { searchWorkspaceSymbols, getDocumentSymbols } = await import('./symbolProvider');
    const vscode = await import('vscode');
    
    // Log to output channel
    const outputChannel = vscode.window.createOutputChannel('LSP MCP');
    outputChannel.appendLine(`[hierarchyTree] Finding symbol: ${symbolName}`);
    
    // Try to find symbol by location first if provided
    if (symbolLocation) {
      outputChannel.appendLine(`[hierarchyTree] Using symbolLocation: ${symbolLocation.filePath}:${symbolLocation.line}`);
      
      try {
        // Convert file path to URI
        const fileUri = vscode.Uri.file(symbolLocation.filePath);
        
        // Open the document
        const document = await vscode.workspace.openTextDocument(fileUri);
        
        // Get document symbols
        const docSymbols = await getDocumentSymbols(document);
        
        if (docSymbols && docSymbols.length > 0) {
          // Find symbols at or near the specified line
          const linePosition = new vscode.Position(symbolLocation.line - 1, 0); // Convert to 0-based
          
          // Find symbols that contain this line
          const symbolsAtLine = this.findSymbolsAtLine(docSymbols, linePosition);
          
          if (symbolsAtLine.length > 0) {
            outputChannel.appendLine(`[hierarchyTree] Found ${symbolsAtLine.length} symbols at line ${symbolLocation.line}`);
            
            // Convert to CallHierarchyItems
            const items: CallHierarchyItem[] = [];
            
            for (const symbol of symbolsAtLine) {
              // Create a SymbolInformation from DocumentSymbol
              const symbolInfo = new vscode.SymbolInformation(
                symbol.name,
                symbol.kind,
                symbol.detail || '',
                new vscode.Location(fileUri, symbol.range)
              );
              
              items.push(this.symbolToCallHierarchyItem(symbolInfo));
            }
            
            // If we found symbols by location, return them
            if (items.length > 0) {
              return items;
            }
          }
        }
        
        outputChannel.appendLine(`[hierarchyTree] No symbols found at location, falling back to name search`);
      } catch (error) {
        outputChannel.appendLine(`[hierarchyTree] Error finding symbol by location: ${error}`);
        // Continue with name-based search as fallback
      }
    }
    
    // Fallback to name-based search
    outputChannel.appendLine(`[hierarchyTree] Searching for symbol by name: ${symbolName}`);
    
    // Use the same symbol search logic as callHierarchy tool
    const searchQuery = symbolName.includes('.') ? symbolName.split('.').pop()! : symbolName;
    const workspaceSymbols = await searchWorkspaceSymbols(searchQuery);

    if (!workspaceSymbols || workspaceSymbols.length === 0) {
      outputChannel.appendLine(`[hierarchyTree] No symbols found with name: ${searchQuery}`);
      return [];
    }

    // Filter symbols to find exact matches (same logic as callHierarchy)
    let matchingSymbols = workspaceSymbols.filter((s) => {
      // Match exact name or name with parentheses
      const nameMatches =
        s.name === searchQuery ||
        s.name.startsWith(searchQuery + '(') ||
        (symbolName.includes('.') && s.containerName === symbolName.split('.')[0]);

      return nameMatches;
    });

    // Prioritize non-method symbols when no container is specified
    if (!symbolName.includes('.') && matchingSymbols.length > 1) {
      const standaloneSymbols = matchingSymbols.filter((s) => !s.containerName);
      if (standaloneSymbols.length > 0) {
        matchingSymbols = standaloneSymbols;
      }
    }

    const items: CallHierarchyItem[] = [];
    
    for (const symbol of matchingSymbols) {
      items.push(this.symbolToCallHierarchyItem(symbol));
    }

    outputChannel.appendLine(`[hierarchyTree] Found ${items.length} symbols by name`);
    return items;
  }
  
  /**
   * Find symbols at a specific line in document
   */
  private findSymbolsAtLine(symbols: vscode.DocumentSymbol[], position: vscode.Position): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    
    for (const symbol of symbols) {
      // Check if this symbol contains the position
      if (symbol.range.contains(position)) {
        result.push(symbol);
        
        // Also check children recursively
        if (symbol.children && symbol.children.length > 0) {
          const childMatches = this.findSymbolsAtLine(symbol.children, position);
          result.push(...childMatches);
        }
      }
    }
    
    return result;
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