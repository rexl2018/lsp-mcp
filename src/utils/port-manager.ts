import * as net from 'net';
import * as vscode from 'vscode';

export interface PortInfo {
  port: number;
  isAvailable: boolean;
  service?: string;
  pid?: number;
}

export class PortManager {
  private static readonly DEFAULT_PORT_RANGE = { min: 8000, max: 9000 };
  private static readonly RESERVED_PORTS = [8080, 8443, 3000, 3001, 5000, 5001];
  
  /**
   * 检查端口是否可用
   */
  public static async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      
      server.listen(port, () => {
        server.once('close', () => {
          resolve(true);
        });
        server.close();
      });
      
      server.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * 获取端口详细信息
   */
  public static async getPortInfo(port: number): Promise<PortInfo> {
    const isAvailable = await this.isPortAvailable(port);
    
    return {
      port,
      isAvailable,
      service: isAvailable ? undefined : 'unknown'
    };
  }

  /**
   * 查找可用端口
   */
  public static async findAvailablePort(
    preferredPort?: number,
    range: { min: number; max: number } = PortManager.DEFAULT_PORT_RANGE
  ): Promise<number> {
    // 首先检查首选端口
    if (preferredPort && await this.isPortAvailable(preferredPort)) {
      return preferredPort;
    }

    // 在指定范围内查找可用端口
    for (let port = range.min; port <= range.max; port++) {
      // 跳过保留端口
      if (PortManager.RESERVED_PORTS.includes(port)) {
        continue;
      }

      if (await this.isPortAvailable(port)) {
        return port;
      }
    }

    throw new Error(`No available port found in range ${range.min}-${range.max}`);
  }

  /**
   * 查找多个可用端口
   */
  public static async findAvailablePorts(
    count: number,
    range: { min: number; max: number } = PortManager.DEFAULT_PORT_RANGE
  ): Promise<number[]> {
    const availablePorts: number[] = [];

    for (let port = range.min; port <= range.max && availablePorts.length < count; port++) {
      // 跳过保留端口
      if (PortManager.RESERVED_PORTS.includes(port)) {
        continue;
      }

      if (await this.isPortAvailable(port)) {
        availablePorts.push(port);
      }
    }

    if (availablePorts.length < count) {
      throw new Error(`Only found ${availablePorts.length} available ports, but ${count} were requested`);
    }

    return availablePorts;
  }

  /**
   * 验证端口范围
   */
  public static validatePortRange(ports: number[]): { valid: number[]; invalid: number[] } {
    const valid: number[] = [];
    const invalid: number[] = [];

    for (const port of ports) {
      if (this.isValidPort(port)) {
        valid.push(port);
      } else {
        invalid.push(port);
      }
    }

    return { valid, invalid };
  }

  /**
   * 检查端口号是否有效
   */
  public static isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  /**
   * 获取推荐的端口配置
   */
  public static async getRecommendedPorts(): Promise<{
    ssePort: number;
    bridgePort: number;
  }> {
    try {
      // 尝试使用默认端口
      const defaultSSEPort = 8008;
      const defaultBridgePort = 8991;

      const sseAvailable = await this.isPortAvailable(defaultSSEPort);
      const bridgeAvailable = await this.isPortAvailable(defaultBridgePort);

      if (sseAvailable && bridgeAvailable) {
        return {
          ssePort: defaultSSEPort,
          bridgePort: defaultBridgePort
        };
      }

      // 如果默认端口不可用，查找替代端口
      const availablePorts = await this.findAvailablePorts(2, { min: 8000, max: 9000 });
      
      return {
        ssePort: sseAvailable ? defaultSSEPort : availablePorts[0],
        bridgePort: bridgeAvailable ? defaultBridgePort : availablePorts[sseAvailable ? 0 : 1]
      };
    } catch (error) {
      // 如果无法找到端口，使用默认值
      console.warn('Failed to find recommended ports, using defaults:', error);
      return {
        ssePort: 8008,
        bridgePort: 8991
      };
    }
  }

  /**
   * 检查端口冲突
   */
  public static async checkPortConflicts(ports: number[]): Promise<{
    conflicts: number[];
    available: number[];
  }> {
    const conflicts: number[] = [];
    const available: number[] = [];

    for (const port of ports) {
      const isAvailable = await this.isPortAvailable(port);
      if (isAvailable) {
        available.push(port);
      } else {
        conflicts.push(port);
      }
    }

    return { conflicts, available };
  }

  /**
   * 显示端口状态信息
   */
  public static async showPortStatus(ports: number[]): Promise<void> {
    const portInfos: PortInfo[] = [];
    
    for (const port of ports) {
      const info = await this.getPortInfo(port);
      portInfos.push(info);
    }

    const statusMessage = portInfos
      .map(info => `Port ${info.port}: ${info.isAvailable ? '✅ Available' : '❌ In Use'}`)
      .join('\n');

    vscode.window.showInformationMessage(
      `Port Status:\n${statusMessage}`,
      { modal: false }
    );
  }

  /**
   * 自动分配端口
   */
  public static async autoAssignPorts(config: {
    ssePort?: number;
    bridgePort?: number;
    autoResolveConflicts?: boolean;
  }): Promise<{ ssePort: number; bridgePort: number; changed: boolean }> {
    let { ssePort, bridgePort, autoResolveConflicts = true } = config;
    let changed = false;

    // 获取推荐端口作为默认值
    const recommended = await this.getRecommendedPorts();
    ssePort = ssePort || recommended.ssePort;
    bridgePort = bridgePort || recommended.bridgePort;

    if (autoResolveConflicts) {
      // 检查 SSE 端口
      if (!(await this.isPortAvailable(ssePort))) {
        const newSSEPort = await this.findAvailablePort(ssePort);
        if (newSSEPort !== ssePort) {
          ssePort = newSSEPort;
          changed = true;
        }
      }

      // 检查 Bridge 端口
      if (!(await this.isPortAvailable(bridgePort))) {
        const newBridgePort = await this.findAvailablePort(bridgePort);
        if (newBridgePort !== bridgePort) {
          bridgePort = newBridgePort;
          changed = true;
        }
      }

      // 确保两个端口不冲突
      if (ssePort === bridgePort) {
        bridgePort = await this.findAvailablePort(bridgePort + 1);
        changed = true;
      }
    }

    return { ssePort, bridgePort, changed };
  }

  /**
   * 等待端口可用
   */
  public static async waitForPort(
    port: number,
    timeout: number = 30000,
    interval: number = 1000
  ): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      if (await this.isPortAvailable(port)) {
        return true;
      }
      
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    return false;
  }

  /**
   * 获取端口使用建议
   */
  public static getPortUsageRecommendations(): string[] {
    return [
      '• Use ports 8000-8999 for development servers',
      '• Avoid common ports like 8080, 3000, 5000',
      '• SSE and Bridge ports should be different',
      '• Consider firewall settings for chosen ports',
      '• Document port assignments in project config'
    ];
  }
}

// 导出便捷函数
export const isPortAvailable = PortManager.isPortAvailable;
export const findAvailablePort = PortManager.findAvailablePort;
export const getRecommendedPorts = PortManager.getRecommendedPorts;
export const autoAssignPorts = PortManager.autoAssignPorts;