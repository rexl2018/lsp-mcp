import * as vscode from 'vscode';

/**
 * 输出通道服务
 * 提供全局共享的输出通道，避免创建多个同名通道
 */
class OutputChannelService {
  private channels: Map<string, vscode.OutputChannel> = new Map();

  /**
   * 获取或创建输出通道
   * @param name 通道名称
   * @returns 输出通道实例
   */
  public getOutputChannel(name: string): vscode.OutputChannel {
    if (!this.channels.has(name)) {
      const channel = vscode.window.createOutputChannel(name);
      this.channels.set(name, channel);
    }
    return this.channels.get(name)!;
  }

  /**
   * 获取LSP MCP输出通道
   * @returns LSP MCP输出通道
   */
  public getLspMcpChannel(): vscode.OutputChannel {
    return this.getOutputChannel('LSP MCP');
  }

  /**
   * 清理所有通道
   */
  public dispose(): void {
    for (const channel of this.channels.values()) {
      channel.dispose();
    }
    this.channels.clear();
  }
}

// 导出单例实例
export const outputChannelService = new OutputChannelService();