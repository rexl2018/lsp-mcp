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

// 默认配置
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8008;

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.error('Usage: node mcp-stdio-bridge.js [--port PORT] [--host HOST]');
      console.error('  --port PORT    MCP server port (default: 8008)');
      console.error('  --host HOST    MCP server host (default: localhost)');
      process.exit(0);
    }
  }
  
  return { host, port };
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
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'hover',
                description: 'Get hover information (type info, documentation) for a symbol by name. MUCH FASTER than reading entire files when you just need to understand a function signature or type',
                inputSchema: {
                  type: 'object',
                  properties: {
                    symbol: {
                      type: 'string',
                      description: 'Name of the symbol to get hover info for (e.g., "calculateSum", "Calculator.multiply")'
                    },
                    uri: {
                      type: 'string',
                      description: 'File URI to search in (optional - searches entire workspace if not provided)'
                    },
                    format: {
                      type: 'string',
                      enum: ['compact', 'detailed'],
                      description: 'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
                      default: 'compact'
                    }
                  },
                  required: ['symbol']
                }
              },
              {
                name: 'definition',
                description: 'Find the definition of a symbol by name. More efficient than searching files - instantly jumps to where a function/class/variable is defined',
                inputSchema: {
                  type: 'object',
                  properties: {
                    symbol: {
                      type: 'string',
                      description: 'Symbol name to find definition for (e.g., "functionName", "ClassName", "ClassName.methodName")'
                    },
                    format: {
                      type: 'string',
                      enum: ['compact', 'detailed'],
                      description: 'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
                      default: 'compact'
                    }
                  },
                  required: ['symbol']
                }
              },
              {
                name: 'diagnostics',
                description: 'Get diagnostics (errors, warnings, info) for a file or entire workspace. Instantly see all problems without running builds - includes type errors, linting issues, and more',
                inputSchema: {
                  type: 'object',
                  properties: {
                    uri: {
                      type: 'string',
                      description: 'File URI (optional - if not provided, returns all workspace diagnostics)'
                    },
                    format: {
                      type: 'string',
                      enum: ['compact', 'detailed'],
                      description: 'Output format: "compact" for AI/token efficiency (default), "detailed" for full data',
                      default: 'compact'
                    }
                  },
                  required: []
                }
              },
              {
                name: 'references',
                description: 'Find all references to a symbol in the workspace',
                inputSchema: {
                  type: 'object',
                  properties: {
                    symbol: {
                      type: 'string',
                      description: 'Symbol name to find references for'
                    }
                  },
                  required: ['symbol']
                }
              },
              {
                name: 'debug_setBreakpoint',
                description: 'Set a breakpoint at a specific line in a file',
                inputSchema: {
                  type: 'object',
                  properties: {
                    uri: {
                      type: 'string',
                      description: 'File URI where to set the breakpoint'
                    },
                    line: {
                      type: 'number',
                      description: 'Line number (1-based) where to set the breakpoint'
                    }
                  },
                  required: ['uri', 'line']
                }
              },
              {
                name: 'debug_startSession',
                description: 'Start a debug session with the specified configuration',
                inputSchema: {
                  type: 'object',
                  properties: {
                    configuration: {
                      type: 'string',
                      description: 'Name of the debug configuration to use'
                    }
                  },
                  required: []
                }
              },
              {
                name: 'symbolSearch',
                description: 'Search for symbols in the workspace by name or pattern',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: {
                      type: 'string',
                      description: 'Search query for symbol names'
                    }
                  },
                  required: ['query']
                }
              },
              {
                name: 'workspaceSymbols',
                description: 'Get all symbols in the workspace',
                inputSchema: {
                  type: 'object',
                  properties: {
                    filter: {
                      type: 'string',
                      description: 'Optional filter for symbol types'
                    }
                  },
                  required: []
                }
              }
            ]
          }
        };
        
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
async function main() {
  const { host, port } = parseArgs();
  
  console.error(`[Bridge] Starting MCP stdio bridge...`);
  console.error(`[Bridge] Connecting to MCP server at ${host}:${port}`);
  
  try {
    // 检查服务器健康状态
    console.error('[Bridge] Checking server health...');
    const isServerRunning = await checkServerHealth(host, port);
    if (!isServerRunning) {
      console.error(`[Bridge] ❌ MCP server is not running on ${host}:${port}`);
      console.error('[Bridge] Please start the VS Code extension and ensure the MCP server is running.');
      process.exit(1);
    }
    console.error('[Bridge] ✅ Server is healthy');
    
    // 建立SSE连接
    console.error('[Bridge] Establishing SSE connection...');
    await establishSSEConnection(host, port);
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
              const response = await handleMcpMessage(host, port, message);
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
    console.error('[Bridge] Make sure the MCP server is running on the specified host and port');
    process.exit(1);
  }
}

// 启动
main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});