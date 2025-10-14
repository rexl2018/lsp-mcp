import * as vscode from 'vscode';
import { GraphBuilder } from '../core/graph';
import { Node, NodeType } from '../core/types';
import { normalizeFileId, makeSymbolId } from '../core/id-normalizer';
import { getLanguageSpec } from '../language/dispatcher';

function isTestFileOrPath(fsPath: string): boolean {
  const p = fsPath.toLowerCase();
  const name = p.split(/[/\\]/).pop() || p;
  // Common test directories
  const dirHints = [
    '/tests/', '\\tests\\',
    '/test/', '\\test\\',
    '/__tests__/', '\\__tests__\\',
    '/__test__/', '\\__test__\\',
    '/spec/', '\\spec\\',
    '/integration/', '\\integration\\',
    '/src/test/', '\\src\\test\\'
  ];
  if (dirHints.some(h => p.includes(h))) return true;
  // Common test filenames
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name)) return true;
  return false;
}

export class DocumentSymbolCrawler {
  private typeBlockCache = new Map<string, Array<{start: number, end: number, types: Map<string, string>}>>();

  async crawl(graph: GraphBuilder, token?: vscode.CancellationToken): Promise<void> {
    const include = '**/*.{ts,tsx,js,jsx,go}';
    const baseExclude = '**/{node_modules,.git,out,.vscode}/**';

    // Read configuration: exclude test files by default
    const kgConfig = vscode.workspace.getConfiguration('kg');
    const excludeTests = kgConfig.get<boolean>('excludeTests', true);

    const urisAll = await vscode.workspace.findFiles(include, baseExclude);
    const uris = excludeTests ? urisAll.filter(u => !isTestFileOrPath(u.fsPath)) : urisAll;

    for (const uri of uris) {
      if (token?.isCancellationRequested) return;
      // Use workspace-relative path prefixed with workspace folder name
      const relFilePath = vscode.workspace.asRelativePath(uri, true);
      const fileNodeId = await normalizeFileId(relFilePath);
      const fileNode: Node = {
        id: fileNodeId,
        type: 'File',
        name: uri.path.split('/').pop() || uri.path,
        filePath: relFilePath,
        createTime: Date.now(),
        updateTime: Date.now(),
      };
      graph.addNode(fileNode);

      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );

      if (!symbols || symbols.length === 0) continue;

      const doc = await vscode.workspace.openTextDocument(uri);
      const languageId = doc.languageId;
      const spec = getLanguageSpec(languageId);

      const parentQualified = vscode.workspace.asRelativePath(uri, true);

      const processSymbol = async (
        sym: vscode.DocumentSymbol,
        parentId: string | null,
        qualified: string
      ): Promise<void> => {
        let nodeType = spec.mapSymbolKind(sym.kind);
        if (!nodeType) return;

        // Additional refinement for Go: detect type alias vs struct
          if (languageId === 'go') {
            try {
              const startLineText = doc.lineAt(sym.range.start.line).text;
              
              // Cache type block ranges and parse their contents (computed once per file)
              const fileKey = uri.toString();
              if (!this.typeBlockCache.has(fileKey)) {
                const typeBlockRanges: Array<{start: number, end: number, types: Map<string, string>}> = [];
                const lineCount = doc.lineCount;
                for (let i = 0; i < lineCount; i++) {
                  const line = doc.lineAt(i).text;
                  // Match: type ( ... with proper validation
                  if (/^\s*type\s*\(\s*(?:\/\/.*)?$/.test(line)) {
                    let depth = 1;
                    let endLine = -1;
                    const blockTypes = new Map<string, string>();
                    
                    // Find matching closing parenthesis and parse contents
                    for (let j = i + 1; j < lineCount && depth > 0; j++) {
                      const innerLine = doc.lineAt(j).text;
                      // Skip comment-only lines and empty lines
                      if (/^\s*\/\//.test(innerLine) || /^\s*$/.test(innerLine)) continue;
                      
                      // Count parentheses (handle nested cases)
                      const opens = (innerLine.match(/\(/g) || []).length;
                      const closes = (innerLine.match(/\)/g) || []).length;
                      depth += opens - closes;
                      
                      if (depth === 0) {
                        endLine = j;
                        break;
                      }
                      
                      // Parse type declarations within the block
                      if (depth === 1) { // Only parse at the top level of the block
                        // Match: Name interface { ... }
                        const interfaceMatch = innerLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+interface\s*\{/);
                        if (interfaceMatch) {
                          blockTypes.set(interfaceMatch[1], 'Interface');
                          continue;
                        }
                        
                        // Match: Name struct { ... }
                        const structMatch = innerLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{/);
                        if (structMatch) {
                          blockTypes.set(structMatch[1], 'Struct');
                          continue;
                        }
                        
                        // Match: Name func(...)
                        const funcMatch = innerLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+func\s*\(/);
                        if (funcMatch) {
                          blockTypes.set(funcMatch[1], 'Func');
                          continue;
                        }
                        
                        // Match: Name map[...]
                        const mapMatch = innerLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+map\s*\[/);
                        if (mapMatch) {
                          blockTypes.set(mapMatch[1], 'Map');
                          continue;
                        }
                        
                        // Match: Name []... or [N]...
                        const sliceMatch = innerLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+\[/);
                        if (sliceMatch) {
                          blockTypes.set(sliceMatch[1], 'Slice');
                          continue;
                        }
                        
                        // Match: Name chan ...
                        const chanMatch = innerLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+chan\b/);
                        if (chanMatch) {
                          blockTypes.set(chanMatch[1], 'Channel');
                          continue;
                        }
                        
                        // Match: Name <other> (type alias)
                        const aliasMatch = innerLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([^\s].*)$/);
                        if (aliasMatch && !blockTypes.has(aliasMatch[1])) {
                          blockTypes.set(aliasMatch[1], 'Type');
                        }
                      }
                    }
                    
                    if (endLine > i) {
                      typeBlockRanges.push({ start: i, end: endLine, types: blockTypes });
                      i = endLine; // Skip ahead
                    }
                  }
                }
                this.typeBlockCache.set(fileKey, typeBlockRanges);
              }

              // Check if current symbol is in a type block and get its specific type
              const getTypeFromBlock = (symName: string, lineIdx: number): string | null => {
                const typeBlockRanges = this.typeBlockCache.get(fileKey) || [];
                for (const range of typeBlockRanges) {
                  if (lineIdx > range.start && lineIdx < range.end) {
                    return range.types.get(symName) || null;
                  }
                }
                return null;
              };

              // First check if it's in a type block
               const blockType = getTypeFromBlock(sym.name, sym.range.start.line);
               if (blockType) {
                 nodeType = blockType as NodeType;
              } else {
                // Handle single-line type declarations
                const typeDeclRegex = new RegExp(`\\btype\\s+${sym.name}\\b`);
                const structDeclRegex = new RegExp(`\\btype\\s+${sym.name}\\s+struct\\b`);
                const interfaceDeclRegex = new RegExp(`\\btype\\s+${sym.name}\\s+interface\\b`);
                const funcTypeRegex = new RegExp(`\\btype\\s+${sym.name}\\s+func\\s*\\(`);
                const mapTypeRegex = new RegExp(`\\btype\\s+${sym.name}\\s+map\\s*\\[`);
                const sliceArrayTypeRegex = new RegExp(`\\btype\\s+${sym.name}\\s+\\[`);
                const chanTypeRegex = new RegExp(`\\btype\\s+${sym.name}\\s+chan\\b`);

                if (structDeclRegex.test(startLineText)) {
                  nodeType = 'Struct';
                } else if (interfaceDeclRegex.test(startLineText)) {
                  nodeType = 'Interface';
                } else if (funcTypeRegex.test(startLineText)) {
                  nodeType = 'Func';
                } else if (mapTypeRegex.test(startLineText)) {
                  nodeType = 'Map';
                } else if (sliceArrayTypeRegex.test(startLineText)) {
                  nodeType = 'Slice';
                } else if (chanTypeRegex.test(startLineText)) {
                  nodeType = 'Channel';
                } else if (typeDeclRegex.test(startLineText)) {
                  nodeType = 'Type';
                }
              }
            } catch {}
          }
        const qname = `${qualified}#${sym.name}`;
        const nodeId = await makeSymbolId(nodeType, qname);
        // For Go, if we've refined the type from VS Code's "Class", use our type as detail
          let detail = vscode.SymbolKind[sym.kind];
          if (languageId === 'go' && detail === 'Class' && nodeType !== 'Class') {
            detail = nodeType;
          }

          const node: Node = {
            id: nodeId,
            type: nodeType as NodeType,
            name: sym.name,
            filePath: relFilePath,
            range: {
              start: { line: sym.range.start.line, character: sym.range.start.character },
              end: { line: sym.range.end.line, character: sym.range.end.character },
            },
            detail: detail,
            createTime: Date.now(),
            updateTime: Date.now(),
          };
        graph.addNode(node);

        // File DEFINES Symbol
        graph.addEdge({
          type: 'DEFINES',
          from: fileNode.id,
          to: nodeId,
          filePath: relFilePath,
          range: node.range,
          createTime: Date.now(),
          updateTime: Date.now(),
        });

        // Parent CONTAINS child
        if (parentId) {
          graph.addEdge({
            type: 'CONTAINS',
            from: parentId,
            to: nodeId,
            filePath: relFilePath,
            range: node.range,
            createTime: Date.now(),
            updateTime: Date.now(),
          });
        }

        for (const child of sym.children) {
          await processSymbol(child, nodeId, qname);
        }
      };

      for (const top of symbols) {
        await processSymbol(top, null, parentQualified);
      }

      // Fallback parsing for Go: detect 'type' declarations and type blocks
      if (languageId === 'go') {
        const lineCount = doc.lineCount;
        const nodeExists = (id: string) => graph.nodes().some(n => n.id === id);

        for (let i = 0; i < lineCount; i++) {
          const lineText = doc.lineAt(i).text;

          // Handle multi-type block: type (\n Name Alias \n ... )
          if (/^\s*type\s*\(/.test(lineText)) {
            let j = i + 1;
            while (j < lineCount) {
              const inner = doc.lineAt(j).text;
              if (/^\s*\)/.test(inner)) { // end of block
                break;
              }
              const m = inner.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*(?:\/\/.*)?$/);
              if (m) {
                const name = m[1];
                // Treat as Type alias (avoid struct here)
                const qname = `${parentQualified}#${name}`;
                const nodeId = await makeSymbolId('Type', qname);
                if (!nodeExists(nodeId)) {
                  const node: Node = {
                    id: nodeId,
                    type: 'Type',
                    name,
                    filePath: relFilePath,
                    range: {
                      start: { line: j, character: 0 },
                      end: { line: j, character: inner.length }
                    },
                    detail: 'Type',
                    createTime: Date.now(),
                    updateTime: Date.now()
                  };
                  graph.addNode(node);
                  graph.addEdge({
                    type: 'DEFINES',
                    from: fileNode.id,
                    to: nodeId,
                    filePath: relFilePath,
                    range: node.range,
                    createTime: Date.now(),
                    updateTime: Date.now()
                  });
                }
              }
              j++;
            }
            // Skip ahead to after the block
            i = j;
            continue;
          }

          // Single-line 'type Name struct' declaration
          const sMatch = lineText.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/);
          if (sMatch) {
            const name = sMatch[1];
            // Find struct end by brace balancing
            let startLine = i;
            let endLine = i;
            let depth = 0;
            // Count braces from current line onwards
            for (let k = i; k < lineCount; k++) {
              const t = doc.lineAt(k).text;
              // Count occurrences of '{' and '}'
              const opens = (t.match(/\{/g) || []).length;
              const closes = (t.match(/\}/g) || []).length;
              depth += opens - closes;
              endLine = k;
              if (depth <= 0 && opens > 0) {
                break;
              }
              if (depth <= 0 && k > i) {
                break;
              }
            }
            const qname = `${parentQualified}#${name}`;
            const nodeId = await makeSymbolId('Struct', qname);
            if (!nodeExists(nodeId)) {
              const node: Node = {
                id: nodeId,
                type: 'Struct',
                name,
                filePath: relFilePath,
                range: {
                  start: { line: startLine, character: 0 },
                  end: { line: endLine, character: doc.lineAt(endLine).text.length }
                },
                detail: 'Struct',
                createTime: Date.now(),
                updateTime: Date.now()
              };
              graph.addNode(node);
              graph.addEdge({
                type: 'DEFINES',
                from: fileNode.id,
                to: nodeId,
                filePath: relFilePath,
                range: node.range,
                createTime: Date.now(),
                updateTime: Date.now()
              });
            }
            continue;
          }

          // Single-line type alias: type Name ExistingType
          const aMatch = lineText.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^\s].*)$/);
          if (aMatch && !/\bstruct\b/.test(lineText)) {
            const name = aMatch[1];
            const qname = `${parentQualified}#${name}`;
            const nodeId = await makeSymbolId('Type', qname);
            if (!nodeExists(nodeId)) {
              const node: Node = {
                id: nodeId,
                type: 'Type',
                name,
                filePath: relFilePath,
                range: {
                  start: { line: i, character: 0 },
                  end: { line: i, character: lineText.length }
                },
                detail: 'Type',
                createTime: Date.now(),
                updateTime: Date.now()
              };
              graph.addNode(node);
              graph.addEdge({
                type: 'DEFINES',
                from: fileNode.id,
                to: nodeId,
                filePath: relFilePath,
                range: node.range,
                createTime: Date.now(),
                updateTime: Date.now()
              });
            }
          }
        }
      }
    }
  }
}