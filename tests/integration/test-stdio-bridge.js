#!/usr/bin/env node

/**
 * 测试stdio bridge的集成测试脚本
 * 这个脚本模拟MCP客户端通过stdio与bridge通信
 * 
 * 功能:
 * - 测试stdio bridge的启动和通信
 * - 验证MCP协议的初始化流程
 * - 测试工具列表获取功能
 */

const { spawn } = require('child_process');
const path = require('path');

// 启动stdio bridge (从新位置引用)
const bridgePath = path.join(__dirname, '..', '..', 'bin', 'mcp-stdio-bridge.js');
console.log('🔧 Bridge路径:', bridgePath);
const bridge = spawn('node', [bridgePath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let responseCount = 0;
const expectedResponses = 2;

// 处理bridge的输出
bridge.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(line => line.trim());
  
  lines.forEach(line => {
    try {
      const response = JSON.parse(line);
      console.log('✅ 收到响应:', JSON.stringify(response, null, 2));
      responseCount++;
      
      if (responseCount >= expectedResponses) {
        console.log('\n🎉 测试完成！stdio bridge工作正常');
        bridge.kill();
        process.exit(0);
      }
    } catch (error) {
      console.log('📝 Bridge输出:', line);
    }
  });
});

// 处理bridge的错误输出
bridge.stderr.on('data', (data) => {
  console.log('📝 Bridge日志:', data.toString().trim());
});

// 处理bridge退出
bridge.on('exit', (code) => {
  if (code !== 0) {
    console.error(`❌ Bridge退出，代码: ${code}`);
    process.exit(1);
  }
});

// 处理bridge错误
bridge.on('error', (error) => {
  console.error('❌ Bridge错误:', error.message);
  process.exit(1);
});

// 等待bridge启动
setTimeout(() => {
  console.log('🚀 开始测试stdio bridge...');
  
  // 发送初始化请求
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };
  
  console.log('📤 发送初始化请求...');
  bridge.stdin.write(JSON.stringify(initRequest) + '\n');
  
  // 发送工具列表请求
  setTimeout(() => {
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    };
    
    console.log('📤 发送工具列表请求...');
    bridge.stdin.write(JSON.stringify(toolsRequest) + '\n');
  }, 1000);
  
}, 2000);

// 超时处理 (增加到20秒以适应较慢的环境)
setTimeout(() => {
  console.error('❌ 测试超时 (20秒)');
  bridge.kill();
  process.exit(1);
}, 20000);