/**
 * Hierarchy builder for recursive call hierarchy analysis
 * Core logic for building multi-level call trees
 */

import * as vscode from 'vscode';
import { findSymbols } from './symbolFinder';
import { HierarchyNode, HierarchyTreeOptions, BuilderStats, CallHierarchyItem } from '../types/hierarchy';
import { CircularDetector, createCircularDetector } from './circularDetector';
import { matchesAnyPattern } from './pathMatcher';
import { outputChannelService } from '../../services/outputChannelService';

export class HierarchyTreeBuilder {
  private circularDetector: CircularDetector;
  private stats: BuilderStats;
  private startTime: number;
  private _callHierarchyCache = new Map<string, CallHierarchyItem[]>();

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
    const logger = outputChannelService.getLspMcpChannel();
    logger.appendLine(`\n[HierarchyTree] Building tree for symbol '${options.symbol}', direction: ${options.direction}, depth: ${options.depth}`);
    if (options.symbolLocation) {
      const column = options.symbolLocation.column !== undefined ? options.symbolLocation.column : 0;
      logger.appendLine(`[HierarchyTree] Using symbol location: ${options.symbolLocation.filePath}:${options.symbolLocation.line}:${column}`);
    }
    
    this.reset();
    this.startTime = Date.now();

    try {
      // 直接使用vscode.prepareCallHierarchy获取初始CallHierarchyItem
      // 这是唯一一次调用prepareCallHierarchy
      logger.appendLine(`[HierarchyTree] Finding root symbol '${options.symbol}'...`);
      
      let rootCallHierarchyItems: vscode.CallHierarchyItem[] = [];
      
      if (options.symbolLocation) {
        const uri = vscode.Uri.file(options.symbolLocation.filePath);
        const column = options.symbolLocation.column !== undefined ? options.symbolLocation.column : 0;
        const position = new vscode.Position(options.symbolLocation.line - 1, column);
        
        logger.appendLine(`[HierarchyTree] Using direct position approach at ${options.symbolLocation.filePath}:${options.symbolLocation.line}:${column}`);
        
        // 直接使用vscode.prepareCallHierarchy命令获取CallHierarchyItem
        rootCallHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy',
          uri,
          position
        ) || [];
      }
      
      // 如果没有找到，尝试使用符号搜索
      if (rootCallHierarchyItems.length === 0) {
        logger.appendLine(`[HierarchyTree] No call hierarchy items found directly, falling back to symbol search`);
        const symbols = await findSymbols(options.symbol, options.symbolLocation);
        if (symbols.length > 0) {
          // 对于每个找到的符号，尝试获取CallHierarchyItem
          for (const symbol of symbols) {
            const uri = symbol.location.uri;
            const position = new vscode.Position(
              symbol.location.range.start.line,
              symbol.location.range.start.character
            );
            
            const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
              'vscode.prepareCallHierarchy',
              uri,
              position
            ) || [];
            
            if (items.length > 0) {
              rootCallHierarchyItems = rootCallHierarchyItems.concat(items);
            }
          }
        }
      }
      
      logger.appendLine(`[HierarchyTree] Found ${rootCallHierarchyItems.length} root items for '${options.symbol}'`);
      
      if (rootCallHierarchyItems.length === 0) {
        logger.appendLine(`[HierarchyTree] ERROR: Symbol '${options.symbol}' not found`);
        throw new Error(`Symbol '${options.symbol}' not found`);
      }

      const rootNodes: HierarchyNode[] = [];

      // 处理每个根项（可能有多个匹配项）
      for (const rootItem of rootCallHierarchyItems.slice(0, 3)) { // 限制为3个根匹配项
        logger.appendLine(`[HierarchyTree] Processing root item: ${rootItem.name} at ${rootItem.uri}:${rootItem.range.start.line}:${rootItem.range.start.character}`);
        
        // 创建根节点
        const rootNode = this.createNodeFromVSCodeItem(rootItem, 0);
        logger.appendLine(`[HierarchyTree] Created root node: ${rootNode.name} at ${rootNode.file}:${rootNode.line}:${rootNode.character}`);
        
        if (options.direction === 'both') {
          // 处理两个方向
          logger.appendLine(`[HierarchyTree] Building both directions for ${rootNode.name}...`);
          
          // 创建两个方向的选项
          const incomingOptions = { ...options, direction: 'incoming' as const };
          const outgoingOptions = { ...options, direction: 'outgoing' as const };
          
          // 构建传入调用
          logger.appendLine(`[HierarchyTree] Building incoming calls for ${rootNode.name}...`);
          await this.recursiveBuild(rootItem, rootNode, incomingOptions, 0);
          
          // 重置循环检测器
          this.circularDetector.reset();
          
          // 构建传出调用
          logger.appendLine(`[HierarchyTree] Building outgoing calls for ${rootNode.name}...`);
          await this.recursiveBuild(rootItem, rootNode, outgoingOptions, 0);
        } else {
          // 处理单个方向
          logger.appendLine(`[HierarchyTree] Building ${options.direction} calls for ${rootNode.name}...`);
          await this.recursiveBuild(rootItem, rootNode, options, 0);
        }
        
        logger.appendLine(`[HierarchyTree] Root node ${rootNode.name} has ${rootNode.children.length} direct children`);
        rootNodes.push(rootNode);
        
        // 检查节点限制
        if (this.stats.nodesProcessed >= options.maxNodes) {
          logger.appendLine(`[HierarchyTree] Reached node limit (${options.maxNodes}), stopping processing`);
          break;
        }
      }

      this.stats.processingTime = Date.now() - this.startTime;
      this.stats.circularReferences = this.circularDetector.getCircularReferences();

      logger.appendLine(`[HierarchyTree] Tree building completed in ${this.stats.processingTime}ms`);
      logger.appendLine(`[HierarchyTree] Total nodes: ${this.stats.nodesProcessed}, API calls: ${this.stats.apiCalls}, Circular references: ${this.stats.circularReferences.length}`);
      
      return rootNodes;
    } catch (error) {
      this.stats.processingTime = Date.now() - this.startTime;
      logger.appendLine(`[HierarchyTree] ERROR: Failed to build tree: ${error}`);
      if (error instanceof Error && error.stack) {
        logger.appendLine(`[HierarchyTree] Stack trace: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Recursive hierarchy building
   */
  private async recursiveBuild(
    vscodeItem: vscode.CallHierarchyItem, // 接受VSCode的CallHierarchyItem作为参数
    node: HierarchyNode,                 // 对应的HierarchyNode
    options: HierarchyTreeOptions,
    currentDepth: number
  ): Promise<void> {
    const logger = outputChannelService.getLspMcpChannel();
    logger.appendLine(`[HierarchyTree] Building level ${currentDepth} for ${node.name} at ${node.file}:${node.line}:${node.character}`);
    
    // 检查深度限制
    if (currentDepth >= options.depth) {
      logger.appendLine(`[HierarchyTree] Reached depth limit (${options.depth}), stopping recursion for ${node.name}`);
      return;
    }

    // 检查节点数量限制
    if (this.stats.nodesProcessed >= options.maxNodes) {
      logger.appendLine(`[HierarchyTree] Reached node limit (${options.maxNodes}), stopping recursion for ${node.name}`);
      return;
    }

    // 检查循环引用
    if (this.circularDetector.isCircular(node)) {
      logger.appendLine(`[HierarchyTree] Detected circular reference for ${node.name}, stopping recursion`);
      return;
    }

    // 检查是否应该基于skipPaths跳过节点
    if (options.skipPaths && options.skipPaths.length > 0) {
      if (matchesAnyPattern(node.file, options.skipPaths)) {
        logger.appendLine(`[HierarchyTree] Skipping node ${node.name} at ${node.file} due to skipPaths match`);
        return;
      }
    }

    // 标记节点为已访问
    this.circularDetector.markVisited(node);
    this.stats.nodesProcessed++;
    logger.appendLine(`[HierarchyTree] Processing node ${node.name}, total processed: ${this.stats.nodesProcessed}`);

    try {
      // 直接使用VSCode API获取调用，就像call-graph一样
      // 这里不再调用getCallHierarchy方法，而是直接使用vscode.provideIncomingCalls或vscode.provideOutgoingCalls
      const command = options.direction === 'incoming' 
        ? 'vscode.provideIncomingCalls'
        : 'vscode.provideOutgoingCalls';
      
      logger.appendLine(`[HierarchyTree] Executing ${command} for ${node.name}...`);
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | vscode.CallHierarchyOutgoingCall[]>(
        command,
        vscodeItem // 直接使用传入的VSCode CallHierarchyItem
      ) || [];
      
      this.stats.apiCalls++;
      logger.appendLine(`[HierarchyTree] ${command} returned ${calls.length} calls`);

      // 使用Map来缓存已处理的节点，避免重复处理
      const processedNodes = new Map<string, { node: HierarchyNode, item: vscode.CallHierarchyItem }>();
      
      // 处理所有调用
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        const nextItem = options.direction === 'incoming' 
          ? (call as vscode.CallHierarchyIncomingCall).from
          : (call as vscode.CallHierarchyOutgoingCall).to;
        
        // 检查是否应该跳过
        if (options.skipPaths && options.skipPaths.length > 0) {
          if (matchesAnyPattern(nextItem.uri.toString(), options.skipPaths)) {
            logger.appendLine(`[HierarchyTree] Skipping child node ${nextItem.name} at ${nextItem.uri} due to skipPaths match`);
            continue;
          }
        }
        
        logger.appendLine(`[HierarchyTree] Processing call item ${index+1}/${calls.length}: ${nextItem.name} at ${nextItem.uri}:${nextItem.range.start.line}:${nextItem.range.start.character}`);
        
        // 检查节点限制
        if (this.stats.nodesProcessed >= options.maxNodes) {
          logger.appendLine(`[HierarchyTree] Reached node limit (${options.maxNodes}) during child processing, stopping`);
          break;
        }
        
        // 创建唯一标识符
        const nodeKey = `${nextItem.name}:${nextItem.uri}:${nextItem.range.start.line}:${nextItem.range.start.character}`;
        
        // 检查是否已经处理过这个节点
        if (processedNodes.has(nodeKey)) {
          logger.appendLine(`[HierarchyTree] Reusing already processed node: ${nextItem.name}`);
          const existing = processedNodes.get(nodeKey)!;
          node.children.push(existing.node);
          continue;
        }
        
        // 创建子节点
        const childNode = this.createNodeFromVSCodeItem(nextItem, currentDepth + 1);
        logger.appendLine(`[HierarchyTree] Created child node: ${childNode.name} at ${childNode.file}:${childNode.line}:${childNode.character}`);
        
        // 缓存节点
        processedNodes.set(nodeKey, { node: childNode, item: nextItem });
        
        // 检查是否会创建循环引用
        if (this.circularDetector.isInCurrentPath(childNode)) {
          logger.appendLine(`[HierarchyTree] Detected circular reference for child ${childNode.name}, skipping recursion`);
          continue;
        }
        
        // 添加到父节点的子节点列表
        node.children.push(childNode);
        logger.appendLine(`[HierarchyTree] Added child ${childNode.name} to ${node.name}, now recursing...`);
        
        // 递归构建子节点的层级
        await this.recursiveBuild(nextItem, childNode, options, currentDepth + 1);
      }
      
      logger.appendLine(`[HierarchyTree] Completed processing all ${calls.length} calls for ${node.name}`);
    } catch (error) {
      logger.appendLine(`[HierarchyTree] ERROR during recursive build for ${node.name}: ${error}`);
      if (error instanceof Error && error.stack) {
        logger.appendLine(`[HierarchyTree] Stack trace: ${error.stack}`);
      }
    } finally {
      // 回溯时取消标记节点
      this.circularDetector.unmarkVisited(node);
      logger.appendLine(`[HierarchyTree] Unmarked node ${node.name} as visited (backtracking)`);
    }
  }

  // 移除findSymbol和getCallHierarchy方法，因为它们的逻辑已经移到buildTree和recursiveBuild方法中



  /**
   * Create hierarchy node from VSCode CallHierarchyItem
   * 直接从VSCode的CallHierarchyItem创建我们的HierarchyNode
   */
  private createNodeFromVSCodeItem(item: vscode.CallHierarchyItem, level: number): HierarchyNode {
    return {
      id: `${item.name}:${item.uri}:${item.range.start.line}:${item.range.start.character}`,
      name: item.name,
      kind: vscode.SymbolKind[item.kind], // 转换SymbolKind为字符串
      file: item.uri.toString(),
      line: item.range.start.line + 1, // 转为1-based
      character: item.range.start.character,
      level,
      children: [],
      visited: false
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
    this._callHierarchyCache.clear(); // 清除缓存
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