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
      logger.appendLine(`[HierarchyTree] Using symbol location: ${options.symbolLocation.filePath}:${options.symbolLocation.line}`);
    }
    
    this.reset();
    this.startTime = Date.now();

    try {
      // Find the root symbol
      logger.appendLine(`[HierarchyTree] Finding root symbol '${options.symbol}'...`);
      const rootItems = await this.findSymbol(options.symbol, options.symbolLocation);
      logger.appendLine(`[HierarchyTree] Found ${rootItems.length} root items for '${options.symbol}'`);
      
      if (rootItems.length === 0) {
        logger.appendLine(`[HierarchyTree] ERROR: Symbol '${options.symbol}' not found`);
        throw new Error(`Symbol '${options.symbol}' not found`);
      }

      const rootNodes: HierarchyNode[] = [];

      // Process each root item (there might be multiple matches)
      for (const rootItem of rootItems.slice(0, 3)) { // Limit to 3 root matches
        logger.appendLine(`[HierarchyTree] Processing root item: ${rootItem.name} at ${rootItem.uri}:${rootItem.range.start.line}:${rootItem.range.start.character}`);
        const rootNode = await this.createNodeFromItem(rootItem, 0);
        logger.appendLine(`[HierarchyTree] Created root node: ${rootNode.name} at ${rootNode.file}:${rootNode.line}:${rootNode.character}`);
        
        if (options.direction === 'both') {
          // Handle both directions
          logger.appendLine(`[HierarchyTree] Building both directions for ${rootNode.name}...`);
          await this.buildBothDirections(rootNode, options);
        } else {
          // Handle single direction
          logger.appendLine(`[HierarchyTree] Building ${options.direction} calls for ${rootNode.name}...`);
          await this.recursiveBuild(rootNode, options, 0);
        }
        
        logger.appendLine(`[HierarchyTree] Root node ${rootNode.name} has ${rootNode.children.length} direct children`);
        rootNodes.push(rootNode);
        
        // Check node limit
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
   * Build hierarchy in both directions
   */
  private async buildBothDirections(
    rootNode: HierarchyNode,
    options: HierarchyTreeOptions
  ): Promise<void> {
    const logger = outputChannelService.getLspMcpChannel();
    
    // Create separate options for each direction
    const incomingOptions = { ...options, direction: 'incoming' as const };
    const outgoingOptions = { ...options, direction: 'outgoing' as const };

    // Build incoming calls
    logger.appendLine(`[HierarchyTree] Building incoming calls for ${rootNode.name}...`);
    await this.recursiveBuild(rootNode, incomingOptions, 0);
    
    // Reset circular detector for outgoing calls
    this.circularDetector.reset();
    
    // Build outgoing calls
    logger.appendLine(`[HierarchyTree] Building outgoing calls for ${rootNode.name}...`);
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
    const logger = outputChannelService.getLspMcpChannel();
    logger.appendLine(`[HierarchyTree] Building level ${currentDepth} for ${node.name} at ${node.file}:${node.line}:${node.character}`);
    
    // Check depth limit
    if (currentDepth >= options.depth) {
      logger.appendLine(`[HierarchyTree] Reached depth limit (${options.depth}), stopping recursion for ${node.name}`);
      return;
    }

    // Check node count limit
    if (this.stats.nodesProcessed >= options.maxNodes) {
      logger.appendLine(`[HierarchyTree] Reached node limit (${options.maxNodes}), stopping recursion for ${node.name}`);
      return;
    }

    // Check for circular reference
    if (this.circularDetector.isCircular(node)) {
      logger.appendLine(`[HierarchyTree] Detected circular reference for ${node.name}, stopping recursion`);
      return;
    }

    // Check if node should be skipped based on skipPaths
    if (options.skipPaths && options.skipPaths.length > 0) {
      if (matchesAnyPattern(node.file, options.skipPaths)) {
        logger.appendLine(`[HierarchyTree] Skipping node ${node.name} at ${node.file} due to skipPaths match`);
        return;
      }
    }

    // Mark node as visited
    this.circularDetector.markVisited(node);
    this.stats.nodesProcessed++;
    logger.appendLine(`[HierarchyTree] Processing node ${node.name}, total processed: ${this.stats.nodesProcessed}`);

    try {
      // Get call hierarchy for this node
      logger.appendLine(`[HierarchyTree] Getting ${options.direction} calls for ${node.name}...`);
      const callItems = await this.getCallHierarchy(node, options.direction);
      this.stats.apiCalls++;
      logger.appendLine(`[HierarchyTree] Found ${callItems.length} ${options.direction} calls for ${node.name}`);

      // 使用Map来缓存已处理的节点，避免重复处理
      const processedNodes = new Map<string, HierarchyNode>();
      
      // 过滤掉应该跳过的项
      const filteredCallItems = callItems.filter(callItem => {
        if (options.skipPaths && options.skipPaths.length > 0) {
          if (matchesAnyPattern(callItem.uri, options.skipPaths)) {
            logger.appendLine(`[HierarchyTree] Skipping child node ${callItem.name} at ${callItem.uri} due to skipPaths match`);
            return false;
          }
        }
        return true;
      });
      
      // 并行处理所有子节点创建
      const childNodePromises = filteredCallItems.map(async (callItem, index) => {
        logger.appendLine(`[HierarchyTree] Processing call item ${index+1}/${filteredCallItems.length}: ${callItem.name} at ${callItem.uri}:${callItem.range.start.line}:${callItem.range.start.character}`);
        
        // 检查节点限制
        if (this.stats.nodesProcessed >= options.maxNodes) {
          logger.appendLine(`[HierarchyTree] Reached node limit (${options.maxNodes}) during child processing, stopping`);
          return null;
        }
        
        // 创建唯一标识符
        const nodeKey = `${callItem.name}:${callItem.uri}:${callItem.range.start.line}:${callItem.range.start.character}`;
        
        // 检查是否已经处理过这个节点
        if (processedNodes.has(nodeKey)) {
          logger.appendLine(`[HierarchyTree] Reusing already processed node: ${callItem.name}`);
          return processedNodes.get(nodeKey)!;
        }
        
        const childNode = await this.createNodeFromItem(callItem, currentDepth + 1);
        logger.appendLine(`[HierarchyTree] Created child node: ${childNode.name} at ${childNode.file}:${childNode.line}:${childNode.character}`);
        
        // 缓存节点
        processedNodes.set(nodeKey, childNode);
        
        return childNode;
      });
      
      // 等待所有子节点创建完成
      const childNodes = (await Promise.all(childNodePromises)).filter(node => node !== null) as HierarchyNode[];
      
      // 处理每个子节点
      for (const childNode of childNodes) {
        // 检查是否会创建循环引用
        if (this.circularDetector.isInCurrentPath(childNode)) {
          logger.appendLine(`[HierarchyTree] Detected circular reference for child ${childNode.name}, skipping recursion`);
          continue;
        }
        
        // 添加到父节点的子节点列表
        node.children.push(childNode);
        logger.appendLine(`[HierarchyTree] Added child ${childNode.name} to ${node.name}, now recursing...`);
        
        // 递归构建子节点的层级
        await this.recursiveBuild(childNode, options, currentDepth + 1);
      }
      
      logger.appendLine(`[HierarchyTree] Completed processing all ${filteredCallItems.length} calls for ${node.name}`);
    } catch (error) {
      logger.appendLine(`[HierarchyTree] ERROR during recursive build for ${node.name}: ${error}`);
      if (error instanceof Error && error.stack) {
        logger.appendLine(`[HierarchyTree] Stack trace: ${error.stack}`);
      }
    } finally {
      // Unmark node when backtracking
      this.circularDetector.unmarkVisited(node);
      logger.appendLine(`[HierarchyTree] Unmarked node ${node.name} as visited (backtracking)`);
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
    const logger = outputChannelService.getLspMcpChannel();
    
    // Handle 'both' direction by combining results
    if (direction === 'both') {
      logger.appendLine(`[HierarchyTree] Handling 'both' direction for ${node.name}`);
      const [incoming, outgoing] = await Promise.all([
        this.getCallHierarchy(node, 'incoming'),
        this.getCallHierarchy(node, 'outgoing')
      ]);
      logger.appendLine(`[HierarchyTree] Combined results: ${incoming.length} incoming + ${outgoing.length} outgoing calls`);
      return [...incoming, ...outgoing];
    }
    
    // 使用缓存来避免重复处理相同的节点
    const cacheKey = `${node.name}:${node.file}:${node.line}:${direction}`;
    if (this._callHierarchyCache.has(cacheKey)) {
      logger.appendLine(`[HierarchyTree] Using cached call hierarchy for ${node.name}`);
      return this._callHierarchyCache.get(cacheKey)!;
    }
    
    try {
      const uri = vscode.Uri.parse(node.file);
      
      // 尝试不同的位置策略来获取调用层级
      const document = await vscode.workspace.openTextDocument(uri);
      
      // 策略1: 查找函数定义行
      let targetLine = node.line - 1; // 转为0-based
      let lineText = document.lineAt(targetLine).text;
      
      // 如果当前行是注释或空行，尝试向下查找实际的函数定义
      let maxLinesDown = 5; // 最多向下查找5行
      let linesChecked = 0;
      
      while ((lineText.trim().startsWith('*') || lineText.trim().startsWith('/') || lineText.trim() === '') && 
             linesChecked < maxLinesDown && 
             targetLine + 1 < document.lineCount) {
        targetLine++;
        lineText = document.lineAt(targetLine).text;
        linesChecked++;
      }
      
      // 查找函数名称在行中的位置
      const symbolName = node.name.replace(/\(.*\)$/, '');
      let symbolIndex = lineText.indexOf(symbolName);
      
      // 如果找不到，尝试查找function或async关键字
      if (symbolIndex === -1) {
        const functionIndex = lineText.indexOf('function');
        const asyncIndex = lineText.indexOf('async');
        const classIndex = lineText.indexOf('class');
        const privateIndex = lineText.indexOf('private');
        const publicIndex = lineText.indexOf('public');
        const protectedIndex = lineText.indexOf('protected');
        
        if (functionIndex !== -1) {
          symbolIndex = functionIndex + 'function '.length;
        } else if (asyncIndex !== -1) {
          symbolIndex = asyncIndex + 'async '.length;
        } else if (classIndex !== -1) {
          symbolIndex = classIndex + 'class '.length;
        } else if (privateIndex !== -1) {
          symbolIndex = privateIndex + 'private '.length;
        } else if (publicIndex !== -1) {
          symbolIndex = publicIndex + 'public '.length;
        } else if (protectedIndex !== -1) {
          symbolIndex = protectedIndex + 'protected '.length;
        }
      }
      
      let position: vscode.Position;
      if (symbolIndex !== -1) {
        // 使用找到的位置
        position = new vscode.Position(
          targetLine,
          symbolIndex + Math.floor(symbolName.length / 2)
        );
      } else {
        // 回退策略：使用行的中间位置
        position = new vscode.Position(
          targetLine,
          Math.floor(lineText.length / 2)
        );
      }

      logger.appendLine(`[HierarchyTree] Getting ${direction} calls for ${node.name} at ${node.file}:${node.line}:${node.character}`);
      logger.appendLine(`[HierarchyTree] Position: ${position.line}:${position.character}`);

      // Prepare call hierarchy
      logger.appendLine(`[HierarchyTree] Executing vscode.prepareCallHierarchy...`);
      let callHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        uri,
        position
      );

      logger.appendLine(`[HierarchyTree] prepareCallHierarchy returned ${callHierarchyItems?.length || 0} items`);
      if (callHierarchyItems && callHierarchyItems.length > 0) {
        const item = callHierarchyItems[0];
        logger.appendLine(`[HierarchyTree] First item: ${item.name} at ${item.uri.toString()}:${item.range.start.line}:${item.range.start.character}`);
        logger.appendLine(`[HierarchyTree] Item kind: ${vscode.SymbolKind[item.kind]}, selection range: ${item.selectionRange.start.line}:${item.selectionRange.start.character}-${item.selectionRange.end.line}:${item.selectionRange.end.character}`);
      } else {
        logger.appendLine(`[HierarchyTree] WARNING: prepareCallHierarchy returned no items. This might indicate a problem with the language server or the position.`);
        // 尝试打开文档并显示内容，以便调试
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          const lineText = document.lineAt(position.line).text;
          logger.appendLine(`[HierarchyTree] Document line ${position.line}: "${lineText}"`);
          logger.appendLine(`[HierarchyTree] Character at position: "${lineText.charAt(position.character)}"`);
        } catch (docError) {
          logger.appendLine(`[HierarchyTree] Failed to open document: ${docError}`);
        }
        
        // 如果找不到调用层级，尝试其他位置策略
        // 策略2: 尝试向上查找函数定义
        if (targetLine > 0 && (!callHierarchyItems || callHierarchyItems.length === 0)) {
          logger.appendLine(`[HierarchyTree] Trying to find function definition by looking upward...`);
          let upTargetLine = node.line - 1; // 转为0-based
          let maxLinesUp = 10; // 最多向上查找10行
          let upLinesChecked = 0;
          
          while (upTargetLine > 0 && upLinesChecked < maxLinesUp) {
            upTargetLine--;
            upLinesChecked++;
            
            const upLineText = document.lineAt(upTargetLine).text;
            // 检查这一行是否包含函数定义的特征
            if (upLineText.includes(symbolName) && 
                (upLineText.includes('function') || upLineText.includes('=') || 
                 upLineText.includes('(') || upLineText.includes('class') || 
                 upLineText.includes('private') || upLineText.includes('public') || 
                 upLineText.includes('protected'))) {
              
              const upPosition = new vscode.Position(
                upTargetLine,
                upLineText.indexOf(symbolName) + Math.floor(symbolName.length / 2)
              );
              
              logger.appendLine(`[HierarchyTree] Trying position at line ${upTargetLine}: ${upLineText}`);
              
              // 尝试使用这个新位置
              const upCallHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                'vscode.prepareCallHierarchy',
                uri,
                upPosition
              );
              
              if (upCallHierarchyItems && upCallHierarchyItems.length > 0) {
                logger.appendLine(`[HierarchyTree] Found call hierarchy items at line ${upTargetLine}`);
                callHierarchyItems = upCallHierarchyItems;
                position = upPosition;
                break;
              }
            }
          }
        }
      }

      if (!callHierarchyItems || callHierarchyItems.length === 0) {
        logger.appendLine(`[HierarchyTree] No call hierarchy items found for ${node.name}`);
        // 缓存空结果，避免重复尝试
        this._callHierarchyCache.set(cacheKey, []);
        return [];
      }

      // Get incoming or outgoing calls
      const command = direction === 'incoming' 
        ? 'vscode.provideIncomingCalls'
        : 'vscode.provideOutgoingCalls';

      logger.appendLine(`[HierarchyTree] Executing ${command}...`);
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | vscode.CallHierarchyOutgoingCall[]>(
        command,
        callHierarchyItems[0]
      );

      logger.appendLine(`[HierarchyTree] ${command} returned ${calls?.length || 0} calls`);
      if (calls && calls.length > 0) {
        if (direction === 'incoming') {
          const call = calls[0] as vscode.CallHierarchyIncomingCall;
          logger.appendLine(`[HierarchyTree] First incoming call: from ${call.from.name} at ${call.from.uri.toString()}:${call.from.range.start.line}:${call.from.range.start.character}`);
          logger.appendLine(`[HierarchyTree] Call ranges: ${call.fromRanges.length} ranges`);
        } else {
          const call = calls[0] as vscode.CallHierarchyOutgoingCall;
          logger.appendLine(`[HierarchyTree] First outgoing call: to ${call.to.name} at ${call.to.uri.toString()}:${call.to.range.start.line}:${call.to.range.start.character}`);
          logger.appendLine(`[HierarchyTree] Call ranges: ${call.fromRanges.length} ranges`);
        }
      } else {
        logger.appendLine(`[HierarchyTree] WARNING: ${command} returned no calls. This might indicate that the function has no ${direction} calls or there's an issue with the language server.`);
      }

      if (!calls) {
        logger.appendLine(`[HierarchyTree] No calls returned from ${command}`);
        // 缓存空结果
        this._callHierarchyCache.set(cacheKey, []);
        return [];
      }

      // Convert to our format
      const result = calls.map(call => {
        const item = direction === 'incoming' 
          ? (call as vscode.CallHierarchyIncomingCall).from
          : (call as vscode.CallHierarchyOutgoingCall).to;
        return this.vscodeItemToCallHierarchyItem(item);
      });

      logger.appendLine(`[HierarchyTree] Converted ${result.length} calls to CallHierarchyItem format`);
      
      // 缓存结果
      this._callHierarchyCache.set(cacheKey, result);
      return result;
    } catch (error) {
      logger.appendLine(`[HierarchyTree] ERROR: Failed to get call hierarchy for ${node.name}: ${error}`);
      if (error instanceof Error && error.stack) {
        logger.appendLine(`[HierarchyTree] Stack trace: ${error.stack}`);
      }
      // 缓存空结果，避免重复尝试
      this._callHierarchyCache.set(cacheKey, []);
      return [];
    }
  }

  /**
   * Find the actual function definition line, skipping comments and whitespace
   * @param uri File URI
   * @param startLine Starting line to search from (0-based)
   * @param symbolName Symbol name to look for
   * @returns Object containing the actual line and character position
   */
  private async findActualDefinitionLine(uri: string, startLine: number, symbolName: string): Promise<{line: number, character: number}> {
    const logger = outputChannelService.getLspMcpChannel();
    logger.appendLine(`[HierarchyTree] Finding actual definition line for ${symbolName} at ${uri}:${startLine}`);
    
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      
      // Clean up symbol name for better matching
      const cleanSymbolName = symbolName.replace(/\(.*\)$/, '');
      logger.appendLine(`[HierarchyTree] Clean symbol name: ${cleanSymbolName}`);
      
      // Define regex patterns for function definitions
      const functionPatterns = [
        new RegExp(`function\\s+${cleanSymbolName}\\s*\\(`), // function name(
        new RegExp(`async\\s+function\\s+${cleanSymbolName}\\s*\\(`), // async function name(
        new RegExp(`${cleanSymbolName}\\s*=\\s*function`), // name = function
        new RegExp(`${cleanSymbolName}\\s*=\\s*\\(`), // name = (
        new RegExp(`${cleanSymbolName}\\s*\\(`), // name(
        new RegExp(`\\s+${cleanSymbolName}\\s*\\(`), // whitespace name(
        new RegExp(`class\\s+${cleanSymbolName}`), // class name
        new RegExp(`\\s+${cleanSymbolName}\\s*\\{`), // whitespace name {
        new RegExp(`private\\s+${cleanSymbolName}`), // private name
        new RegExp(`public\\s+${cleanSymbolName}`), // public name
        new RegExp(`protected\\s+${cleanSymbolName}`), // protected name
        new RegExp(`async\\s+${cleanSymbolName}`) // async name
      ];
      
      // First, try to find the definition by searching up and down from the starting line
      const maxLinesSearch = 10; // Look at most 10 lines in each direction
      
      // Search strategy 1: Look for exact function definition
      for (let offset = 0; offset <= maxLinesSearch; offset++) {
        // Check lines both up and down from the starting point
        for (const direction of [1, -1]) {
          // Skip offset 0 for the second iteration (direction = -1)
          if (offset === 0 && direction === -1) continue;
          
          const lineIndex = startLine + (offset * direction);
          
          // Ensure line index is valid
          if (lineIndex < 0 || lineIndex >= document.lineCount) continue;
          
          const lineText = document.lineAt(lineIndex).text;
          const trimmedLine = lineText.trim();
          
          // Skip comment lines and empty lines
          if (trimmedLine.startsWith('*') || trimmedLine.startsWith('/') || trimmedLine === '') {
            continue;
          }
          
          // Check if line contains function definition using regex patterns
          for (const pattern of functionPatterns) {
            if (pattern.test(lineText)) {
              logger.appendLine(`[HierarchyTree] Found function definition at line ${lineIndex}: ${lineText}`);
              
              // Find the position of the symbol name in the line
              const symbolIndex = lineText.indexOf(cleanSymbolName);
              if (symbolIndex !== -1) {
                return {
                  line: lineIndex,
                  character: symbolIndex + Math.floor(cleanSymbolName.length / 2) // Position in the middle of the symbol name
                };
              }
            }
          }
          
          // Simple check: if line contains the symbol name
          if (lineText.includes(cleanSymbolName)) {
            const symbolIndex = lineText.indexOf(cleanSymbolName);
            
            // Check if this looks like a function definition (contains parentheses or curly braces)
            if (lineText.includes('(') || lineText.includes('{')) {
              logger.appendLine(`[HierarchyTree] Found potential function definition at line ${lineIndex}: ${lineText}`);
              return {
                line: lineIndex,
                character: symbolIndex + Math.floor(cleanSymbolName.length / 2)
              };
            }
          }
        }
      }
      
      // Strategy 2: If we couldn't find a clear function definition, look for non-comment lines
      // Start from the given line and move down first
      let targetLine = startLine;
      let lineText = document.lineAt(targetLine).text;
      let linesChecked = 0;
      
      // Skip comment lines and empty lines going down
      while ((lineText.trim().startsWith('*') || lineText.trim().startsWith('/') || lineText.trim() === '') && 
             linesChecked < maxLinesSearch && 
             targetLine + 1 < document.lineCount) {
        targetLine++;
        lineText = document.lineAt(targetLine).text;
        linesChecked++;
      }
      
      // If we found a non-comment line, use it
      if (!lineText.trim().startsWith('*') && !lineText.trim().startsWith('/') && lineText.trim() !== '') {
        logger.appendLine(`[HierarchyTree] Using non-comment line ${targetLine}: ${lineText}`);
        
        // Try to find the symbol name in the line
        let symbolIndex = lineText.indexOf(cleanSymbolName);
        
        // If not found, look for common patterns
        if (symbolIndex === -1) {
          const functionIndex = lineText.indexOf('function');
          const asyncIndex = lineText.indexOf('async');
          const classIndex = lineText.indexOf('class');
          const privateIndex = lineText.indexOf('private');
          const publicIndex = lineText.indexOf('public');
          const protectedIndex = lineText.indexOf('protected');
          
          if (functionIndex !== -1) {
            symbolIndex = functionIndex + 'function '.length;
          } else if (asyncIndex !== -1) {
            symbolIndex = asyncIndex + 'async '.length;
          } else if (classIndex !== -1) {
            symbolIndex = classIndex + 'class '.length;
          } else if (privateIndex !== -1) {
            symbolIndex = privateIndex + 'private '.length;
          } else if (publicIndex !== -1) {
            symbolIndex = publicIndex + 'public '.length;
          } else if (protectedIndex !== -1) {
            symbolIndex = protectedIndex + 'protected '.length;
          }
        }
        
        // If still not found, use a reasonable position in the line
        if (symbolIndex === -1) {
          symbolIndex = Math.floor(lineText.length / 2);
        }
        
        return {
          line: targetLine,
          character: symbolIndex
        };
      }
      
      // Strategy 3: If all else fails, try to find any line with the symbol name
      for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        const lineText = document.lineAt(lineIndex).text;
        if (lineText.includes(cleanSymbolName)) {
          logger.appendLine(`[HierarchyTree] Found symbol name at line ${lineIndex}: ${lineText}`);
          return {
            line: lineIndex,
            character: lineText.indexOf(cleanSymbolName) + Math.floor(cleanSymbolName.length / 2)
          };
        }
      }
      
      // If we still couldn't find anything, return the original position
      logger.appendLine(`[HierarchyTree] Could not find better position, using original: ${startLine}`);
      return {
        line: startLine,
        character: Math.floor(document.lineAt(startLine).text.length / 2)
      };
    } catch (error) {
      // If anything goes wrong, return the original position
      logger.appendLine(`[HierarchyTree] Error finding definition line: ${error}`);
      return {
        line: startLine,
        character: 0
      };
    }
  }

  /**
   * Create hierarchy node from call hierarchy item
   */
  private async createNodeFromItem(item: CallHierarchyItem, level: number): Promise<HierarchyNode> {
    // Find the actual definition line
    const { line, character } = await this.findActualDefinitionLine(
      item.uri, 
      item.range.start.line, 
      item.name
    );
    
    return {
      id: `${item.name}:${item.uri}:${line}:${character}`,
      name: item.name,
      kind: item.kind,
      file: item.uri,
      line: line + 1, // Convert to 1-based
      character: character, // Store character
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