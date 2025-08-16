import * as path from 'path';
import * as fs from 'fs';
import { WorkspacePortInfo } from './workspace-port-manager';

export interface DiscoveryInfo {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  ssePort: number;
  processId: number;
  timestamp: number;
  endpoints: {
    sse: string;
    health: string;
    info: string;
  };
}

export interface ClientDiscoveryOptions {
  workspacePath?: string;
  preferredPort?: number;
  timeout?: number;
}

/**
 * 客户端发现机制
 * 帮助客户端找到正确的VS Code实例和MCP服务器
 */
export class ClientDiscovery {
  private static readonly DISCOVERY_TIMEOUT = 5000; // 5秒
  private static readonly HEALTH_CHECK_TIMEOUT = 1000; // 1秒
  
  /**
   * 发现可用的MCP服务器
   */
  public static async discoverServers(options: ClientDiscoveryOptions = {}): Promise<DiscoveryInfo[]> {
    const servers: DiscoveryInfo[] = [];
    
    // 方法1: 从工作区发现文件中查找
    if (options.workspacePath) {
      const workspaceServer = await this.discoverFromWorkspace(options.workspacePath);
      if (workspaceServer) {
        servers.push(workspaceServer);
      }
    }
    
    // 方法2: 从全局端口注册表中查找
    const registryServers = await this.discoverFromRegistry();
    servers.push(...registryServers);
    
    // 方法3: 端口扫描（作为后备方案）
    if (servers.length === 0) {
      const scannedServers = await this.discoverByPortScan(options.preferredPort);
      servers.push(...scannedServers);
    }
    
    // 验证服务器健康状态
    const healthyServers = await this.filterHealthyServers(servers);
    
    return healthyServers;
  }
  
  /**
   * 从工作区发现文件中查找服务器
   */
  private static async discoverFromWorkspace(workspacePath: string): Promise<DiscoveryInfo | null> {
    const discoveryPath = path.join(workspacePath, '.vscode', 'mcp-server.json');
    
    try {
      const data = await fs.promises.readFile(discoveryPath, 'utf8');
      const discoveryInfo = JSON.parse(data) as DiscoveryInfo;
      
      // 验证发现信息的有效性
      if (this.isValidDiscoveryInfo(discoveryInfo)) {
        return discoveryInfo;
      }
    } catch (error) {
      // 文件不存在或格式错误
    }
    
    return null;
  }
  
  /**
   * 从全局端口注册表中查找服务器
   */
  private static async discoverFromRegistry(): Promise<DiscoveryInfo[]> {
    const os = require('os');
    const registryPath = path.join(os.tmpdir(), '.lsp-mcp-ports.json');
    
    try {
      const data = await fs.promises.readFile(registryPath, 'utf8');
      const registry = JSON.parse(data);
      
      if (!Array.isArray(registry)) {
        return [];
      }
      
      const servers: DiscoveryInfo[] = [];
      
      for (const entry of registry) {
        if (entry.isActive && this.isProcessAlive(entry.processId)) {
          servers.push({
            workspaceId: entry.workspaceId,
            workspaceName: entry.workspaceName,
            workspacePath: entry.workspacePath,
            ssePort: entry.ssePort,
            processId: entry.processId,
            timestamp: entry.timestamp,
            endpoints: {
              sse: `http://localhost:${entry.ssePort}/mcp`,
              health: `http://localhost:${entry.ssePort}/health`,
              info: `http://localhost:${entry.ssePort}/info`
            }
          });
        }
      }
      
      return servers;
    } catch (error) {
      return [];
    }
  }
  
  /**
   * 通过端口扫描发现服务器（后备方案）
   */
  private static async discoverByPortScan(preferredPort?: number): Promise<DiscoveryInfo[]> {
    const servers: DiscoveryInfo[] = [];
    const portsToScan = preferredPort ? [preferredPort] : [8008, 8009, 8010, 8011, 8012];
    
    for (const port of portsToScan) {
      try {
        const healthUrl = `http://localhost:${port}/health`;
        const response = await this.fetchWithTimeout(healthUrl, this.HEALTH_CHECK_TIMEOUT);
        
        if (response.ok) {
          const healthData = await response.json();
          
          // 尝试获取服务器信息
          const infoUrl = `http://localhost:${port}/info`;
          const infoResponse = await this.fetchWithTimeout(infoUrl, this.HEALTH_CHECK_TIMEOUT);
          
          let serverInfo: { name: string; version: string } = {
            name: 'Unknown',
            version: '1.0.0'
          };
          
          if (infoResponse.ok) {
            const infoData = await infoResponse.json() as any;
            if (infoData && typeof infoData.name === 'string' && typeof infoData.version === 'string') {
              serverInfo = {
                name: infoData.name,
                version: infoData.version
              };
            }
          }
          
          servers.push({
            workspaceId: `scan-${port}`,
            workspaceName: `Port ${port}`,
            workspacePath: process.cwd(),
            ssePort: port,
            processId: 0, // 未知进程ID
            timestamp: Date.now(),
            endpoints: {
              sse: `http://localhost:${port}/mcp`,
              health: `http://localhost:${port}/health`,
              info: `http://localhost:${port}/info`
            }
          });
        }
      } catch (error) {
        // 端口不可用，继续扫描下一个
      }
    }
    
    return servers;
  }
  
  /**
   * 过滤健康的服务器
   */
  private static async filterHealthyServers(servers: DiscoveryInfo[]): Promise<DiscoveryInfo[]> {
    const healthyServers: DiscoveryInfo[] = [];
    
    for (const server of servers) {
      try {
        const response = await this.fetchWithTimeout(
          server.endpoints.health,
          this.HEALTH_CHECK_TIMEOUT
        );
        
        if (response.ok) {
          healthyServers.push(server);
        }
      } catch (error) {
        // 服务器不健康，跳过
      }
    }
    
    return healthyServers;
  }
  
  /**
   * 根据工作区路径查找最佳服务器
   */
  public static async findBestServer(workspacePath: string): Promise<DiscoveryInfo | null> {
    const servers = await this.discoverServers({ workspacePath });
    
    if (servers.length === 0) {
      return null;
    }
    
    // 只选择匹配工作区路径的服务器
    const exactMatch = servers.find(server => server.workspacePath === workspacePath);
    if (exactMatch) {
      return exactMatch;
    }
    
    // 如果没有找到匹配的工作区服务器，返回null而不是其他服务器
    return null;
  }
  
  /**
   * 获取服务器连接信息
   */
  public static async getConnectionInfo(workspacePath?: string): Promise<{
    sseUrl: string;
    healthUrl: string;
    infoUrl: string;
    workspaceInfo: {
      id: string;
      name: string;
      path: string;
    };
  } | null> {
    const server = workspacePath 
      ? await this.findBestServer(workspacePath)
      : (await this.discoverServers())[0];
    
    if (!server) {
      return null;
    }
    
    return {
      sseUrl: server.endpoints.sse,
      healthUrl: server.endpoints.health,
      infoUrl: server.endpoints.info,
      workspaceInfo: {
        id: server.workspaceId,
        name: server.workspaceName,
        path: server.workspacePath
      }
    };
  }
  
  /**
   * 列出所有可用的服务器
   */
  public static async listAvailableServers(): Promise<{
    id: string;
    name: string;
    path: string;
    port: number;
    status: 'healthy' | 'unhealthy';
    uptime: string;
  }[]> {
    const servers = await this.discoverServers();
    const result = [];
    
    for (const server of servers) {
      const uptime = this.formatUptime(Date.now() - server.timestamp);
      let status: 'healthy' | 'unhealthy' = 'unhealthy';
      
      try {
        const response = await this.fetchWithTimeout(
          server.endpoints.health,
          this.HEALTH_CHECK_TIMEOUT
        );
        status = response.ok ? 'healthy' : 'unhealthy';
      } catch (error) {
        status = 'unhealthy';
      }
      
      result.push({
        id: server.workspaceId,
        name: server.workspaceName,
        path: server.workspacePath,
        port: server.ssePort,
        status,
        uptime
      });
    }
    
    return result;
  }
  
  /**
   * 验证发现信息的有效性
   */
  private static isValidDiscoveryInfo(info: any): info is DiscoveryInfo {
    return (
      info &&
      typeof info.workspaceId === 'string' &&
      typeof info.workspaceName === 'string' &&
      typeof info.workspacePath === 'string' &&
      typeof info.ssePort === 'number' &&
      typeof info.processId === 'number' &&
      typeof info.timestamp === 'number' &&
      info.endpoints &&
      typeof info.endpoints.sse === 'string' &&
      typeof info.endpoints.health === 'string' &&
      typeof info.endpoints.info === 'string'
    );
  }
  
  /**
   * 检查进程是否还在运行
   */
  private static isProcessAlive(pid: number): boolean {
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
  
  /**
   * 带超时的fetch请求
   */
  private static async fetchWithTimeout(url: string, timeout: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        method: 'GET'
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
  
  /**
   * 格式化运行时间
   */
  private static formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

// 导出便捷函数
export const discoverMcpServers = ClientDiscovery.discoverServers;
export const findBestMcpServer = ClientDiscovery.findBestServer;
export const getMcpConnectionInfo = ClientDiscovery.getConnectionInfo;
export const listMcpServers = ClientDiscovery.listAvailableServers;