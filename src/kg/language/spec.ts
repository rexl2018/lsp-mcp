import * as vscode from 'vscode';
import { NodeType } from '../core/types';

export interface LanguageSpec {
  mapSymbolKind(kind: vscode.SymbolKind): NodeType | null;
}