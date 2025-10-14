import * as vscode from 'vscode';
import { GraphBuilder } from '../core/graph';
import { Node, Range, Position } from '../core/types';
import { RequestQueue } from '../batch/request-queue';
import { normalizeFileId } from '../core/id-normalizer';

function isTestFileOrPath(fsPath: string): boolean {
  const p = fsPath.toLowerCase();
  const name = p.split(/[/\\]/).pop() || p;
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
  if (/(\.test|\.spec)\.(ts|tsx|js|jsx)$/.test(name)) return true;
  return false;
}

// Resolve a workspace-relative path (e.g., "<workspaceFolderName>/src/file.ts") into an absolute URI
function toAbsoluteUri(workspaceRelativePath: string): vscode.Uri {
  const rel = workspaceRelativePath.replace(/\\/g, '/');
  // If already absolute (Unix or Windows), use as-is
  if (/^\//.test(rel) || /^[a-zA-Z]:[\\/]/.test(workspaceRelativePath)) {
    return vscode.Uri.file(workspaceRelativePath);
  }
  const segments = rel.split('/').filter(Boolean);
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    // If the first segment matches a workspace folder name, join the rest under that folder
    const folder = folders.find(f => f.name === segments[0]);
    if (folder && segments.length > 1) {
      return vscode.Uri.joinPath(folder.uri, ...segments.slice(1));
    }
    // Otherwise, join all segments under the first workspace folder
    const first = folders[0];
    return vscode.Uri.joinPath(first.uri, ...segments);
  }
  // Fallback
  return vscode.Uri.file(workspaceRelativePath);
}

export class DefinitionAndReferencesCrawler {
  constructor(private concurrency = 8) {}

  async crawl(graph: GraphBuilder, token?: vscode.CancellationToken): Promise<void> {
    const nodes = graph.nodes();
    const symbolNodes = nodes.filter(n => n.type !== 'File' && n.filePath && n.range);

    const queue = new RequestQueue<Node>({ concurrency: this.concurrency, maxRetries: 1, retryDelayMs: 50 });
    queue.enqueueAll(symbolNodes);
    await queue.run(async (node) => this.processNode(graph, node, token), token);
  }

  private positionInRange(pos: Position, range?: Range): boolean {
    if (!range) return false;
    const afterStart = pos.line > range.start.line || (pos.line === range.start.line && pos.character >= range.start.character);
    const beforeEnd = pos.line < range.end.line || (pos.line === range.end.line && pos.character <= range.end.character);
    return afterStart && beforeEnd;
  }

  private async resolveNodeIdForLocation(graph: GraphBuilder, filePath: string, locRange: Range): Promise<string | null> {
    const kgConfig = vscode.workspace.getConfiguration('kg');
    const excludeTests = kgConfig.get<boolean>('excludeTests', true);
    if (excludeTests && isTestFileOrPath(filePath)) {
      return null;
    }
    const candidates = graph.nodes().filter(n => n.filePath === filePath && n.range && this.positionInRange(locRange.start, n.range));
    if (candidates.length > 0) {
      const best = candidates.reduce((prev, curr) => {
        const prevSize = (prev.range!.end.line - prev.range!.start.line) * 10000 + (prev.range!.end.character - prev.range!.start.character);
        const currSize = (curr.range!.end.line - curr.range!.start.line) * 10000 + (curr.range!.end.character - curr.range!.start.character);
        return currSize < prevSize ? curr : prev;
      });
      return best.id;
    }
    return await normalizeFileId(filePath);
  }

  private async processNode(graph: GraphBuilder, node: Node, token?: vscode.CancellationToken): Promise<void> {
    if (!node.filePath || !node.range) return;
    if (token?.isCancellationRequested) return;

    const absUri = toAbsoluteUri(node.filePath);
    const relPath = vscode.workspace.asRelativePath(absUri, true);
    // Use the symbol name position within the declaration range to improve provider accuracy
    let pos = new vscode.Position(node.range.start.line, node.range.start.character);
    try {
      const doc = await vscode.workspace.openTextDocument(absUri);
      const startLine = node.range.start.line;
      const endLine = node.range.end.line;
      for (let line = startLine; line <= endLine; line++) {
        const text = doc.lineAt(line).text;
        const idx = text.indexOf(node.name);
        if (idx >= 0) {
          pos = new vscode.Position(line, idx);
          break;
        }
      }
    } catch (e) {
      // Fallback to start-of-range when document cannot be opened
    }

    // Scan for potential function/method invocations within the function body and add outgoing REFERENCES edges
    try {
      const doc = await vscode.workspace.openTextDocument(absUri);
      const startLine = node.range.start.line;
      const endLine = node.range.end.line;
      let matchCount = 0;
      for (let line = startLine; line <= endLine && matchCount < 200; line++) {
        const text = doc.lineAt(line).text;
        const regex = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) && matchCount < 200) {
          const full = m[1];
          const dotIdx = full.lastIndexOf('.');
          const char = m.index + (dotIdx >= 0 ? dotIdx + 1 : 0);
          const callPos = new vscode.Position(line, char);
          // Skip the function's own declaration occurrence to avoid self-references
          if ((full === node.name || full.endsWith('.' + node.name)) && line === pos.line) {
            continue;
          }
          const defs2 = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider', absUri, callPos
          );
          const locs2: vscode.Location[] = Array.isArray(defs2)
            ? defs2.map(d => ('range' in d ? d : new vscode.Location(d.targetUri, d.targetRange)))
            : [];
          for (const def of locs2) {
            const targetRelPath = vscode.workspace.asRelativePath(def.uri, true);
            const targetRange: Range = {
              start: { line: def.range.start.line, character: def.range.start.character },
              end: { line: def.range.end.line, character: def.range.end.character }
            };
            const targetId = await this.resolveNodeIdForLocation(graph, targetRelPath, targetRange);
            if (!targetId || targetId === node.id) continue;
            graph.addEdge({
              type: 'REFERENCES',
              from: node.id,
              to: targetId,
              filePath: relPath,
              range: node.range,
              createTime: Date.now(),
              updateTime: Date.now()
            });
          }
          matchCount++;
        }
      }
    } catch (e) {
      // ignore scanning errors
    }

    // Definitions
    const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
      'vscode.executeDefinitionProvider', absUri, pos
    );

    const defLocs: vscode.Location[] = Array.isArray(defs)
      ? defs.map(d => ('range' in d ? d : new vscode.Location(d.targetUri, d.targetRange)))
      : [];

    for (const def of defLocs) {
      const targetRelPath = vscode.workspace.asRelativePath(def.uri, true);
      const targetRange: Range = {
        start: { line: def.range.start.line, character: def.range.start.character },
        end: { line: def.range.end.line, character: def.range.end.character }
      };
      const targetId = await this.resolveNodeIdForLocation(graph, targetRelPath, targetRange);
      if (!targetId || targetId === node.id) continue;
      graph.addEdge({
        type: 'REFERENCES',
        from: node.id,
        to: targetId,
        filePath: relPath,
        range: node.range,
        createTime: Date.now(),
        updateTime: Date.now()
      });
    }

    // References
    const refs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
      'vscode.executeReferenceProvider', absUri, pos
    );

    const refLocs: vscode.Location[] = Array.isArray(refs)
      ? refs.map(r => ('range' in r ? r : new vscode.Location(r.targetUri, r.targetRange)))
      : [];

    for (const ref of refLocs) {
      const sourceRelPath = vscode.workspace.asRelativePath(ref.uri, true);
      const sourceRange: Range = {
        start: { line: ref.range.start.line, character: ref.range.start.character },
        end: { line: ref.range.end.line, character: ref.range.end.character }
      };
      const sourceId = await this.resolveNodeIdForLocation(graph, sourceRelPath, sourceRange);
      if (!sourceId || sourceId === node.id) continue;
      graph.addEdge({
        type: 'REFERENCES',
        from: sourceId,
        to: node.id,
        filePath: relPath,
        range: node.range,
        createTime: Date.now(),
        updateTime: Date.now()
      });
    }
  }
}