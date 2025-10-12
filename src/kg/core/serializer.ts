import * as vscode from 'vscode';
import { GraphBuilder } from './graph';
import { GraphJSON } from './types';

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}

export async function saveGraph(
  graph: GraphBuilder,
  workspaceFolder?: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
  const folder = workspaceFolder || getWorkspaceFolder();
  if (!folder) return undefined;

  const kgDir = vscode.Uri.joinPath(folder.uri, '.kg');
  const kgFile = vscode.Uri.joinPath(kgDir, 'graph.json');

  // ensure .kg dir exists
  try {
    await vscode.workspace.fs.createDirectory(kgDir);
  } catch {
    // ignore
  }

  const json: GraphJSON = graph.toJSON();
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8');
  await vscode.workspace.fs.writeFile(kgFile, content);
  return kgFile;
}

export async function loadGraph(
  workspaceFolder?: vscode.WorkspaceFolder
): Promise<GraphBuilder | undefined> {
  const folder = workspaceFolder || getWorkspaceFolder();
  if (!folder) return undefined;
  const kgFile = vscode.Uri.joinPath(folder.uri, '.kg', 'graph.json');
  try {
    const buf = await vscode.workspace.fs.readFile(kgFile);
    const json = JSON.parse(Buffer.from(buf).toString('utf8')) as GraphJSON;
    const builder = new GraphBuilder();
    for (const n of json.nodes) builder.addNode(n);
    for (const e of json.edges) builder.addEdge(e);
    return builder;
  } catch {
    return undefined;
  }
}