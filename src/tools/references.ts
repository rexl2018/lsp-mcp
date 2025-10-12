import * as vscode from 'vscode';
import { Tool } from './types';
import { findSymbols, SymbolLocation } from './utils/symbolFinder';

export const referencesTool: Tool = {
  name: 'references',
  description:
    'Find all references to a symbol by name. Superior to grep - finds semantic references including imports, type usage, and renamed variables',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Symbol name to find references for (e.g., "functionName", "ClassName", "ClassName.methodName")',
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
         required: ['filePath', 'line', 'column']
      },
      includeDeclaration: {
        type: 'boolean',
        description: 'Include the declaration in results (default: true)',
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
    const { symbol, includeDeclaration = true, format = 'compact', symbolLocation } = args;
    return await findReferencesBySymbol(symbol, includeDeclaration, format, symbolLocation);
  },
};

// Helper function for symbol-based lookup
async function findReferencesBySymbol(
  symbolName: string,
  includeDeclaration: boolean,
  format: 'compact' | 'detailed',
  symbolLocation: SymbolLocation | undefined
): Promise<any> {
  // Search for the symbol in the workspace
  const symbols = await findSymbols(symbolName, symbolLocation);

  if (!symbols || symbols.length === 0) {
    return {
      symbol: symbolName,
      message: `No symbol found with name "${symbolName}"`,
      references: [],
      totalReferences: 0,
    };
  }

  const allReferences: any[] = [];
  const processedLocations = new Set<string>();

  for (const sym of symbols) {
    try {
      const targetPosition = sym.location.range.start;
      const targetUri = sym.location.uri;

      // Find references from this position
      const references = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        targetUri,
        targetPosition
      );

      if (references && references.length > 0) {
        // Filter out declaration if requested
        let filteredRefs = references;
        if (!includeDeclaration) {
          // The symbol's own location is its declaration.
          // We can filter it out directly without another provider call.
          filteredRefs = references.filter(ref => {
            if (!ref || !ref.uri || !ref.range) return true;
            return !(ref.uri.toString() === sym.location.uri.toString() && ref.range.isEqual(sym.location.range));
          });
        }

        // Add references, avoiding duplicates
        for (const ref of filteredRefs) {
          if (!ref || !ref.uri || !ref.range) continue;

          const locationKey = `${ref.uri.toString()}:${ref.range.start.line}:${ref.range.start.character}`;
          if (!processedLocations.has(locationKey)) {
            processedLocations.add(locationKey);

            // Get the relative path for display
            const relativePath = vscode.workspace.asRelativePath(ref.uri);

            if (format === 'compact') {
              allReferences.push([
                relativePath,
                ref.range.start.line + 1,
                ref.range.start.character,
                ref.range.end.line + 1,
                ref.range.end.character,
              ]);
            } else {
              allReferences.push({
                uri: ref.uri.toString(),
                file: relativePath,
                line: ref.range.start.line + 1,
                range: {
                  start: { line: ref.range.start.line + 1, character: ref.range.start.character },
                  end: { line: ref.range.end.line + 1, character: ref.range.end.character },
                },
              });
            }
          }
        }
      }
    } catch (error) {
      // Skip symbols that can't be processed
      console.error(`Error processing symbol ${sym.name}:`, error);
    }
  }

  // Add format description for compact mode
  if (format === 'compact' && allReferences.length > 0) {
    return {
      symbol: symbolName,
      totalReferences: allReferences.length,
      referenceFormat: '[filePath, startLine, startColumn, endLine, endColumn]',
      references: allReferences,
    };
  }

  return {
    symbol: symbolName,
    totalReferences: allReferences.length,
    references: allReferences,
  };
}
