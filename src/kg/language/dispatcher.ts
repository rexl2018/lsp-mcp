import * as vscode from 'vscode';
import { LanguageSpec } from './spec';
import { TsJsSpec } from './tsjs-spec';
import { GoSpec } from './go-spec';

export function getLanguageSpec(languageId: string): LanguageSpec {
  switch (languageId) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
    case 'json':
      return new TsJsSpec();
    case 'go':
      return new GoSpec();
    default:
      // default to TS/JS mapping
      return new TsJsSpec();
  }
}