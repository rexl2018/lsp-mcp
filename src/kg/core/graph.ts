import { Edge, GraphJSON, Node } from './types';

export class GraphBuilder {
  private nodesMap = new Map<string, Node>();
  private edgesList: Edge[] = [];

  addNode(node: Node): void {
    const existing = this.nodesMap.get(node.id);
    const now = Date.now();
    if (!node.createTime) node.createTime = now;
    node.updateTime = now;
    if (existing) {
      // merge minimal fields
      this.nodesMap.set(node.id, { ...existing, ...node, updateTime: now });
    } else {
      this.nodesMap.set(node.id, node);
    }
  }

  addEdge(edge: Edge): void {
    const now = Date.now();
    if (!edge.createTime) edge.createTime = now;
    edge.updateTime = now;
    // simple de-dup by type/from/to
    const exists = this.edgesList.find(
      (e) => e.type === edge.type && e.from === edge.from && e.to === edge.to
    );
    if (!exists) {
      this.edgesList.push(edge);
    }
  }

  removeNodesByFile(filePath: string): void {
    const idsToRemove = new Set<string>();
    for (const [id, node] of this.nodesMap.entries()) {
      if (node.filePath === filePath) idsToRemove.add(id);
    }
    for (const id of idsToRemove) this.nodesMap.delete(id);
    this.edgesList = this.edgesList.filter(
      (e) => !idsToRemove.has(e.from) && !idsToRemove.has(e.to)
    );
  }

  mergeGraph(other: GraphBuilder): void {
    for (const node of other.nodes()) this.addNode(node);
    for (const edge of other.edges()) this.addEdge(edge);
  }

  nodes(): Node[] {
    return Array.from(this.nodesMap.values());
  }

  edges(): Edge[] {
    return this.edgesList.slice();
  }

  toJSON(): GraphJSON {
    return { nodes: this.nodes(), edges: this.edges() };
  }
}