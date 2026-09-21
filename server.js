import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const MAX_BODY = process.env.MAX_BODY_BYTES || '250kb';

function parseOrigins(value) {
  if (!value || value === '*') return '*';
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS || '*');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins === '*' || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: MAX_BODY }));

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin credentials are missing. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.');
  }
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}

let firebaseInitError = null;
try { initFirebaseAdmin(); } catch (err) { firebaseInitError = err; }

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.GENERATION_RATE_LIMIT || 8),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => req.user?.uid || req.ip
});

async function requireFirebaseUser(req, res, next) {
  const auth = req.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'A Firebase bearer token is required.' });
  if (firebaseInitError) return res.status(500).json({ error: 'Firebase Admin authentication is not configured on the backend.' });
  try {
    const token = auth.slice(7).trim();
    if (!token) return res.status(401).json({ error: 'A Firebase bearer token is required.' });
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (err) {
    console.warn('Firebase token verification failed:', err?.code || err?.message);
    return res.status(401).json({ error: 'Your Firebase session is invalid or expired. Please sign in again.' });
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'nexora-ai-backend',
    model: MODEL,
    geminiConfigured: Boolean(ai),
    firebaseConfigured: !firebaseInitError
  });
});

app.post('/generate', requireFirebaseUser, limiter, async (req, res) => {
  if (!ai) return res.status(500).json({ error: 'Gemini API is not configured on the backend.' });
  const system = typeof req.body?.system === 'string' ? req.body.system.trim() : '';
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!system || !prompt) return res.status(400).json({ error: 'Both system instructions and prompt are required.' });
  if (prompt.length > 120000) return res.status(413).json({ error: 'The request is too large. Please shorten the project or files.' });

  const instruction = `${system}\n\nIMPORTANT OUTPUT RULES:\n- Return only the requested JSON object.\n- Do not wrap it in markdown fences.\n- Keep html, css and js complete and self-contained as requested.\n- Never include API keys, Firebase service-account credentials, server secrets, or backend environment variables in generated code.\n\n${prompt}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: instruction,
      config: {
        temperature: 0.35,
        maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 24000),
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            html: { type: 'string' },
            css: { type: 'string' },
            js: { type: 'string' },
            message: { type: 'string' }
          },
          required: ['html', 'css', 'js', 'message']
        }
      }
    });

    let result;
    try { result = JSON.parse(response.text || '{}'); }
    catch { return res.status(502).json({ error: 'Gemini returned invalid JSON. Please try again.' }); }

    if (!result.html || typeof result.html !== 'string') {
      return res.status(502).json({ error: 'Gemini returned an incomplete website. Please try again.' });
    }

    return res.json({ result });
  } catch (err) {
    const status = Number(err?.status) || 500;
    console.error('Gemini generation error:', err?.message || err);
    if (status === 429) return res.status(429).json({ error: 'Gemini rate limit reached. Please wait a moment and try again.' });
    if (status === 400) return res.status(400).json({ error: 'Gemini rejected the request. Try a shorter or clearer prompt.' });
    return res.status(502).json({ error: 'The AI service is temporarily unavailable. Please try again.' });
  }
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err?.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed.' });
  console.error('Unhandled server error:', err);
  return res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nexora AI backend listening on 0.0.0.0:${PORT}`);
  console.log(`Gemini model: ${MODEL}`);
  console.log(`Firebase Admin: ${firebaseInitError ? 'NOT CONFIGURED' : 'ready'}`);
});
