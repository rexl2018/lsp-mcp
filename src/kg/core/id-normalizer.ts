import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Cache for Go module paths to avoid repeated file reads
const goModulePathCache = new Map<string, string | null>();

/**
 * Read go.mod file and extract module path
 */
async function getGoModulePath(workspaceFolder: vscode.WorkspaceFolder): Promise<string | null> {
  const cacheKey = workspaceFolder.uri.fsPath;
  
  if (goModulePathCache.has(cacheKey)) {
    return goModulePathCache.get(cacheKey) || null;
  }

  try {
    const goModPath = path.join(workspaceFolder.uri.fsPath, 'go.mod');
    if (fs.existsSync(goModPath)) {
      const content = fs.readFileSync(goModPath, 'utf8');
      const moduleMatch = content.match(/^module\s+(.+)$/m);
      if (moduleMatch) {
        const modulePath = moduleMatch[1].trim();
        goModulePathCache.set(cacheKey, modulePath);
        return modulePath;
      }
    }
  } catch (error) {
    console.warn('Failed to read go.mod:', error);
  }
  
  goModulePathCache.set(cacheKey, null);
  return null;
}

/**
 * Convert workspace-relative path to full module path for Go projects
 */
async function normalizeGoPath(filePath: string): Promise<string> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return filePath;
  }

  // Check if this contains a Go file path (either ends with .go or contains .go#)
  if (!filePath.includes('.go')) {
    return filePath;
  }

  // Find the workspace folder that contains this file
  for (const folder of workspaceFolders) {
    const folderName = folder.name;
    if (filePath.startsWith(folderName + '/')) {
      const modulePath = await getGoModulePath(folder);
      if (modulePath) {
        // Replace the workspace folder name with the full module path
        const relativePath = filePath.substring(folderName.length + 1);
        return `${modulePath}/${relativePath}`;
      }
    }
  }

  return filePath;
}

export async function normalizeFileId(filePath: string): Promise<string> {
  const normalizedPath = await normalizeGoPath(filePath);
  return `File:${normalizedPath}`;
}

export async function makeSymbolId(kind: string, qualifiedName: string): Promise<string> {
  const normalizedQualifiedName = await normalizeGoPath(qualifiedName);
  return `${kind}:${normalizedQualifiedName}`;
}

// Synchronous versions for backward compatibility (will use cached values)
export function normalizeFileIdSync(filePath: string): string {
  return `File:${filePath}`;
}

export function makeSymbolIdSync(kind: string, qualifiedName: string): string {
  return `${kind}:${qualifiedName}`;
}