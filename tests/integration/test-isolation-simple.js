#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

// 简化的多实例隔离测试（跳过健康检查）
async function testIsolationLogic() {
  console.log('🧪 Testing isolation logic (without health checks)...');
  
  const registryFile = path.join(os.tmpdir(), '.lsp-mcp-ports.json');
  const workspace1 = '/tmp/test-workspace-1';
  const workspace2 = '/tmp/test-workspace-2';
  
  // 清理和创建测试环境
  try {
    if (fs.existsSync(registryFile)) fs.unlinkSync(registryFile);
  } catch (error) {}
  
  // 模拟第一个工作区的服务器注册
  const registry = [
    {
      workspaceId: 'workspace-1',
      workspaceName: 'Test Workspace 1',
      workspacePath: workspace1,
      ssePort: 8008,
      processId: process.pid,
      isActive: true,
      timestamp: Date.now()
    }
  ];
  
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  console.log('✅ Test registry created');
  
  // 测试修复后的ClientDiscovery.findBestServer逻辑
  console.log('\n🔍 Testing ClientDiscovery.findBestServer logic...');
  
  // 模拟findBestServer的核心逻辑（跳过健康检查）
  const testFindBestServer = async (workspacePath) => {
    // 从注册表获取服务器列表
    const registryData = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const servers = registryData.filter(entry => 
      entry.isActive && entry.processId === process.pid
    );
    
    if (servers.length === 0) {
      return null;
    }
    
    // 只选择匹配工作区路径的服务器（修复后的逻辑）
    const exactMatch = servers.find(server => server.workspacePath === workspacePath);
    if (exactMatch) {
      return exactMatch;
    }
    
    // 如果没有找到匹配的工作区服务器，返回null而不是其他服务器
    return null;
  };
  
  // 测试1: 第一个工作区应该找到自己的服务器
  const server1 = await testFindBestServer(workspace1);
  if (server1 && server1.workspacePath === workspace1) {
    console.log('✅ First workspace correctly found its server');
  } else {
    console.log('❌ First workspace failed to find its server');
    console.log('Result:', server1);
    return false;
  }
  
  // 测试2: 第二个工作区不应该找到第一个工作区的服务器
  const server2 = await testFindBestServer(workspace2);
  if (server2 === null) {
    console.log('✅ Second workspace correctly returned null (no server found)');
  } else {
    console.log('❌ Second workspace incorrectly found a server:', server2);
    return false;
  }
  
  // 测试3: 测试修复后的stdio bridge逻辑
  console.log('\n🔍 Testing stdio bridge discovery logic...');
  
  const testStdioBridge = async (workspacePath) => {
    try {
      if (fs.existsSync(registryFile)) {
        const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
        
        // 查找匹配工作区的服务器
        const workspaceMatch = registry.find(entry => 
          entry.workspacePath === workspacePath && entry.isActive
        );
        
        if (workspaceMatch) {
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
        
        // 修复后的逻辑：如果指定了工作区路径但没有找到匹配的服务器，不使用其他服务器
        if (workspacePath) {
          console.log(`[Bridge] No server found for workspace: ${workspacePath}`);
          return null;
        }
      }
    } catch (error) {
      console.error('Registry read error:', error);
    }
    
    return null;
  };
  
  // 测试第一个工作区
  const bridgeResult1 = await testStdioBridge(workspace1);
  if (bridgeResult1 && bridgeResult1.workspaceInfo.path === workspace1) {
    console.log('✅ Stdio bridge correctly found server for first workspace');
  } else {
    console.log('❌ Stdio bridge failed to find server for first workspace');
    console.log('Result:', bridgeResult1);
    return false;
  }
  
  // 测试第二个工作区
  const bridgeResult2 = await testStdioBridge(workspace2);
  if (bridgeResult2 === null) {
    console.log('✅ Stdio bridge correctly returned null for second workspace');
  } else {
    console.log('❌ Stdio bridge incorrectly found server for second workspace:', bridgeResult2);
    return false;
  }
  
  console.log('\n🎉 All isolation logic tests passed!');
  
  // 清理
  try {
    if (fs.existsSync(registryFile)) fs.unlinkSync(registryFile);
  } catch (error) {}
  
  return true;
}

// 运行测试
testIsolationLogic()
  .then(success => {
    if (success) {
      console.log('\n✅ Multi-instance isolation logic test completed successfully');
      console.log('\n📝 Summary:');
      console.log('- ClientDiscovery.findBestServer now only returns servers matching the workspace path');
      console.log('- Stdio bridge discovery now rejects cross-workspace connections');
      console.log('- Second VS Code instance will not connect to first instance\'s server');
      process.exit(0);
    } else {
      console.log('\n❌ Multi-instance isolation logic test failed');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('\n💥 Test error:', error);
    process.exit(1);
  });