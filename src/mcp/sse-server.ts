import express from 'express';
import cors from 'cors';
import { Server } from 'http';
import { validateToolArguments } from './validate';
import { getTools } from '../tools';

export interface SSEServerConfig {
  port: number;
  host?: string;
  corsOrigins?: string[];
}

export class SSEServer {
  private app: express.Application;
  private server: Server | null = null;
  private clients: Set<express.Response> = new Set();
  private config: SSEServerConfig;

  constructor(config: SSEServerConfig) {
    this.config = config;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // CORS 配置
    const corsOptions = {
      origin: this.config.corsOrigins || ['*'],
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Cache-Control'],
      credentials: true
    };
    
    this.app.use(cors(corsOptions));
    this.app.use(express.json());
  }

  private setupRoutes(): void {
    // MCP SSE 端点 - 主要的 MCP 连接端点
    this.app.get('/mcp', (req, res) => {
      this.handleSSEConnection(req, res);
    });
    
    // SSE 端点 (备用)
    this.app.get('/sse', (req, res) => {
      this.handleSSEConnection(req, res);
    });

    // MCP 消息端点
    this.app.post('/message', async (req, res) => {
      try {
        await this.handleMcpMessage(req, res);
      } catch (error) {
        console.error('Error handling MCP message:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // 健康检查端点
    this.app.get('/health', (req, res) => {
      const response = { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        clients: this.clients.size
      };
      res.json(response);
    });

    // MCP 服务器信息端点
    this.app.get('/info', (req, res) => {
      const response = {
        name: 'LSP MCP Server',
        version: '1.0.0',
        transport: 'sse',
        capabilities: {
          tools: {}
        }
      };
      res.json(response);
    });
    
    // 404 处理
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Route not found', path: req.path, method: req.method });
    });
  }

  private handleSSEConnection(req: express.Request, res: express.Response): void {
    const clientId = this.generateClientId();
    
    try {
      // 设置 SSE 头
      const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      };
      res.writeHead(200, headers);
      
      // 发送初始连接消息
      const connectionMessage = {
        timestamp: new Date().toISOString(),
        clientId: clientId
      };
      this.sendSSEMessage(res, 'connected', connectionMessage);
      
      // 添加客户端到集合
      this.clients.add(res);

      // 处理客户端断开连接
      req.on('close', () => {
        this.clients.delete(res);
      });
      
      req.on('error', (error) => {
        console.error(`[SSE] Client ${clientId} error:`, error);
        this.clients.delete(res);
      });
      
    } catch (error) {
      console.error(`[SSE] Error setting up SSE connection for client ${clientId}:`, error);
      try {
        res.status(500).json({ error: 'Failed to establish SSE connection' });
      } catch (resError) {
        console.error(`[SSE] Error sending error response to client ${clientId}:`, resError);
      }
    }
  }

  private async handleMcpMessage(req: express.Request, res: express.Response): Promise<void> {
    const message = req.body;

    // 基本消息格式验证
    if (!message || !message.jsonrpc || !message.method) {
      res.status(400).json({ error: 'Invalid MCP message format' });
      return;
    }

    try {
      // 直接处理 MCP 请求
      const mcpResponse = await this.handleMcpRequest(message);
      
      // 对于 tools/list 请求，直接返回响应而不是通过 SSE 广播
      if (message.method === 'tools/list') {
        res.json(mcpResponse);
        return;
      }
      
      // 通过 SSE 广播响应给所有连接的客户端
      this.broadcastToClients('message', mcpResponse);
      
      // 返回 HTTP 响应
      res.json({ status: 'sent', messageId: message.id });
    } catch (error) {
      console.error('Error processing MCP message:', error);
      
      // 发送错误响应
      const errorResponse = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error instanceof Error ? error.message : String(error)
        }
      };
      
      this.broadcastToClients('error', errorResponse);
      res.status(500).json({ error: 'Failed to process message' });
    }
  }

  private async handleMcpRequest(message: any): Promise<any> {
    if (!message || !message.method) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: message?.id || null,
        error: {
          code: -32600,
          message: 'Invalid Request'
        }
      };
      return errorResponse;
    }

    let response: any;
    
    try {
      switch (message.method) {
        case 'initialize':
          response = {
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
                name: 'LSP MCP Server',
                version: '1.0.0'
              }
            }
          };
          break;
          
        case 'tools/list':
          const tools = getTools();
          response = {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema
              }))
            }
          };
          break;
          
        case 'tools/call':
          const { name, arguments: args } = message.params;
          const availableTools = getTools();
          const tool = availableTools.find(t => t.name === name);
          
          if (!tool) {
            response = {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32602,
                message: `Unknown tool: ${name}`
              }
            };
            break;
          }
          
          // 验证参数
          const validation = validateToolArguments(args || {}, tool.inputSchema);
          if (!validation.valid) {
            response = {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32602,
                message: `Invalid arguments: ${validation.error}`
              }
            };
            break;
          }
          
          try {
            // 调用实际的工具处理函数
            const result = await tool.handler(args || {});
            response = {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                  }
                ]
              }
            };
          } catch (error) {
            console.error('[MCP] ❌ Tool execution error:', error);
            response = {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32603,
                message: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
              }
            };
          }
          break;
          
        default:
          response = {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`
            }
          };
          break;
      }
    } catch (error) {
      console.error('[MCP] ❌ Error processing MCP request:', error);
      response = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error instanceof Error ? error.message : String(error)
        }
      };
    }

    return response;
  }

  private sendSSEMessage(res: express.Response, event: string, data: any): void {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      console.error('Error sending SSE message:', error);
    }
  }

  private broadcastToClients(event: string, data: any): void {
    const deadClients: express.Response[] = [];
    
    for (const client of this.clients) {
      try {
        this.sendSSEMessage(client, event, data);
      } catch (error) {
        console.error('Error broadcasting to client:', error);
        deadClients.push(client);
      }
    }
    
    // 清理断开的客户端
    deadClients.forEach(client => this.clients.delete(client));
  }

  private generateClientId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  public async start(): Promise<void> {
    console.log(`Starting SSE MCP Server on ${this.config.host || 'localhost'}:${this.config.port}...`);
    
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, this.config.host || 'localhost', () => {
          console.log(`✅ SSE MCP Server successfully started and listening on ${this.config.host || 'localhost'}:${this.config.port}`);
          resolve();
        });
        
        this.server.on('error', (error: any) => {
          console.error('❌ SSE Server error:', error);
          if (error.code === 'EADDRINUSE') {
            console.error(`Port ${this.config.port} is already in use. Please check if another service is running on this port.`);
          } else if (error.code === 'EACCES') {
            console.error(`Permission denied to bind to port ${this.config.port}. Try using a port number > 1024.`);
          }
          reject(error);
        });
        
      } catch (error) {
        console.error('❌ Failed to start SSE Server:', error);
        reject(error);
      }
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // 关闭所有 SSE 连接
        for (const client of this.clients) {
          try {
            client.end();
          } catch (error) {
            console.error('Error closing SSE client:', error);
          }
        }
        this.clients.clear();
        
        // 关闭服务器
        this.server.close(() => {
          console.log('SSE MCP Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public getActiveClientsCount(): number {
    return this.clients.size;
  }

  public getServerInfo(): { port: number; host: string; clients: number } {
    return {
      port: this.config.port,
      host: this.config.host || 'localhost',
      clients: this.clients.size
    };
  }
}