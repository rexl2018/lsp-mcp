const http = require('http');
const EventSource = require('eventsource');

/**
 * SSE服务器集成测试脚本
 * 
 * 功能:
 * - 测试SSE连接的建立和维护
 * - 验证健康检查和服务器信息端点
 * - 测试MCP消息的发送和接收
 * - 验证事件流的正确处理
 */

// 测试 SSE 连接和基本功能
async function testSSEConnection() {
  console.log('\n=== MCP Server SSE Test ===');
  
  const sseUrl = 'http://localhost:8008/sse';
  const healthUrl = 'http://localhost:8008/health';
  const infoUrl = 'http://localhost:8008/info';
  
  try {
    // 测试健康检查端点
    console.log('\n1. Testing health endpoint...');
    const healthResponse = await makeHttpRequest(healthUrl);
    console.log('Health check response:', healthResponse);
    
    // 测试服务器信息端点
    console.log('\n2. Testing info endpoint...');
    const infoResponse = await makeHttpRequest(infoUrl);
    console.log('Server info response:', infoResponse);
    
    // 测试 SSE 连接
    console.log('\n3. Testing SSE connection...');
    const eventSource = new EventSource(sseUrl);
    
    eventSource.onopen = () => {
      console.log('✅ SSE connection opened successfully');
    };
    
    eventSource.onmessage = (event) => {
      console.log('📨 Received SSE message:', event.data);
    };
    
    eventSource.addEventListener('connected', (event) => {
      console.log('🔗 Connected event:', event.data);
    });
    
    eventSource.addEventListener('message', (event) => {
      console.log('💬 MCP message event:', event.data);
    });
    
    eventSource.onerror = (error) => {
      console.error('❌ SSE connection error:', error);
    };
    
    // 等待连接建立
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 测试发送 MCP 消息
    console.log('\n4. Testing MCP message sending...');
    const testMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    };
    
    const messageResponse = await sendMcpMessage('http://localhost:8008/message', testMessage);
    console.log('MCP message response:', messageResponse);
    
    // 等待可能的 SSE 响应
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    eventSource.close();
    console.log('\n✅ SSE test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.log('\n📋 使用说明:');
    console.log('1. 启动 VS Code 扩展');
    console.log('2. 运行 "Start MCP Server" 命令启动 SSE 服务器');
    console.log('3. 确保 SSE 服务器在端口 8008 上运行');
    console.log('4. 检查防火墙设置是否允许本地连接');
  }
}

function makeHttpRequest(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('HTTP请求超时 (10秒)'));
    });
  });
}

function sendMcpMessage(url, message) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(message);
    
    const options = {
      hostname: 'localhost',
      port: 8008,
      path: '/message',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 运行测试
if (require.main === module) {
  testSSEConnection().catch(console.error);
}

module.exports = { testSSEConnection };