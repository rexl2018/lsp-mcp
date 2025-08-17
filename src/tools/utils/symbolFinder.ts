import * as vscode from 'vscode';
import { getDocumentSymbols, searchWorkspaceSymbols } from './symbolProvider';
import { outputChannelService } from '../../services/outputChannelService';

export interface SymbolLocation {
  filePath: string;
  line: number; // 1-based
}

function findSymbolsAtLine(symbols: vscode.DocumentSymbol[], position: vscode.Position): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.range.contains(position)) {
      result.push(symbol);
      if (symbol.children && symbol.children.length > 0) {
        result.push(...findSymbolsAtLine(symbol.children, position));
      }
    }
  }
  return result;
}

async function findSymbolsByLocation(symbolLocation: SymbolLocation): Promise<vscode.SymbolInformation[]> {
  const outputChannel = outputChannelService.getLspMcpChannel();
  try {
    const fileUri = vscode.Uri.file(symbolLocation.filePath);
    const document = await vscode.workspace.openTextDocument(fileUri);
    const docSymbols = await getDocumentSymbols(document);

    if (docSymbols && docSymbols.length > 0) {
      const linePosition = new vscode.Position(symbolLocation.line - 1, 0); // Convert to 0-based
      const symbolsAtLine = findSymbolsAtLine(docSymbols, linePosition);

      if (symbolsAtLine.length > 0) {
        outputChannel.appendLine(`[findSymbols] Found ${symbolsAtLine.length} symbols at line ${symbolLocation.line}`);
        return symbolsAtLine.map(symbol => new vscode.SymbolInformation(
          symbol.name,
          symbol.kind,
          '', // containerName
          new vscode.Location(fileUri, symbol.range)
        ));
      }
    }
  } catch (error) {
    outputChannel.appendLine(`[findSymbols] Error finding symbol by location: ${error}.`);
  }
  return [];
}

async function findSymbolsByName(symbolName: string): Promise<vscode.SymbolInformation[]> {
  const outputChannel = outputChannelService.getLspMcpChannel();
  outputChannel.appendLine(`[findSymbols] Searching for symbol by name: ${symbolName}`);
  const searchQuery = symbolName.includes('.') ? symbolName.split('.').pop()! : symbolName;
  const workspaceSymbols = await searchWorkspaceSymbols(searchQuery);

  if (!workspaceSymbols || workspaceSymbols.length === 0) {
    outputChannel.appendLine(`[findSymbols] No symbols found with name: ${searchQuery}`);
    return [];
  }

  let matchingSymbols = workspaceSymbols.filter((s) => {
    const nameMatches =
      s.name === searchQuery ||
      s.name.startsWith(searchQuery + '(') ||
      (symbolName.includes('.') && s.containerName === symbolName.split('.')[0]);
    return nameMatches;
  });

  if (!symbolName.includes('.') && matchingSymbols.length > 1) {
    const standaloneSymbols = matchingSymbols.filter((s) => !s.containerName);
    if (standaloneSymbols.length > 0) {
      matchingSymbols = standaloneSymbols;
    }
  }
  
  outputChannel.appendLine(`[findSymbols] Found ${matchingSymbols.length} symbols by name.`);
  return matchingSymbols;
}

export async function findSymbols(symbolName: string, symbolLocation?: SymbolLocation): Promise<vscode.SymbolInformation[]> {
  const outputChannel = outputChannelService.getLspMcpChannel();
  outputChannel.appendLine(`[findSymbols] Finding symbol: ${symbolName}`);

  if (symbolLocation) {
    outputChannel.appendLine(`[findSymbols] Using symbolLocation: ${symbolLocation.filePath}:${symbolLocation.line}`);
    const symbols = await findSymbolsByLocation(symbolLocation);
    if (symbols.length > 0) {
      return symbols;
    }
    outputChannel.appendLine(`[findSymbols] No symbols found at location, falling back to name search.`);
  }

  return findSymbolsByName(symbolName);
}