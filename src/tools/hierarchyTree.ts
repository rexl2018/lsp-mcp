/**
 * HierarchyTree Tool - Multi-level call hierarchy analysis with Mermaid output
 * Extends callHierarchy tool with recursive analysis and visualization
 */

import { 
  HierarchyTreeOptions, 
  HierarchyTreeResult, 
  HierarchyNode,
  MermaidGeneratorOptions 
} from './types/hierarchy';
import { createHierarchyTreeBuilder, countNodes } from './utils/hierarchyBuilder';
import { createMermaidGenerator } from './utils/mermaidGenerator';
import { Tool } from './types';

/**
 * HierarchyTree tool implementation
 */
export const hierarchyTreeTool: Tool = {
  name: 'hierarchyTree',
  description: 'Build multi-level call hierarchy tree and generate Mermaid visualization. Supports recursive analysis of function call relationships with circular reference detection.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Function/method name to analyze (e.g., "calculateSum", "Calculator.multiply")'
      },
      direction: {
        type: 'string',
        enum: ['incoming', 'outgoing', 'both'],
        description: 'Call direction: incoming (who calls it), outgoing (what it calls), both (bidirectional)',
        default: 'incoming'
      },
      depth: {
        type: 'number',
        description: 'Maximum recursion depth (1-20)',
        default: 5,
        minimum: 1,
        maximum: 20
      },
      includeDetails: {
        type: 'boolean',
        description: 'Include file paths and line numbers in the graph',
        default: false
      },
      maxNodes: {
        type: 'number',
        description: 'Maximum number of nodes to prevent oversized graphs',
        default: 50,
        minimum: 5,
        maximum: 200
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description: 'Output format: compact for efficiency, detailed for full information',
        default: 'compact'
      }
    },
    required: ['symbol']
  },

  async handler(args: any): Promise<HierarchyTreeResult> {
    try {
      // Validate and normalize input
      const options = validateAndNormalizeOptions(args);
      
      // Create builder and generate hierarchy
      const builder = createHierarchyTreeBuilder();
      const hierarchyNodes = await builder.buildTree(options);
      
      if (hierarchyNodes.length === 0) {
        return {
          mermaidGraph: '',
          metadata: {
            totalNodes: 0,
            maxDepthReached: 0,
            hasCircularReferences: false,
            skippedNodes: 0
          },
          error: `No hierarchy found for symbol '${options.symbol}'`,
          suggestion: 'Check if the symbol exists and is accessible in the current workspace'
        };
      }
      
      // Generate Mermaid graph
      const mermaidGenerator = createMermaidGenerator();
      const mermaidOptions: MermaidGeneratorOptions = {
        includeDetails: options.includeDetails,
        direction: options.direction,
        maxLabelLength: options.includeDetails ? 80 : 50
      };
      
      const mermaidGraph = mermaidGenerator.generateGraph(hierarchyNodes, mermaidOptions);
      
      // Collect statistics
      const stats = builder.getStats();
      const totalNodes = countNodes(hierarchyNodes);
      const maxDepthReached = builder.getMaxDepthReached(hierarchyNodes);
      
      const result: HierarchyTreeResult = {
        mermaidGraph,
        metadata: {
          totalNodes,
          maxDepthReached,
          hasCircularReferences: stats.circularReferences.length > 0,
          skippedNodes: Math.max(0, stats.nodesProcessed - totalNodes)
        }
      };
      
      // Add detailed information if requested
      if (args.format === 'detailed') {
        result.metadata = {
          ...result.metadata,
          processingTime: stats.processingTime,
          apiCalls: stats.apiCalls,
          circularReferencesCount: stats.circularReferences.length
        } as any;
      }
      
      return result;
      
    } catch (error) {
      return {
        mermaidGraph: '',
        metadata: {
          totalNodes: 0,
          maxDepthReached: 0,
          hasCircularReferences: false,
          skippedNodes: 0
        },
        error: `Failed to build hierarchy tree: ${error instanceof Error ? error.message : String(error)}`,
        suggestion: getSuggestionForError(error)
      };
    }
  }
};

/**
 * Validate and normalize input options
 */
function validateAndNormalizeOptions(args: any): HierarchyTreeOptions {
  if (!args.symbol || typeof args.symbol !== 'string') {
    throw new Error('Symbol parameter is required and must be a string');
  }
  
  const options: HierarchyTreeOptions = {
    symbol: args.symbol.trim(),
    direction: args.direction || 'incoming',
    depth: Math.min(Math.max(args.depth || 5, 1), 50),
    uri: args.uri,
    includeDetails: Boolean(args.includeDetails),
    maxNodes: Math.min(Math.max(args.maxNodes || 50, 8), 200)
  };
  
  // Validate direction
  if (!['incoming', 'outgoing', 'both'].includes(options.direction)) {
    throw new Error('Direction must be one of: incoming, outgoing, both');
  }
  
  // Validate URI format if provided
  if (options.uri && !isValidUri(options.uri)) {
    throw new Error('Invalid URI format');
  }
  
  return options;
}

/**
 * Check if URI is valid
 */
function isValidUri(uri: string): boolean {
  try {
    new URL(uri);
    return true;
  } catch {
    // Try as file path
    return uri.includes('/') || uri.includes('\\');
  }
}

/**
 * Get suggestion based on error type
 */
function getSuggestionForError(error: any): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  if (errorMessage.includes('not found')) {
    return 'Try using a more specific symbol name or check if the symbol exists in the current workspace';
  }
  
  if (errorMessage.includes('timeout')) {
    return 'Try reducing the depth or maxNodes parameters to speed up analysis';
  }
  
  if (errorMessage.includes('circular')) {
    return 'Circular references detected. The analysis stopped to prevent infinite loops';
  }
  
  if (errorMessage.includes('limit')) {
    return 'Node limit reached. Try increasing maxNodes or reducing depth for more complete analysis';
  }
  
  return 'Check the symbol name and ensure the workspace contains the target code';
}

/**
 * Utility function to create a simple hierarchy tree
 */
export async function createSimpleHierarchyTree(
  symbol: string,
  depth: number = 5,
  direction: 'incoming' | 'outgoing' | 'both' = 'incoming'
): Promise<string> {
  const result = await hierarchyTreeTool.handler({
    symbol,
    depth,
    direction,
    includeDetails: false,
    maxNodes: 50
  });
  
  if (result.error) {
    throw new Error(result.error);
  }
  
  return result.mermaidGraph;
}

/**
 * Utility function to create a detailed hierarchy tree
 */
export async function createDetailedHierarchyTree(
  symbol: string,
  depth: number = 8,
  direction: 'incoming' | 'outgoing' | 'both' = 'incoming'
): Promise<HierarchyTreeResult> {
  return await hierarchyTreeTool.handler({
    symbol,
    depth,
    direction,
    includeDetails: true,
    maxNodes: 100,
    format: 'detailed'
  });
}

/**
 * Check if a symbol exists in the workspace
 */
export async function symbolExists(symbol: string, uri?: string): Promise<boolean> {
  try {
    const result = await hierarchyTreeTool.handler({
      symbol,
      depth: 1,
      maxNodes: 1,
      uri
    });
    
    return !result.error && result.metadata.totalNodes > 0;
  } catch {
    return false;
  }
}

/**
 * Get quick statistics about a symbol's call hierarchy
 */
export async function getHierarchyStats(
  symbol: string,
  depth: number = 2
): Promise<{
  exists: boolean;
  totalCalls: number;
  maxDepth: number;
  hasCircularRefs: boolean;
}> {
  try {
    const result = await hierarchyTreeTool.handler({
      symbol,
      depth,
      direction: 'both',
      maxNodes: 50
    });
    
    return {
      exists: !result.error,
      totalCalls: result.metadata.totalNodes,
      maxDepth: result.metadata.maxDepthReached,
      hasCircularRefs: result.metadata.hasCircularReferences
    };
  } catch {
    return {
      exists: false,
      totalCalls: 0,
      maxDepth: 0,
      hasCircularRefs: false
    };
  }
}