import { GraphBuilder } from '../core/graph';

export class MergeService {
  // TODO: 合并策略：删除旧的、插入新的，维持图谱一致性
  mergeFileGraph(global: GraphBuilder, fileGraph: GraphBuilder): void {
    global.mergeGraph(fileGraph);
  }
}