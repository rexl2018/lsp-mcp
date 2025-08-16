import * as vscode from 'vscode';
import { getSharedTestContext } from './sharedSetup';
import { openTestFileWithLanguageServer } from './languageServerReady';

export interface TestContext {
  workspaceUri: vscode.Uri;
}

/**
 * Sets up the test environment
 */
export async function setupTest(): Promise<TestContext> {
  const context = await getSharedTestContext();
  return context;
}

/**
 * Tears down the test environment
 */
export async function teardownTest(_context: TestContext): Promise<void> {
  // Shared context cleanup is handled globally
}

/**
 * Gets a test file URI relative to the workspace
 */
export function getTestFileUri(filename: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders![0];
  return vscode.Uri.joinPath(workspaceFolder.uri, 'src', filename);
}

/**
 * Opens a test file and returns the document
 */
export async function openTestFile(filename: string): Promise<vscode.TextDocument> {
  return await openTestFileWithLanguageServer(getTestFileUri(filename));
}

/**
 * Helper function to wait for a condition with timeout
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    try {
      const result = await condition();
      if (result) {
        return true;
      }
    } catch (error) {
      // Continue waiting on errors
    }
    
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  return false;
}

/**
 * Placeholder function for tool calls (HTTP Bridge removed)
 */
export async function callTool(toolName: string, args: any, context?: TestContext): Promise<any> {
  throw new Error('callTool is no longer supported - HTTP Bridge mode has been removed. Use SSE mode instead.');
}

/**
 * Helper to get workspace folder
 */
export function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder found');
  }
  return folders[0];
}
