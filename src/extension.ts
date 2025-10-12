import * as vscode from 'vscode';
import { SSEServer, SSEServerConfig } from './mcp/sse-server';
import { debugOutputTracker } from './services/debugOutputTracker';
import { outputChannelService } from './services/outputChannelService';
import { workspacePortManager } from './utils/workspace-port-manager';
import { GraphBuilder } from './kg/core/graph';
import { DocumentSymbolCrawler } from './kg/crawlers/document-symbol-crawler';
import { saveGraph } from './kg/core/serializer';
import { DefinitionAndReferencesCrawler } from './kg/crawlers/def-and-ref-crawler';

let sseServer: SSEServer | undefined;
let mcpServerStatusBar: vscode.StatusBarItem | undefined;
let kgGraph: GraphBuilder | undefined;
let kgScanCancellation: vscode.CancellationTokenSource | undefined;

async function updateMcpServerStatusBar() {
  if (!mcpServerStatusBar) {
    return;
  }

  const workspaceInfo = workspacePortManager.getWorkspaceInfo();
  const ssePort = workspaceInfo.port;

  if (ssePort && sseServer) {
    // Check if server is actually running by testing the port
    const isServerRunning = await checkServerRunning(ssePort);
    
    if (isServerRunning) {
      mcpServerStatusBar.text = `$(server) MCP SSE: ${ssePort}`;
      mcpServerStatusBar.tooltip = `MCP SSE Server is running on port ${ssePort}\nWorkspace: ${workspaceInfo.name}\nClick to stop`;
      mcpServerStatusBar.backgroundColor = undefined;
    } else {
      mcpServerStatusBar.text = '$(server) MCP: Error';
      mcpServerStatusBar.tooltip = 'MCP SSE Server encountered an error\nClick to restart';
      mcpServerStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
  } else {
    mcpServerStatusBar.text = '$(server) MCP: Stopped';
    mcpServerStatusBar.tooltip = 'MCP SSE Server is stopped\nClick to start';
    mcpServerStatusBar.backgroundColor = undefined;
  }
}

async function checkServerRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(1000) // 1 second timeout
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('LSP MCP Server extension activated');

  // Initialize debug output tracker
  debugOutputTracker.initialize();

  const startServerCommand = vscode.commands.registerCommand('lsp-mcp.startServer', async () => {
    if (sseServer) {
      return;
    }

    try {
      // 为当前工作区分配唯一端口
      const ssePort = await workspacePortManager.assignPort();
      const workspaceInfo = workspacePortManager.getWorkspaceInfo();
      
      const sseConfig: SSEServerConfig = {
        port: ssePort,
        host: 'localhost',
        corsOrigins: ['*']
      };
      
      sseServer = new SSEServer(sseConfig);
      await sseServer.start();
      
      // 创建客户端发现文件
      await workspacePortManager.createDiscoveryFile();
      
      vscode.window.showInformationMessage(
        `MCP SSE Server started on port ${ssePort} for workspace "${workspaceInfo.name}".`
      );
      
      await updateMcpServerStatusBar();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to start MCP SSE Server: ${error}`);
    }
  });

  const stopServerCommand = vscode.commands.registerCommand('lsp-mcp.stopServer', async () => {
    if (!sseServer) {
      return;
    }

    try {
      await sseServer.stop();
      sseServer = undefined;
      
      // 释放端口并清理发现文件
      await workspacePortManager.releasePort();
      await workspacePortManager.removeDiscoveryFile();
      
      await updateMcpServerStatusBar();
      vscode.window.showInformationMessage('MCP SSE Server stopped.');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to stop MCP SSE Server: ${error}`);
    }
  });

  const toggleServerCommand = vscode.commands.registerCommand(
    'lsp-mcp.toggleServer',
    async () => {
      if (sseServer) {
        await vscode.commands.executeCommand('lsp-mcp.stopServer');
      } else {
        await vscode.commands.executeCommand('lsp-mcp.startServer');
      }
    }
  );



  // Create MCP server status bar item
  mcpServerStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  mcpServerStatusBar.command = 'lsp-mcp.toggleServer';
  await updateMcpServerStatusBar();
  mcpServerStatusBar.show();

  const generateGraphCommand = vscode.commands.registerCommand('kg.generateGraph', async () => {
    kgScanCancellation = new vscode.CancellationTokenSource();
    const token = kgScanCancellation.token;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Generating Knowledge Graph', cancellable: true }, async (progress, cancelToken) => {
      cancelToken.onCancellationRequested(() => kgScanCancellation?.cancel());
      progress.report({ message: 'Scanning workspace files...' });
      const builder = new GraphBuilder();
      const docCrawler = new DocumentSymbolCrawler();
      // DocumentSymbolCrawler will respect kg.excludeTests (default true)
      await docCrawler.crawl(builder, token);
      progress.report({ message: 'Resolving definitions and references...' });
      const refCrawler = new DefinitionAndReferencesCrawler(8);
      // def-and-ref crawler iterates existing nodes, so filtered test files won't be included
      await refCrawler.crawl(builder, token);
      kgGraph = builder;
      progress.report({ message: 'Saving graph to .kg/graph.json...' });
      const uri = await saveGraph(builder);
      if (uri) {
        vscode.window.showInformationMessage(`Knowledge graph saved: ${uri.fsPath}`);
      } else {
        vscode.window.showWarningMessage('No workspace folder found. Graph not saved.');
      }
    });
  });

  const exportGraphCommand = vscode.commands.registerCommand('kg.exportGraph', async () => {
    if (!kgGraph) {
      vscode.window.showInformationMessage('No graph in memory. Generating a fresh graph...');
      await vscode.commands.executeCommand('kg.generateGraph');
      return;
    }
    const uri = await saveGraph(kgGraph);
    if (uri) {
      vscode.window.showInformationMessage(`Knowledge graph exported: ${uri.fsPath}`);
    }
  });

  const stopScanCommand = vscode.commands.registerCommand('kg.stopScan', async () => {
    if (kgScanCancellation && !kgScanCancellation.token.isCancellationRequested) {
      kgScanCancellation.cancel();
      vscode.window.showInformationMessage('Knowledge graph scan cancelled.');
    }
  });

  context.subscriptions.push(
    startServerCommand,
    stopServerCommand,
    toggleServerCommand,
    mcpServerStatusBar,
    generateGraphCommand,
    exportGraphCommand,
    stopScanCommand
  );

  // Auto-start server on activation
  // vscode.commands.executeCommand('lsp-mcp.startServer');
}

export async function deactivate() {
  console.log('LSP MCP Server extension deactivated');
  
  // 停止服务器并清理资源
  if (sseServer) {
    try {
      await sseServer.stop();
    } catch (error) {
      console.error('Error stopping SSE server during deactivation:', error);
    }
  }
  
  // 清理工作区端口管理器
  try {
    await workspacePortManager.dispose();
  } catch (error) {
    console.error('Error disposing workspace port manager:', error);
  }
  
  // 清理输出通道
  try {
    outputChannelService.dispose();
  } catch (error) {
    console.error('Error disposing output channel service:', error);
  }
  
  debugOutputTracker.dispose();
}
