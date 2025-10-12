import * as assert from 'assert';
import * as vscode from 'vscode';
import { setupTest, teardownTest, openTestFile, getWorkspaceFolder } from '../helpers/testHelpers';
import { loadGraph } from '../../kg/core/serializer';

suite('KG Graph E2E', () => {
  let workspaceFolder: vscode.WorkspaceFolder;

  suiteSetup(async () => {
    await setupTest();
    workspaceFolder = getWorkspaceFolder();
    // Open common files to ensure language server is active
    await openTestFile('app.ts');
    await openTestFile('math.ts');
  });

  suiteTeardown(async () => {
    await teardownTest({ workspaceUri: workspaceFolder.uri });
  });

  describe('KG Graph E2E', function() {
    before(async () => {
      // Ensure tests include fixtures under src/test
      const kgConfig = vscode.workspace.getConfiguration('kg');
      await kgConfig.update('excludeTests', false, vscode.ConfigurationTarget.Workspace);
    });

    test('should generate knowledge graph with normalized reference targets and output stats', async () => {
      // Execute the command to generate the graph
      await vscode.commands.executeCommand('kg.generateGraph');

      // Load the saved graph from .kg/graph.json
      const graph = await loadGraph(workspaceFolder);
      assert.ok(graph, 'Graph should be loaded');

      const nodes = graph!.nodes();
      const edges = graph!.edges();

      // Basic sanity checks
      assert.ok(nodes.length > 0, 'Graph should have nodes');
      assert.ok(edges.length > 0, 'Graph should have edges');

      const idSet = new Set(nodes.map((n) => n.id));

      // Ensure all edges point to existing nodes (normalized IDs)
      for (const e of edges) {
        assert.ok(idSet.has(e.from), `Edge.from should reference existing node: ${e.from}`);
        assert.ok(idSet.has(e.to), `Edge.to should reference existing node: ${e.to}`);
      }

      // Count stats
      const referencesCount = edges.filter((e) => e.type === 'REFERENCES').length;
      const definesCount = edges.filter((e) => e.type === 'DEFINES').length;
      const containsCount = edges.filter((e) => e.type === 'CONTAINS').length;

      // Output statistics for visibility
      console.log(
        `KG Stats => nodes: ${nodes.length}, edges: ${edges.length}, REFERENCES: ${referencesCount}, DEFINES: ${definesCount}, CONTAINS: ${containsCount}`
      );

      // Additional dedup check: ensure no duplicate edges by type/from/to
      const edgeKeySet = new Set<string>();
      for (const e of edges) {
        const key = `${e.type}|${e.from}|${e.to}`;
        assert.ok(!edgeKeySet.has(key), `Duplicate edge detected: ${key}`);
        edgeKeySet.add(key);
      }
    });
  });
});