require('dotenv').config();
const express = require('express');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- CORS -------------------------------------------------------------
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ ok: true, service: 'nexora-ai-proxy' }));
app.get('/health', (req, res) => res.json({ ok: true }));

// TEMPORARY DIAGNOSTIC — remove this route once GEMINI_API_KEY is confirmed working.
// Visit https://backend-1-64lh.onrender.com/debug-env in your browser to check.
app.get('/debug-env', (req, res) => {
  res.json({
    node_env: process.env.NODE_ENV || null,
    port: process.env.PORT || null,
    gemini_api_key_present: !!process.env.GEMINI_API_KEY,
    gemini_api_key_length: (process.env.GEMINI_API_KEY || '').length,
    gemini_api_key_prefix: (process.env.GEMINI_API_KEY || '').slice(0, 4) || null,
    app_secret_present: !!process.env.APP_SECRET,
    allowed_origin: process.env.ALLOWED_ORIGIN || null,
    gemini_model: process.env.GEMINI_MODEL || null,
    all_env_keys: Object.keys(process.env).sort()
  });
});

async function callGemini(system, prompt) {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json'
    }
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const rawText = await r.text();
  let j = null;
  try { j = JSON.parse(rawText); } catch (e) {}

  if (!r.ok) {
    if (r.status === 403 && !j) {
      const err = new Error('Gemini rejected this request as coming from an unsupported region. See the README troubleshooting section.');
      err.status = 502;
      throw err;
    }
    const msg = (j && j.error && j.error.message) || `Gemini request failed (${r.status})`;
    const err = new Error(msg);
    err.status = r.status === 429 ? 429 : 502;
    throw err;
  }

  const candidate = j && j.candidates && j.candidates[0];
  const finishReason = candidate && candidate.finishReason;
  const text = (candidate && candidate.content && candidate.content.parts &&
    candidate.content.parts.map(p => p.text || '').join('')) || '';

  let out = null;
  try { out = JSON.parse(text); } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { out = JSON.parse(m[0]); } catch (e2) {} }
  }

  if (!out || typeof out.html !== 'string') {
    const err = new Error(
      finishReason === 'MAX_TOKENS'
        ? 'The AI response was cut off. Try a shorter or simpler request.'
        : 'The AI returned an unusable response. Try again.'
    );
    err.status = 502;
    throw err;
  }

  return out;
}

app.post('/generate', async (req, res) => {
  if (process.env.APP_SECRET) {
    if (req.get('X-App-Secret') !== process.env.APP_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured: missing GEMINI_API_KEY.' });
  }

  const system = String((req.body && req.body.system) || '').slice(0, 20000);
  const prompt = String((req.body && req.body.prompt) || '').slice(0, 20000);
  if (!prompt) return res.status(400).json({ error: 'Missing "prompt"' });

  try {
    const result = await callGemini(system, prompt);
    res.json({ result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Generation failed' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexora AI proxy listening on :${PORT}`));
