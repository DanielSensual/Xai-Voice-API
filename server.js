const express = require('express');
const path = require('path');
const fs = require('fs');

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
const SESSION_REQUEST_URL = 'https://api.x.ai/v1/realtime/client_secrets';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ephemeral token endpoint for secure client-side authentication
app.post('/session', async (req, res) => {
  if (!XAI_API_KEY) {
    return res.status(500).json({ error: 'XAI_API_KEY not configured' });
  }

  try {
    const response = await fetch(SESSION_REQUEST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expires_after: { seconds: 300 } }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('xAI API error:', response.status, errorText);
      return res.status(response.status).json({ error: 'Failed to get ephemeral token' });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Session request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🎙️  Grok Voice Agent Test Server running at http://localhost:${PORT}`);
  console.log(`   API Key configured: ${XAI_API_KEY ? '✓' : '✗ (missing)'}`);
});
