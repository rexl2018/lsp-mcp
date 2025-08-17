import * as vscode from 'vscode';
import { getDocumentSymbols, searchWorkspaceSymbols } from './symbolProvider';
import { outputChannelService } from '../../services/outputChannelService';

export interface SymbolLocation {
  filePath: string;
  line: number; // 1-based
  column?: number; // 0-based, optional for backward compatibility
}

function findSymbolsAtLine(symbols: vscode.DocumentSymbol[], position: vscode.Position): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.range.contains(position)) {
      // 检查是否有子符号包含该位置
      let foundInChildren = false;
      if (symbol.children && symbol.children.length > 0) {
        const childSymbols = findSymbolsAtLine(symbol.children, position);
        if (childSymbols.length > 0) {
          // 如果在子符号中找到，优先返回子符号
          result.push(...childSymbols);
          foundInChildren = true;
        }
      }
      
      // 如果没有在子符号中找到，或者这个符号没有子符号，则添加当前符号
      if (!foundInChildren) {
        result.push(symbol);
      }
    }
  }
  return result;
}

async function findSymbolsByLocation(symbolLocation: SymbolLocation): Promise<vscode.SymbolInformation[]> {
  const outputChannel = outputChannelService.getLspMcpChannel();
  try {
    const fileUri = vscode.Uri.file(symbolLocation.filePath);
    
    // 直接使用vscode.executeDocumentSymbolProvider命令获取文档符号，不需要打开文档
    const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      fileUri
    );

    if (docSymbols && docSymbols.length > 0) {
      // 使用column字段（如果提供），否则默认为0
      const column = symbolLocation.column !== undefined ? symbolLocation.column : 0;
      const linePosition = new vscode.Position(symbolLocation.line - 1, column); // Convert to 0-based
      const symbolsAtLine = findSymbolsAtLine(docSymbols, linePosition);

      if (symbolsAtLine.length > 0) {
        outputChannel.appendLine(`[findSymbols] Found ${symbolsAtLine.length} symbols at line ${symbolLocation.line}`);
        
        // 优先查找方法类型的符号
        const methodSymbols = symbolsAtLine.filter(s => 
          s.kind === vscode.SymbolKind.Method || 
          s.kind === vscode.SymbolKind.Function ||
          s.kind === vscode.SymbolKind.Constructor
        );
        
        // 如果找到了方法类型的符号，优先返回这些符号
        const symbolsToReturn = methodSymbols.length > 0 ? methodSymbols : symbolsAtLine;
        
        return symbolsToReturn.map(symbol => new vscode.SymbolInformation(
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