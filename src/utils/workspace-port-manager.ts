import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { PortManager } from './port-manager';

export interface WorkspacePortInfo {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  ssePort: number;
  processId: number;
  timestamp: number;
}

export interface PortRegistryEntry {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  ssePort: number;
  processId: number;
  timestamp: number;
  isActive: boolean;
}

/**
 * 工作区感知的端口管理器
 * 为每个VS Code实例分配唯一端口，避免多实例冲突
 */
export class WorkspacePortManager {
  private static readonly PORT_REGISTRY_FILE = '.lsp-mcp-ports.json';
  private static readonly DEFAULT_PORT_RANGE = { min: 8008, max: 8100 };
  private static readonly CLEANUP_INTERVAL = 30000; // 30秒
  private static readonly PORT_TTL = 300000; // 5分钟
  
  private workspaceId: string;
  private workspaceName: string;
  private workspacePath: string;
  private assignedPort: number | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.workspaceId = this.generateWorkspaceId();
    this.workspaceName = this.getWorkspaceName();
    this.workspacePath = this.getWorkspacePath();
  }

  /**
   * 生成工作区唯一标识符
   */
  private generateWorkspaceId(): string {
    const workspacePath = this.getWorkspacePath();
    const processId = process.pid;
    const timestamp = Date.now();
    
    // 使用工作区路径 + 进程ID + 时间戳生成唯一ID
    const data = `${workspacePath}-${processId}-${timestamp}`;
    return crypto.createHash('md5').update(data).digest('hex').substring(0, 8);
  }

  /**
   * 获取工作区名称
   */
  private getWorkspaceName(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return path.basename(workspaceFolders[0].uri.fsPath);
    }
    return 'untitled';
  }

  /**
   * 获取工作区路径
   */
  private getWorkspacePath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].uri.fsPath;
    }
    return process.cwd();
  }

  /**
   * 获取端口注册表文件路径
   */
  private getRegistryFilePath(): string {
    const os = require('os');
    return path.join(os.tmpdir(), WorkspacePortManager.PORT_REGISTRY_FILE);
  }

  /**
   * 读取端口注册表
   */
  private async readPortRegistry(): Promise<PortRegistryEntry[]> {
    const fs = require('fs').promises;
    const registryPath = this.getRegistryFilePath();
    
    try {
      const data = await fs.readFile(registryPath, 'utf8');
      const registry = JSON.parse(data) as PortRegistryEntry[];
      return Array.isArray(registry) ? registry : [];
    } catch (error) {
      // 文件不存在或格式错误，返回空数组
      return [];
    }
  }

  /**
   * 写入端口注册表
   */
  private async writePortRegistry(registry: PortRegistryEntry[]): Promise<void> {
    const fs = require('fs').promises;
    const registryPath = this.getRegistryFilePath();
    
    try {
      await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to write port registry:', error);
    }
  }

  /**
   * 清理过期的端口注册项
   */
  private async cleanupExpiredEntries(): Promise<void> {
    const registry = await this.readPortRegistry();
    const now = Date.now();
    const activeEntries: PortRegistryEntry[] = [];

    for (const entry of registry) {
      // 检查进程是否还在运行
      const isProcessAlive = await this.isProcessAlive(entry.processId);
      const isNotExpired = (now - entry.timestamp) < WorkspacePortManager.PORT_TTL;
      
      if (isProcessAlive && isNotExpired) {
        activeEntries.push(entry);
      } else {
        console.log(`Cleaning up expired port entry: ${entry.workspaceName}:${entry.ssePort}`);
      }
    }

    if (activeEntries.length !== registry.length) {
      await this.writePortRegistry(activeEntries);
    }
  }

  /**
   * 检查进程是否还在运行
   */
  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      // 在Unix系统上，发送信号0可以检查进程是否存在
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 为当前工作区分配端口
   */
  public async assignPort(): Promise<number> {
    if (this.assignedPort) {
      return this.assignedPort;
    }

    // 清理过期条目
    await this.cleanupExpiredEntries();
    
    const registry = await this.readPortRegistry();
    const usedPorts = new Set(registry.map(entry => entry.ssePort));
    
    // 尝试使用配置的端口
    const config = vscode.workspace.getConfiguration('lsp-mcp');
    const preferredPort = config.get<number>('ssePort', 8008);
    
    let assignedPort: number;
    
    if (!usedPorts.has(preferredPort) && await PortManager.isPortAvailable(preferredPort)) {
      assignedPort = preferredPort;
    } else {
      // 查找可用端口
      assignedPort = await PortManager.findAvailablePort(
        preferredPort,
        WorkspacePortManager.DEFAULT_PORT_RANGE
      );
      
      // 确保端口不在已使用列表中
      while (usedPorts.has(assignedPort)) {
        assignedPort = await PortManager.findAvailablePort(
          assignedPort + 1,
          WorkspacePortManager.DEFAULT_PORT_RANGE
        );
      }
    }

    // 注册端口
    const newEntry: PortRegistryEntry = {
      workspaceId: this.workspaceId,
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      ssePort: assignedPort,
      processId: process.pid,
      timestamp: Date.now(),
      isActive: true
    };

    registry.push(newEntry);
    await this.writePortRegistry(registry);
    
    this.assignedPort = assignedPort;
    
    // 启动清理定时器
    this.startCleanupTimer();
    
    console.log(`Assigned port ${assignedPort} to workspace: ${this.workspaceName} (${this.workspaceId})`);
    return assignedPort;
  }

  /**
   * 释放当前工作区的端口
   */
  public async releasePort(): Promise<void> {
    if (!this.assignedPort) {
      return;
    }

    const registry = await this.readPortRegistry();
    const filteredRegistry = registry.filter(entry => 
      entry.workspaceId !== this.workspaceId || entry.processId !== process.pid
    );

    await this.writePortRegistry(filteredRegistry);
    
    console.log(`Released port ${this.assignedPort} from workspace: ${this.workspaceName} (${this.workspaceId})`);
    this.assignedPort = null;
    
    // 停止清理定时器
    this.stopCleanupTimer();
  }

  /**
   * 获取所有活跃的工作区端口信息
   */
  public async getActiveWorkspaces(): Promise<WorkspacePortInfo[]> {
    await this.cleanupExpiredEntries();
    const registry = await this.readPortRegistry();
    
    return registry
      .filter(entry => entry.isActive)
      .map(entry => ({
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceName,
        workspacePath: entry.workspacePath,
        ssePort: entry.ssePort,
        processId: entry.processId,
        timestamp: entry.timestamp
      }));
  }

  /**
   * 根据工作区路径查找端口
   */
  public async findPortByWorkspacePath(workspacePath: string): Promise<number | null> {
    const registry = await this.readPortRegistry();
    const entry = registry.find(entry => 
      entry.workspacePath === workspacePath && entry.isActive
    );
    return entry ? entry.ssePort : null;
  }

  /**
   * 获取当前工作区信息
   */
  public getWorkspaceInfo(): { id: string; name: string; path: string; port: number | null } {
    return {
      id: this.workspaceId,
      name: this.workspaceName,
      path: this.workspacePath,
      port: this.assignedPort
    };
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }
    
    this.cleanupTimer = setInterval(async () => {
      await this.cleanupExpiredEntries();
    }, WorkspacePortManager.CLEANUP_INTERVAL);
  }

  /**
   * 停止清理定时器
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 创建客户端发现信息文件
   */
  public async createDiscoveryFile(): Promise<void> {
    if (!this.assignedPort) {
      return;
    }

    const discoveryInfo = {
      workspaceId: this.workspaceId,
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      ssePort: this.assignedPort,
      processId: process.pid,
      timestamp: Date.now(),
      endpoints: {
        sse: `http://localhost:${this.assignedPort}/mcp`,
        health: `http://localhost:${this.assignedPort}/health`,
        info: `http://localhost:${this.assignedPort}/info`
      }
    };

    const fs = require('fs').promises;
    const discoveryPath = path.join(this.workspacePath, '.vscode', 'mcp-server.json');
    
    try {
      // 确保.vscode目录存在
      const vscodeDirPath = path.dirname(discoveryPath);
      await fs.mkdir(vscodeDirPath, { recursive: true });
      
      // 写入发现文件
      await fs.writeFile(discoveryPath, JSON.stringify(discoveryInfo, null, 2), 'utf8');
      console.log(`Created discovery file: ${discoveryPath}`);
    } catch (error) {
      console.error('Failed to create discovery file:', error);
    }
  }

  /**
   * 删除客户端发现信息文件
   */
  public async removeDiscoveryFile(): Promise<void> {
    const fs = require('fs').promises;
    const discoveryPath = path.join(this.workspacePath, '.vscode', 'mcp-server.json');
    
    try {
      await fs.unlink(discoveryPath);
      console.log(`Removed discovery file: ${discoveryPath}`);
    } catch (error) {
      // 文件可能不存在，忽略错误
    }
  }

  /**
   * 销毁管理器，清理资源
   */
  public async dispose(): Promise<void> {
    this.stopCleanupTimer();
    await this.releasePort();
    await this.removeDiscoveryFile();
  }
}

// 导出单例实例
export const workspacePortManager = new WorkspacePortManager();