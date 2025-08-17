import * as vscode from 'vscode';
import { Tool } from './types';
import { findSymbols, SymbolLocation } from './utils/symbolFinder';

export const definitionTool: Tool = {
  name: 'definition',
  description:
    'Find the definition of a symbol by name. More efficient than searching files - instantly jumps to where a function/class/variable is defined',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Symbol name to find definition for (e.g., "functionName", "ClassName", "ClassName.methodName")',
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
        required: ['filePath', 'line']
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
    return await findDefinitionBySymbol(symbol, symbolLocation, format);
  },
};

// Helper function for symbol-based lookup
async function findDefinitionBySymbol(
  symbolName: string,
  symbolLocation: SymbolLocation | undefined,
  format: 'compact' | 'detailed'
): Promise<any> {
  // Use the unified findSymbols function
  const symbols = await findSymbols(symbolName, symbolLocation);

  if (!symbols || symbols.length === 0) {
    return {
      symbol: symbolName,
      message: `No definition found for symbol '${symbolName}'`,
      definitions: [],
    };
  }  const allDefinitions: any[] = [];

  for (const sym of symbols) {
    try {
      if (format === 'compact') {
        allDefinitions.push({
          symbol: [
            sym.name,
            vscode.SymbolKind[sym.kind].toLowerCase(),
            sym.location.uri.fsPath,
            sym.location.range.start.line + 1,
          ],
          uri: sym.location.uri.toString(),
          range: [
            sym.location.range.start.line + 1,
            sym.location.range.start.character,
            sym.location.range.end.line + 1,
            sym.location.range.end.character,
          ],
        });
      } else {
        allDefinitions.push({
          symbol: {
            name: sym.name,
            kind: vscode.SymbolKind[sym.kind],
            container: sym.containerName,
            file: sym.location.uri.fsPath,
            line: sym.location.range.start.line + 1,
          },
          uri: sym.location.uri.toString(),
          range: {
            start: {
              line: sym.location.range.start.line + 1,
              character: sym.location.range.start.character,
            },
            end: {
              line: sym.location.range.end.line + 1,
              character: sym.location.range.end.character,
            },
          },
        });
      }
    } catch (error) {
      console.error(`Error processing symbol ${sym.name}:`, error);
    }
  }

  if (allDefinitions.length === 0) {
    return {
      symbol: symbolName,
      message: `No definition found for symbol '${symbolName}'`,
      definitions: [],
    };
  }

  // Return appropriate format based on number of matches
  if (allDefinitions.length === 1) {
    if (format === 'compact') {
      return {
        symbol: symbolName,
        ...allDefinitions[0],
        definitionFormat: {
          symbol: '[name, kind, filePath, line]',
          range: '[startLine, startColumn, endLine, endColumn]',
        },
        definitions: [allDefinitions[0]],
      };
    } else {
      return {
        symbol: symbolName,
        ...allDefinitions[0],
        definitions: [allDefinitions[0]],
      };
    }
  } else {
    if (format === 'compact') {
      return {
        symbol: symbolName,
        multipleDefinitions: true,
        definitionFormat: {
          symbol: '[name, kind, filePath, line]',
          range: '[startLine, startColumn, endLine, endColumn]',
        },
        definitions: allDefinitions,
      };
    } else {
      return {
        symbol: symbolName,
        multipleDefinitions: true,
        definitions: allDefinitions,
      };
    }
  }
}
