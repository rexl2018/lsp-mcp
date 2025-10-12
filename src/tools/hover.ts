import * as vscode from 'vscode';
import { findSymbols } from './utils/symbolFinder';
import { Tool } from './types';

export const hoverTool: Tool = {
  name: 'hover',
  description:
    'Get hover information (type info, documentation) for a symbol by name. MUCH FASTER than reading entire files when you just need to understand a function signature or type',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Name of the symbol to get hover info for (e.g., "calculateSum", "Calculator.multiply")',
      },
      symbolLocation: {
        type: 'object',
        description: 'Optional location of the symbol (file path and 1-based line number), used to get more accurate results.',
        properties: {
          filePath: {
            type: 'string',
            description: 'File path where the symbol is located'
          },
          line: {
            type: 'number',
            description: 'Line number (1-based) where the symbol is located'
          }
        },
         required: ['filePath', 'line', 'column']
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description:
          'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
        default: 'compact',
      },
    },
    required: ['symbol'],
  },
  handler: async (args) => {
    const { symbol, symbolLocation, format = 'compact' } = args;

    const matchingSymbols = await findSymbols(symbol, symbolLocation);

    if (!matchingSymbols || matchingSymbols.length === 0) {
      return {
        error: `No symbol found with name "${symbol}"`,
        suggestion: 'Try searching for the exact function/variable name or provide a valid symbolLocation',
      };
    }

    // Step 3: Get hover information for each matching symbol
    const results: any[] = [];

    for (const sym of matchingSymbols) {
      const document = await vscode.workspace.openTextDocument(sym.location.uri);

      // For better hover results, position cursor in the middle of the symbol name
      const line = document.lineAt(sym.location.range.start.line);
      const lineText = line.text;
      const symbolStartChar = sym.location.range.start.character;

      let hoverPosition: vscode.Position;
      // Position cursor in the middle of the symbol name for better results
      hoverPosition = new vscode.Position(
        sym.location.range.start.line,
        symbolStartChar + Math.floor(sym.name.length / 2)
      );

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        hoverPosition
      );

      if (!hovers || hovers.length === 0) continue;

      // Combine all hover contents
      const contents = hovers.flatMap((hover) => {
        return hover.contents.map((content) => {
          if (typeof content === 'string') {
            return content;
          } else if (content instanceof vscode.MarkdownString) {
            return content.value;
          } else {
            return content.value;
          }
        });
      });

      if (format === 'compact') {
        results.push({
          symbol: [
            sym.name,
            vscode.SymbolKind[sym.kind].toLowerCase(),
            sym.location.uri.fsPath,
            sym.location.range.start.line + 1,
          ],
          hover: contents,
        });
      } else {
        results.push({
          symbol: {
            name: sym.name,
            kind: vscode.SymbolKind[sym.kind],
            container: sym.containerName,
            file: sym.location.uri.fsPath,
            line: sym.location.range.start.line + 1,
          },
          hover: {
            contents: contents,
            // Include code snippet for context (line is already 0-based)
            codeSnippet: getCodeSnippet(document, sym.location.range.start.line),
          },
        });
      }
    }

    // Return appropriate format based on number of matches
    if (results.length === 0) {
      return {
        symbol: symbol,
        message: 'Symbol found but no hover information available',
      };
    } else if (results.length === 1) {
      // For single match, return simplified format
      if (format === 'compact') {
        return {
          ...results[0],
          symbolFormat: '[name, kind, filePath, line]',
        };
      }
      return results[0];
    } else {
      // For multiple matches, return all
      if (format === 'compact') {
        return {
          symbol: symbol,
          multipleMatches: true,
          symbolFormat: '[name, kind, filePath, line]',
          matches: results,
        };
      } else {
        return {
          symbol: symbol,
          multipleMatches: true,
          matches: results,
        };
      }
    }
  },
};

// Helper to get a code snippet around the symbol
function getCodeSnippet(
  document: vscode.TextDocument,
  line: number,
  contextLines: number = 2
): string {
  const lines: string[] = [];
  const startLine = Math.max(0, line - contextLines);
  const endLine = Math.min(document.lineCount - 1, line + contextLines);

  for (let i = startLine; i <= endLine; i++) {
    const lineText = document.lineAt(i).text;
    const prefix = i === line ? '>' : ' ';
    lines.push(`${prefix} ${i + 1}: ${lineText}`);
  }

  return lines.join('\n');
}
