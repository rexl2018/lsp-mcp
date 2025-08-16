#!/usr/bin/env node

/**
 * MCP stdio Bridge - 简化客户端配置的包装器脚本
 * 
 * 这个脚本将复杂的SSE/HTTP通信逻辑封装起来，
 * 让客户端只需要使用标准的stdio传输方式。
 * 
 * 使用方式:
 * node mcp-stdio-bridge.js [--port PORT] [--host HOST]
 */

const http = require('http');
const EventSource = require('eventsource');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 默认配置
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8008;

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let workspacePath = null;
  let autoDiscover = false;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--workspace' && i + 1 < args.length) {
      workspacePath = args[i + 1];
      i++;
    } else if (args[i] === '--auto-discover') {
      autoDiscover = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.error('Usage: node mcp-stdio-bridge.js [OPTIONS]');
      console.error('Options:');
      console.error('  --port PORT         MCP server port (default: 8008)');
      console.error('  --host HOST         MCP server host (default: localhost)');
      console.error('  --workspace PATH    Workspace path for server discovery');
      console.error('  --auto-discover     Automatically discover available MCP servers');
      console.error('  --help, -h          Show this help message');
      process.exit(0);
    }
  }
  
  return { host, port, workspacePath, autoDiscover };
}

// 全局变量存储SSE连接和待处理的请求
let sseConnection = null;
let pendingRequests = new Map();
let requestIdCounter = 1;

// 建立SSE连接
function establishSSEConnection(host, port) {
  return new Promise((resolve, reject) => {
    const sseUrl = `http://${host}:${port}/sse`;
    console.error(`[Bridge] Establishing SSE connection to ${sseUrl}`);
    
    const eventSource = new EventSource(sseUrl);
    
    eventSource.onopen = () => {
      console.error('[Bridge] SSE connection established');
      sseConnection = eventSource;
      resolve(eventSource);
    };
    
    eventSource.addEventListener('connected', (event) => {
      console.error('[Bridge] SSE connected event:', event.data);
    });
    
    eventSource.addEventListener('message', (event) => {
      console.error('[Bridge] Received SSE message:', event.data);
      try {
        const response = JSON.parse(event.data);
        if (response.id && pendingRequests.has(response.id)) {
          const { resolve: resolveRequest } = pendingRequests.get(response.id);
          pendingRequests.delete(response.id);
          resolveRequest(response);
        }
      } catch (error) {
        console.error('[Bridge] Error parsing SSE message:', error);
      }
    });
    
    eventSource.addEventListener('error', (event) => {
      console.error('[Bridge] SSE error event:', event.data);
    });
    
    eventSource.onerror = (error) => {
      console.error('[Bridge] SSE connection error:', error);
      if (!sseConnection) {
        reject(error);
      }
    };
    
    // 超时处理
    setTimeout(() => {
      if (!sseConnection) {
        eventSource.close();
        reject(new Error('SSE connection timeout'));
      }
    }, 5000);
  });
}

// 发送HTTP请求到MCP服务器
function sendHttpRequest(host, port, path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port: port,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    if (data) {
      const postData = JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }
    
    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseData ? JSON.parse(responseData) : null);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
    
    req.on('error', reject);
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

// 检查MCP服务器是否运行
async function checkServerHealth(host, port) {
  try {
    await sendHttpRequest(host, port, '/health');
    return true;
  } catch (error) {
    return false;
  }
}

// 处理MCP消息
async function handleMcpMessage(host, port, message) {
  console.error('[Bridge] Handling MCP message:', JSON.stringify(message, null, 2));
  
  try {
    switch (message.method) {
      case 'initialize':
        console.error('[Bridge] Processing initialize request');
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
              logging: {}
            },
            serverInfo: {
              name: 'VS Code MCP Server (via stdio bridge)',
              version: '1.0.0'
            }
          }
        };
        
      case 'tools/list':
        console.error('[Bridge] Processing tools/list request');
        try {
          // 动态从 VS Code 扩展获取工具列表
          const toolsResponse = await sendHttpRequest(host, port, '/message', 'POST', {
            jsonrpc: '2.0',
            id: 'tools-list-' + Date.now(),
            method: 'tools/list',
            params: {}
          });
          
          if (toolsResponse && toolsResponse.result && toolsResponse.result.tools) {
            console.error('[Bridge] Successfully fetched tools from VS Code extension');
            return {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: toolsResponse.result.tools
              }
            };
          } else {
            console.error('[Bridge] Failed to fetch tools from VS Code extension, using fallback');
            throw new Error('Invalid response from VS Code extension');
          }
        } catch (error) {
          console.error('[Bridge] Error fetching tools from VS Code extension:', error);
          console.error('[Bridge] Using fallback empty tools list');
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: []
            }
          };
        }
        
      case 'tools/call':
        console.error('[Bridge] Processing tools/call request');
        console.error('[Bridge] Tool name:', message.params?.name);
        console.error('[Bridge] Tool arguments:', message.params?.arguments);
        
        // 确保SSE连接已建立
        if (!sseConnection) {
          console.error('[Bridge] SSE connection not established, attempting to connect...');
          try {
            await establishSSEConnection(host, port);
          } catch (error) {
            console.error('[Bridge] Failed to establish SSE connection:', error);
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32603,
                message: 'SSE connection failed',
                data: error.message
              }
            };
          }
        }
        
        // 为这个请求分配一个唯一ID
        const requestId = message.id || requestIdCounter++;
        const requestMessage = {
          ...message,
          id: requestId
        };
        
        // 创建Promise来等待SSE响应
        const responsePromise = new Promise((resolve, reject) => {
          pendingRequests.set(requestId, { resolve, reject });
          
          // 设置超时
          setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              pendingRequests.delete(requestId);
              reject(new Error('Tool call timeout'));
            }
          }, 30000); // 30秒超时
        });
        
        // 通过HTTP发送请求到/message端点
        try {
          const httpResponse = await sendHttpRequest(host, port, '/message', 'POST', requestMessage);
          console.error('[Bridge] HTTP response:', httpResponse);
          
          // 等待SSE响应
          const sseResponse = await responsePromise;
          console.error('[Bridge] SSE response:', sseResponse);
          
          return sseResponse;
        } catch (error) {
          console.error('[Bridge] Error in tool call:', error);
          // 清理待处理的请求
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
          }
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: 'Tool call failed',
              data: error.message
            }
          };
        }
        
      default:
        console.error('[Bridge] Unknown method:', message.method);
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: 'Method not found',
            data: `Unknown method: ${message.method}`
          }
        };
    }
  } catch (error) {
    console.error('[Bridge] Error handling MCP message:', error);
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: error.message
      }
    };
  }
}

// 主函数
// 客户端发现机制
async function discoverMcpServer(workspacePath, preferredPort) {
  console.error('[Bridge] Starting MCP server discovery...');
  
  // 方法1: 从工作区发现文件中查找
  if (workspacePath) {
    console.error(`[Bridge] Looking for server in workspace: ${workspacePath}`);
    const discoveryPath = path.join(workspacePath, '.vscode', 'mcp-server.json');
    
    try {
      const data = await fs.promises.readFile(discoveryPath, 'utf8');
      const discoveryInfo = JSON.parse(data);
      
      if (discoveryInfo && discoveryInfo.ssePort) {
        console.error(`[Bridge] Found server in workspace discovery file: port ${discoveryInfo.ssePort}`);
        return {
          host: 'localhost',
          port: discoveryInfo.ssePort,
          workspaceInfo: {
            id: discoveryInfo.workspaceId,
            name: discoveryInfo.workspaceName,
            path: discoveryInfo.workspacePath
          }
        };
      }
    } catch (error) {
      console.error('[Bridge] No workspace discovery file found');
    }
  }
  
  // 方法2: 从全局端口注册表中查找
  console.error('[Bridge] Checking global port registry...');
  const registryPath = path.join(os.tmpdir(), '.lsp-mcp-ports.json');
  
  try {
    const data = await fs.promises.readFile(registryPath, 'utf8');
    const registry = JSON.parse(data);
    
    if (Array.isArray(registry)) {
      // 优先选择匹配工作区的服务器
      if (workspacePath) {
        const workspaceMatch = registry.find(entry => 
          entry.isActive && entry.workspacePath === workspacePath && isProcessAlive(entry.processId)
        );
        if (workspaceMatch) {
          console.error(`[Bridge] Found matching workspace server: port ${workspaceMatch.ssePort}`);
          return {
            host: 'localhost',
            port: workspaceMatch.ssePort,
            workspaceInfo: {
              id: workspaceMatch.workspaceId,
              name: workspaceMatch.workspaceName,
              path: workspaceMatch.workspacePath
            }
          };
        }
      }
      
      // 如果指定了工作区路径但没有找到匹配的服务器，不使用其他服务器
      if (workspacePath) {
        console.error(`[Bridge] No server found for workspace: ${workspacePath}`);
        return null;
      }
      
      // 只有在没有指定工作区时才选择任何可用的服务器
      const activeServers = registry.filter(entry => 
        entry.isActive && isProcessAlive(entry.processId)
      );
      
      if (activeServers.length > 0) {
        // 选择最新的服务器
        const latestServer = activeServers.sort((a, b) => b.timestamp - a.timestamp)[0];
        console.error(`[Bridge] Found active server: port ${latestServer.ssePort}`);
        return {
          host: 'localhost',
          port: latestServer.ssePort,
          workspaceInfo: {
            id: latestServer.workspaceId,
            name: latestServer.workspaceName,
            path: latestServer.workspacePath
          }
        };
      }
    }
  } catch (error) {
    console.error('[Bridge] No global registry found');
  }
  
  // 方法3: 端口扫描（后备方案）
  console.error('[Bridge] Scanning for available servers...');
  const portsToScan = preferredPort ? [preferredPort] : [8008, 8009, 8010, 8011, 8012];
  
  for (const port of portsToScan) {
    try {
      const isHealthy = await checkServerHealth('localhost', port);
      if (isHealthy) {
        console.error(`[Bridge] Found server by scanning: port ${port}`);
        return {
          host: 'localhost',
          port: port,
          workspaceInfo: {
            id: `scan-${port}`,
            name: `Port ${port}`,
            path: process.cwd()
          }
        };
      }
    } catch (error) {
      // 继续扫描下一个端口
    }
  }
  
  console.error('[Bridge] No MCP servers found');
  return null;
}

// 检查进程是否还在运行
function isProcessAlive(pid) {
  if (pid === 0) {
    return true; // 未知进程ID，假设存活
  }
  
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function main() {
  const { host, port, workspacePath, autoDiscover } = parseArgs();
  
  let serverInfo = { host, port, workspaceInfo: null };
  
  // 如果启用自动发现或提供了工作区路径，尝试发现服务器
  if (autoDiscover || workspacePath) {
    const discovered = await discoverMcpServer(workspacePath, port);
    if (discovered) {
      serverInfo = discovered;
      console.error(`[Bridge] Using discovered server: ${serverInfo.host}:${serverInfo.port}`);
      if (serverInfo.workspaceInfo) {
        console.error(`[Bridge] Workspace: ${serverInfo.workspaceInfo.name} (${serverInfo.workspaceInfo.path})`);
      }
    } else if (autoDiscover) {
      console.error('[Bridge] ❌ No MCP servers found during auto-discovery');
      console.error('[Bridge] Please start a VS Code instance with the LSP MCP extension');
      process.exit(1);
    }
  }
  
  console.error(`[Bridge] Starting MCP stdio bridge...`);
  console.error(`[Bridge] Connecting to MCP server at ${serverInfo.host}:${serverInfo.port}`);
  
  try {
    // 检查服务器健康状态
    console.error('[Bridge] Checking server health...');
    const isServerRunning = await checkServerHealth(serverInfo.host, serverInfo.port);
    if (!isServerRunning) {
      console.error(`[Bridge] ❌ MCP server is not running on ${serverInfo.host}:${serverInfo.port}`);
      console.error('[Bridge] Please start the VS Code extension and ensure the MCP server is running.');
      process.exit(1);
    }
    console.error('[Bridge] ✅ Server is healthy');
    
    // 建立SSE连接
    console.error('[Bridge] Establishing SSE connection...');
    await establishSSEConnection(serverInfo.host, serverInfo.port);
    console.error('[Bridge] ✅ SSE connection established');
    
    // 设置stdin/stdout处理
    console.error('[Bridge] Setting up stdio handlers...');
    process.stdin.setEncoding('utf8');
    
    let buffer = '';
    
    // 处理stdin输入
    process.stdin.on('data', async (chunk) => {
      buffer += chunk;
      
      // 处理完整的JSON消息
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的行
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line.trim());
            console.error('[Bridge] Received message:', JSON.stringify(message, null, 2));
            
            // 处理MCP消息
            if (message.jsonrpc === '2.0') {
              const response = await handleMcpMessage(serverInfo.host, serverInfo.port, message);
              console.error('[Bridge] Sending response:', JSON.stringify(response, null, 2));
              
              // 输出响应到stdout
              process.stdout.write(JSON.stringify(response) + '\n');
            }
          } catch (error) {
            console.error('[Bridge] Error processing message:', error);
            console.error('[Bridge] Invalid JSON:', line.trim());
            
            // 发送错误响应
            const errorResponse = {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32700,
                message: 'Parse error',
                data: error.message
              }
            };
            process.stdout.write(JSON.stringify(errorResponse) + '\n');
          }
        }
      }
    });
    
    // 处理进程退出
    process.stdin.on('end', () => {
      console.error('[Bridge] stdin ended, shutting down...');
      if (sseConnection) {
        sseConnection.close();
      }
      process.exit(0);
    });
    
    process.on('SIGINT', () => {
      console.error('[Bridge] Received SIGINT, shutting down...');
      if (sseConnection) {
        sseConnection.close();
      }
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.error('[Bridge] Received SIGTERM, shutting down...');
      if (sseConnection) {
        sseConnection.close();
      }
      process.exit(0);
    });
    
    console.error('[Bridge] ✅ MCP stdio bridge is ready');
    console.error('[Bridge] Waiting for MCP messages on stdin...');
    
  } catch (error) {
    console.error('[Bridge] ❌ Failed to start bridge:', error.message);
    console.error(`[Bridge] Make sure the MCP server is running on ${serverInfo.host}:${serverInfo.port}`);
    if (serverInfo.workspaceInfo) {
      console.error(`[Bridge] Expected workspace: ${serverInfo.workspaceInfo.name}`);
    }
    process.exit(1);
  }
}

// 启动
main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});