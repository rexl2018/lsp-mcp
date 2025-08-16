import * as vscode from 'vscode';
import { SSEServer, SSEServerConfig } from './mcp/sse-server';
import { debugOutputTracker } from './services/debugOutputTracker';

let sseServer: SSEServer | undefined;
let mcpServerStatusBar: vscode.StatusBarItem | undefined;

async function updateMcpServerStatusBar() {
  if (!mcpServerStatusBar) {
    return;
  }

  const config = vscode.workspace.getConfiguration('vscode-mcp');
  const ssePort = config.get<number>('ssePort', 8008);

  // Check if server is actually running by testing the port
  const isServerRunning = await checkServerRunning(ssePort);
  
  if (isServerRunning) {
    mcpServerStatusBar.text = `$(server) MCP SSE: ${ssePort}`;
    mcpServerStatusBar.tooltip = `MCP SSE Server is running on port ${ssePort}\nClick to stop`;
    mcpServerStatusBar.backgroundColor = undefined;
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

  const startServerCommand = vscode.commands.registerCommand('vscode-mcp.startServer', async () => {
    if (sseServer) {
      return;
    }

    const config = vscode.workspace.getConfiguration('vscode-mcp');
    const ssePort = config.get<number>('ssePort', 8008);

    try {
      const sseConfig: SSEServerConfig = {
        port: ssePort,
        host: 'localhost',
        corsOrigins: ['*']
      };
      sseServer = new SSEServer(sseConfig);
      await sseServer.start();
      
      vscode.window.showInformationMessage(
        `MCP SSE Server started on port ${ssePort}.`
      );
      
      await updateMcpServerStatusBar();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to start MCP SSE Server: ${error}`);
    }
  });

  const stopServerCommand = vscode.commands.registerCommand('vscode-mcp.stopServer', async () => {
    if (!sseServer) {
      return;
    }

    try {
      await sseServer.stop();
      sseServer = undefined;
      
      await updateMcpServerStatusBar();
      vscode.window.showInformationMessage('MCP SSE Server stopped.');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to stop MCP SSE Server: ${error}`);
    }
  });

  const toggleServerCommand = vscode.commands.registerCommand(
    'vscode-mcp.toggleServer',
    async () => {
      if (sseServer) {
        await vscode.commands.executeCommand('vscode-mcp.stopServer');
      } else {
        await vscode.commands.executeCommand('vscode-mcp.startServer');
      }
    }
  );



  // Create MCP server status bar item
  mcpServerStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  mcpServerStatusBar.command = 'vscode-mcp.toggleServer';
  await updateMcpServerStatusBar();
  mcpServerStatusBar.show();

  context.subscriptions.push(
    startServerCommand,
    stopServerCommand,
    toggleServerCommand,
    mcpServerStatusBar
  );

  // Auto-start server on activation
  // vscode.commands.executeCommand('vscode-mcp.startServer');
}

export function deactivate() {
  // Dispose debug output tracker
  debugOutputTracker.dispose();

  if (sseServer) {
    sseServer.stop();
  }
}
