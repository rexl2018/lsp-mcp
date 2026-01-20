import * as vscode from 'vscode';
import { GraphBuilder } from './graph';
import { GraphJSON, Node as KGNode, Edge as KGEdge } from './types';
import { normalizePathForExportSync } from './id-normalizer';

// GraphRAG format interfaces
interface GraphRAGEntity {
  entity_name: string;
  entity_type: string;
  description: string;
  user_extra: string;
}

interface GraphRAGRelation {
  relation_key: {
    src_entity_name: string;
    tgt_entity_name: string;
  };
  description: string;
  user_extra: string;
}

interface GraphRAGFormat {
  entities: GraphRAGEntity[];
  relations: GraphRAGRelation[];
}

// Minimal transaction interface to avoid hard dependency on neo4j types
interface Neo4jTransaction {
  run: (query: string, params?: any) => Promise<any>;
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}

function convertToGraphRAGFormat(graph: GraphBuilder): GraphRAGFormat {
  const nodes = graph.nodes();
  const edges = graph.edges();
  
  // Create entities
  const entities: GraphRAGEntity[] = nodes.map(node => {
    // Use node.id as entity_name (already normalized in id-normalizer)
    const entity_name = node.id;
    
    // Use node.type as entity_type
    const entity_type = node.type;
    
    // Use node.name as description (as specified by --node-desc-keys name)
    const description = node.name || '';
    
    // Build user_extra from all node fields except id
    const nodeExtra = { ...node } as any;
    delete nodeExtra.id;
    if (nodeExtra.filePath) {
      nodeExtra.filePath = normalizePathForExportSync(nodeExtra.filePath);
    }
    const user_extra = JSON.stringify(nodeExtra);
    
    return {
      entity_name,
      entity_type,
      description,
      user_extra
    };
  });
  
  // Create relations
  const relations: GraphRAGRelation[] = edges.map(edge => {
    const relation_key = {
      src_entity_name: edge.from,
      tgt_entity_name: edge.to
    };
    
    // Use edge.type as description (as specified by --edge-desc-keys type)
    const description = edge.type;
    
    // Build user_extra from all edge fields except from/to
    const edgeExtra = { ...edge } as any;
    delete edgeExtra.from;
    delete edgeExtra.to;
    if (edgeExtra.filePath) {
      edgeExtra.filePath = normalizePathForExportSync(edgeExtra.filePath);
    }
    const user_extra = JSON.stringify(edgeExtra);
    
    return {
      relation_key,
      description,
      user_extra
    };
  });
  
  return { entities, relations };
}

async function saveGraphToJson(graph: GraphBuilder, workspaceFolder?: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
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

  // const json: GraphJSON = graph.toJSON();
  // const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8');
  // Convert to GraphRAG format instead of original nodes/edges format
  const graphRAGData = convertToGraphRAGFormat(graph);
  const content = Buffer.from(JSON.stringify(graphRAGData, null, 2), 'utf8');
  await vscode.workspace.fs.writeFile(kgFile, content);
  return kgFile;
}

async function saveGraphToNeo4j(graph: GraphBuilder): Promise<void> {
  const kgConfig = vscode.workspace.getConfiguration('kg');
  const url = kgConfig.get<string>('neo4j.url', 'bolt://localhost:7687');
  const username = kgConfig.get<string>('neo4j.username', 'neo4j');
  const password = kgConfig.get<string>('neo4j.password', '');
  const database = kgConfig.get<string>('neo4j.database', 'neo4j');

  if (!password) {
    vscode.window.showWarningMessage('KG: Neo4j password is empty. Set kg.neo4j.password in settings.');
  }

  const neo4j = (await import('neo4j-driver')).default;
  const driver = neo4j.driver(url, neo4j.auth.basic(username, password));
  const session = driver.session({ database });

  try {
    await session.writeTransaction(async (tx: Neo4jTransaction) => {
      const nodes = graph.nodes();
      for (const n of nodes) {
        const props: Record<string, unknown> = {
          id: n.id,
          type: n.type,
          name: n.name,
          filePath: n.filePath,
          range: n.range ? JSON.stringify(n.range) : undefined,
          detail: n.detail,
          description: n.description,
          tags: n.tags,
          createTime: n.createTime,
          updateTime: n.updateTime,
        };
        await tx.run(
          `MERGE (n:KGNode {id: $id})\nSET n += $props`,
          { id: n.id, props }
        );
      }

      const edges = graph.edges();
      for (const e of edges) {
        const relType = e.type;
        const props: Record<string, unknown> = {
          filePath: e.filePath,
          range: e.range ? JSON.stringify(e.range) : undefined,
          description: e.description,
          tags: e.tags,
          createTime: e.createTime,
          updateTime: e.updateTime,
        };
        const cypher = `MATCH (a:KGNode {id: $fromId}), (b:KGNode {id: $toId})\nMERGE (a)-[r:${relType}]->(b)\nSET r += $props`;
        await tx.run(cypher, { fromId: e.from, toId: e.to, props });
      }
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

export async function saveGraph(
  graph: GraphBuilder,
  workspaceFolder?: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
  const kgConfig = vscode.workspace.getConfiguration('kg');
  const backend = kgConfig.get<'json' | 'neo4j'>('storageBackend', 'json');

  if (backend === 'neo4j') {
    try {
      await saveGraphToNeo4j(graph);
      // Returning undefined for Neo4j backend (no file URI)
      return undefined;
    } catch (error) {
      vscode.window.showErrorMessage(`KG: Failed to save graph to Neo4j: ${error}`);
      // Do not silently fall back; respect configured backend
      return undefined;
    }
  }

  // Default to JSON file storage
  return await saveGraphToJson(graph, workspaceFolder);
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
    for (const n of json.nodes) builder.addNode(n as KGNode);
    for (const e of json.edges) builder.addEdge(e as KGEdge);
    return builder;
  } catch {
    return undefined;
  }
}