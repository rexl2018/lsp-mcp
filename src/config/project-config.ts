import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ProjectConfig {
  name: string;
  ssePort?: number;
  bridgePort?: number;
  mode?: 'bridge' | 'sse';
  autoStart?: boolean;
  corsOrigins?: string[];
  endpoints?: {
    [key: string]: string;
  };
}

export interface MultiProjectConfig {
  projects: {
    [projectPath: string]: ProjectConfig;
  };
  defaultConfig: ProjectConfig;
}

export class ProjectConfigManager {
  private static readonly CONFIG_FILE_NAME = 'lsp-mcp.config.json';
  private configCache: Map<string, ProjectConfig> = new Map();

  /**
   * 获取当前工作区的项目配置
   */
  public getCurrentProjectConfig(): ProjectConfig {
    const workspaceFolder = this.getCurrentWorkspaceFolder();
    if (!workspaceFolder) {
      return this.getDefaultConfig();
    }

    const projectPath = workspaceFolder.uri.fsPath;
    return this.getProjectConfig(projectPath);
  }

  /**
   * 获取指定项目路径的配置
   */
  public getProjectConfig(projectPath: string): ProjectConfig {
    // 检查缓存
    if (this.configCache.has(projectPath)) {
      return this.configCache.get(projectPath)!;
    }

    // 尝试从项目根目录读取配置文件
    const configPath = path.join(projectPath, ProjectConfigManager.CONFIG_FILE_NAME);
    let projectConfig = this.loadConfigFromFile(configPath);

    if (!projectConfig) {
      // 如果没有项目特定配置，使用默认配置
      projectConfig = this.getDefaultConfig();
      projectConfig.name = path.basename(projectPath);
    }

    // 合并全局配置
    const globalConfig = this.getGlobalConfig();
    projectConfig = this.mergeConfigs(globalConfig, projectConfig);

    // 缓存配置
    this.configCache.set(projectPath, projectConfig);
    return projectConfig;
  }

  /**
   * 保存项目配置
   */
  public async saveProjectConfig(projectPath: string, config: ProjectConfig): Promise<void> {
    const configPath = path.join(projectPath, ProjectConfigManager.CONFIG_FILE_NAME);
    
    try {
      const configJson = JSON.stringify(config, null, 2);
      await fs.promises.writeFile(configPath, configJson, 'utf8');
      
      // 更新缓存
      this.configCache.set(projectPath, config);
      
      vscode.window.showInformationMessage(
        `Project configuration saved to ${ProjectConfigManager.CONFIG_FILE_NAME}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to save project configuration: ${error}`
      );
      throw error;
    }
  }

  /**
   * 获取默认配置
   */
  public getDefaultConfig(): ProjectConfig {
    const vsCodeConfig = vscode.workspace.getConfiguration('lsp-mcp');
    
    return {
      name: 'default',
      ssePort: vsCodeConfig.get<number>('ssePort', 8008),
      bridgePort: vsCodeConfig.get<number>('port', 8991),
      mode: vsCodeConfig.get<'bridge' | 'sse'>('mode', 'bridge'),
      autoStart: vsCodeConfig.get<boolean>('autoStart', false),
      corsOrigins: ['*'],
      endpoints: {
        health: '/health',
        info: '/info',
        sse: '/sse',
        message: '/message'
      }
    };
  }

  /**
   * 获取全局配置
   */
  private getGlobalConfig(): Partial<ProjectConfig> {
    const vsCodeConfig = vscode.workspace.getConfiguration('lsp-mcp');
    
    return {
      ssePort: vsCodeConfig.get<number>('ssePort'),
      bridgePort: vsCodeConfig.get<number>('port'),
      mode: vsCodeConfig.get<'bridge' | 'sse'>('mode'),
      autoStart: vsCodeConfig.get<boolean>('autoStart')
    };
  }

  /**
   * 从文件加载配置
   */
  private loadConfigFromFile(configPath: string): ProjectConfig | null {
    try {
      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent) as ProjectConfig;
      
      // 验证配置格式
      if (!config.name) {
        config.name = path.basename(path.dirname(configPath));
      }
      
      return config;
    } catch (error) {
      console.error(`Failed to load config from ${configPath}:`, error);
      return null;
    }
  }

  /**
   * 合并配置对象
   */
  private mergeConfigs(base: Partial<ProjectConfig>, override: ProjectConfig): ProjectConfig {
    return {
      ...base,
      ...override,
      endpoints: {
        ...base.endpoints,
        ...override.endpoints
      }
    };
  }

  /**
   * 获取当前工作区文件夹
   */
  private getCurrentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }

    // 如果有活动编辑器，尝试获取其所在的工作区文件夹
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const activeDocument = activeEditor.document;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeDocument.uri);
      if (workspaceFolder) {
        return workspaceFolder;
      }
    }

    // 否则返回第一个工作区文件夹
    return workspaceFolders[0];
  }

  /**
   * 清除配置缓存
   */
  public clearCache(): void {
    this.configCache.clear();
  }

  /**
   * 监听配置文件变化
   */
  public watchConfigFiles(): vscode.Disposable {
    const pattern = `**/${ProjectConfigManager.CONFIG_FILE_NAME}`;
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onConfigChange = (uri: vscode.Uri) => {
      const projectPath = path.dirname(uri.fsPath);
      this.configCache.delete(projectPath);
      console.log(`Config file changed for project: ${projectPath}`);
    };

    watcher.onDidChange(onConfigChange);
    watcher.onDidCreate(onConfigChange);
    watcher.onDidDelete(onConfigChange);

    return watcher;
  }

  /**
   * 创建示例配置文件
   */
  public async createExampleConfig(projectPath?: string): Promise<void> {
    const targetPath = projectPath || this.getCurrentWorkspaceFolder()?.uri.fsPath;
    if (!targetPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const exampleConfig: ProjectConfig = {
      name: path.basename(targetPath),
      ssePort: 8008,
      bridgePort: 8991,
      mode: 'sse',
      autoStart: true,
      corsOrigins: ['*'],
      endpoints: {
        health: '/health',
        info: '/info',
        sse: '/sse',
        message: '/message'
      }
    };

    await this.saveProjectConfig(targetPath, exampleConfig);
  }
}

// 导出单例实例
export const projectConfigManager = new ProjectConfigManager();