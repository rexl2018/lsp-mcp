import * as vscode from 'vscode';
import { SSEServer, SSEServerConfig } from './mcp/sse-server';
import { debugOutputTracker } from './services/debugOutputTracker';
import { workspacePortManager } from './utils/workspace-port-manager';

let sseServer: SSEServer | undefined;
let mcpServerStatusBar: vscode.StatusBarItem | undefined;

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

  context.subscriptions.push(
    startServerCommand,
    stopServerCommand,
    toggleServerCommand,
    mcpServerStatusBar
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
  
  debugOutputTracker.dispose();
}
