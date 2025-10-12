import * as vscode from 'vscode';
import { LanguageSpec } from './spec';
import { NodeType } from '../core/types';

export class TsJsSpec implements LanguageSpec {
  mapSymbolKind(kind: vscode.SymbolKind): NodeType | null {
    switch (kind) {
      case vscode.SymbolKind.File:
        return 'File';
      case vscode.SymbolKind.Class:
        return 'Class';
      case vscode.SymbolKind.Interface:
        return 'Interface';
      case vscode.SymbolKind.Method:
        return 'Method';
      case vscode.SymbolKind.Function:
        return 'Function';
      case vscode.SymbolKind.Variable:
        return 'Variable';
      case vscode.SymbolKind.Enum:
        return 'Enum';
      case vscode.SymbolKind.Namespace:
        return 'Namespace';
      case vscode.SymbolKind.Module:
        return 'Module';
      case vscode.SymbolKind.Package:
        return 'Package';
      default:
        return null;
    }
  }
}