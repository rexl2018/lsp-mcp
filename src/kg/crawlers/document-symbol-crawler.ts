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
      const fileNode: Node = {
        id: normalizeFileId(relFilePath),
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

      const languageId = (await vscode.workspace.openTextDocument(uri)).languageId;
      const spec = getLanguageSpec(languageId);

      const parentQualified = vscode.workspace.asRelativePath(uri, true);

      const processSymbol = (
        sym: vscode.DocumentSymbol,
        parentId: string | null,
        qualified: string
      ) => {
        const nodeType = spec.mapSymbolKind(sym.kind);
        if (!nodeType) return;
        const qname = `${qualified}#${sym.name}`;
        const nodeId = makeSymbolId(nodeType, qname);
        const node: Node = {
          id: nodeId,
          type: nodeType as NodeType,
          name: sym.name,
          filePath: relFilePath,
          range: {
            start: { line: sym.range.start.line, character: sym.range.start.character },
            end: { line: sym.range.end.line, character: sym.range.end.character },
          },
          detail: vscode.SymbolKind[sym.kind],
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
          processSymbol(child, nodeId, qname);
        }
      };

      for (const top of symbols) {
        processSymbol(top, null, parentQualified);
      }
    }
  }
}