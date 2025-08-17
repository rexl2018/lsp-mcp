import * as vscode from 'vscode';
import { Tool } from './types';
import { findSymbols, SymbolLocation } from './utils/symbolFinder';
import { createHierarchyTreeBuilder } from './utils/hierarchyBuilder';
import { createMermaidGenerator } from './utils/mermaidGenerator';
import { HierarchyTreeOptions, MermaidGeneratorOptions, HierarchyNode } from './types/hierarchy';
import { outputChannelService } from '../services/outputChannelService';

export const callHierarchyTool: Tool = {
  name: 'callHierarchy',
  description:
    'Find what calls a function or what a function calls by using the function name. Perfect for understanding code flow and dependencies - faster than manually tracing through files',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Name of the function/method to analyze (e.g., "calculateSum", "add", "Calculator.multiply")',
      },
      symbolLocation: {
        type: 'object',
        description: 'Optional location of the symbol (file path, line number and column), used to get more accurate results.',
        properties: {
          filePath: {
            type: 'string',
            description: 'File path where the symbol is located'
          },
          line: {
            type: 'number',
            description: 'Line number (1-based) where the symbol is located'
          },
          column: {
            type: 'number',
            description: 'Column number (0-based) where the symbol is located'
          }
        },
        required: ['filePath', 'line']
      },
      direction: {
        type: 'string',
        enum: ['incoming', 'outgoing', 'both'],
        description:
          'Get incoming calls (who calls this), outgoing calls (what this calls), or both',
        default: 'incoming',
      },

      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: ['symbol', 'direction'],
  },
  handler: async (args) => {
    const { symbol, direction = 'incoming', format = 'compact', symbolLocation } = args;
    const logger = outputChannelService.getLspMcpChannel();
    
    logger.appendLine(`[callHierarchy] Starting call hierarchy analysis for symbol '${symbol}', direction: ${direction}`);
    if (symbolLocation) {
      logger.appendLine(`[callHierarchy] Using symbol location: ${symbolLocation.filePath}:${symbolLocation.line}`);
    }
    
    try {
      // 使用hierarchyTree的实现，但设置depth=1
      const options: HierarchyTreeOptions = {
        symbol,
        direction,
        depth: 1, // 只获取一层调用关系
        includeDetails: format === 'detailed',
        maxNodes: 100 // 设置一个合理的最大节点数
      };
      
      // 添加symbolLocation如果提供了
      if (symbolLocation) {
        options.symbolLocation = symbolLocation;
      }
      
      // 使用hierarchyBuilder来构建调用层级
      logger.appendLine(`[callHierarchy] Using hierarchyBuilder with depth=1`);
      const builder = createHierarchyTreeBuilder();
      const hierarchyNodes = await builder.buildTree(options);
      
      if (hierarchyNodes.length === 0) {
        return {
          symbol,
          message: 'Symbol found but no call hierarchy available',
          hint: 'This might be an unused function or the language server needs more time to index'
        };
      }
      
      // 转换hierarchyNodes为callHierarchy格式
      const results: any[] = [];
      
      for (const rootNode of hierarchyNodes) {
        const result: any = format === 'compact' 
          ? {
              symbol: [
                rootNode.name,
                rootNode.kind.toLowerCase(),
                rootNode.file,
                rootNode.line
              ],
              calls: []
            }
          : {
              symbol: {
                name: rootNode.name,
                kind: rootNode.kind,
                file: rootNode.file,
                line: rootNode.line
              },
              calls: []
            };
        
        // 处理子节点（直接调用关系）
        for (const childNode of rootNode.children) {
          // 确定调用方向
          const callType = direction === 'incoming' ? 'incoming' : 'outgoing';
          
          if (format === 'compact') {
            result.calls.push([
              callType,
              childNode.name,
              childNode.kind.toLowerCase(),
              childNode.file,
              childNode.line,
              [[childNode.line, childNode.character]]
            ]);
          } else {
            result.calls.push({
              type: callType,
              [callType === 'incoming' ? 'from' : 'to']: {
                name: childNode.name,
                kind: childNode.kind,
                file: childNode.file,
                line: childNode.line
              },
              locations: [{
                line: childNode.line,
                character: childNode.character,
                preview: `${childNode.file}:${childNode.line}`
              }]
            });
          }
        }
        
        results.push(result);
      }

      // 生成Mermaid图表
      const mermaidGenerator = createMermaidGenerator();
      const mermaidOptions: MermaidGeneratorOptions = {
        includeDetails: format === 'detailed',
        direction: direction,
        maxLabelLength: format === 'detailed' ? 80 : 50
      };
      
      const mermaidGraph = mermaidGenerator.generateGraph(hierarchyNodes, mermaidOptions);
      
      // 计算统计信息
      const stats = builder.getStats();
      const totalNodes = hierarchyNodes.reduce((count, node) => {
         let nodeCount = 1; // 根节点
         const countChildren = (n: HierarchyNode) => {
           nodeCount += n.children.length;
           n.children.forEach(countChildren);
         };
         node.children.forEach(countChildren);
         return count + nodeCount;
       }, 0);
      
      const maxDepthReached = builder.getMaxDepthReached(hierarchyNodes);
      
      // 返回结果
      if (results.length === 0) {
        return {
          symbol: symbol,
          message: 'Symbol found but no call hierarchy available',
          hint: 'This might be an unused function or the language server needs more time to index'
        };
      } else if (results.length === 1) {
        // 对于单个匹配，返回简化格式和Mermaid图表
        if (format === 'compact' && results[0].calls.length > 0) {
          return {
            ...results[0],
            callFormat: '[direction, name, kind, filePath, line, locations]',
            locationFormat: '[line, column]',
            mermaidGraph,
            metadata: {
              totalNodes,
              maxDepthReached,
              hasCircularReferences: stats.circularReferences?.length > 0,
              skippedNodes: Math.max(0, stats.nodesProcessed - totalNodes)
            }
          };
        }
        return {
          ...results[0],
          mermaidGraph,
          metadata: {
            totalNodes,
            maxDepthReached,
            hasCircularReferences: stats.circularReferences?.length > 0,
            skippedNodes: Math.max(0, stats.nodesProcessed - totalNodes)
          }
        };
      } else {
        // 对于多个匹配，返回所有结果和Mermaid图表
        if (format === 'compact') {
          return {
            symbol: symbol,
            multipleMatches: true,
            callFormat: '[direction, name, kind, filePath, line, locations]',
            locationFormat: '[line, column]',
            matches: results,
            summary: {
              totalMatches: results.length,
              totalCalls: results.reduce((sum, r) => sum + r.calls.length, 0),
            },
            mermaidGraph,
            metadata: {
              totalNodes,
              maxDepthReached,
              hasCircularReferences: stats.circularReferences?.length > 0,
              skippedNodes: Math.max(0, stats.nodesProcessed - totalNodes)
            }
          };
        } else {
          return {
            symbol: symbol,
            multipleMatches: true,
            matches: results,
            summary: {
              totalMatches: results.length,
              totalCalls: results.reduce((sum, r) => sum + r.calls.length, 0),
            },
            mermaidGraph,
            metadata: {
              totalNodes,
              maxDepthReached,
              hasCircularReferences: stats.circularReferences?.length > 0,
              skippedNodes: Math.max(0, stats.nodesProcessed - totalNodes)
            }
          };
        }
      }
    } catch (error) {
      logger.appendLine(`[callHierarchy] ERROR: ${error}`);
      return {
        symbol: symbol,
        error: `Failed to get call hierarchy: ${error instanceof Error ? error.message : String(error)}`,
        suggestion: 'Try providing a more specific symbolLocation or check if the symbol exists in the workspace',
      };
    }
  },
};
