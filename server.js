const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Load .env file manually (no dotenv dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && !key.startsWith('#')) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  });
}

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_WS_URL = 'wss://api.x.ai/v1/realtime';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server for client connections
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('📱 Client connected');

  // Connect to xAI with Authorization header
  const xaiWs = new WebSocket(XAI_WS_URL, {
    headers: {
      'Authorization': `Bearer ${XAI_API_KEY}`
    }
  });

  xaiWs.on('open', () => {
    console.log('🔗 Connected to xAI Voice API');
    clientWs.send(JSON.stringify({ type: 'proxy.connected' }));
  });

  xaiWs.on('message', (data) => {
    // Forward xAI messages to client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  xaiWs.on('error', (error) => {
    console.error('❌ xAI WebSocket error:', error.message);
    clientWs.send(JSON.stringify({
      type: 'error',
      error: { message: `xAI connection error: ${error.message}` }
    }));
  });

  xaiWs.on('close', (code, reason) => {
    console.log(`🔌 xAI connection closed: ${code} ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason.toString());
    }
  });

  // Forward client messages to xAI
  clientWs.on('message', (data) => {
    if (xaiWs.readyState === WebSocket.OPEN) {
      xaiWs.send(data.toString());
    }
  });

  clientWs.on('close', () => {
    console.log('📴 Client disconnected');
    if (xaiWs.readyState === WebSocket.OPEN) {
      xaiWs.close();
    }
  });

  clientWs.on('error', (error) => {
    console.error('❌ Client WebSocket error:', error.message);
  });
});

server.listen(PORT, () => {
  console.log(`🎙️  Grok Voice Agent Test Server running at http://localhost:${PORT}`);
  console.log(`   WebSocket proxy at ws://localhost:${PORT}/ws`);
  console.log(`   API Key configured: ${XAI_API_KEY ? '✓' : '✗ (missing)'}`);
});
