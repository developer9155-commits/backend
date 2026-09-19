const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = 500_000;
const MAX_PROMPT_SIZE = 20_000;
const MAX_REQUEST_SIZE = '2mb';
const storageRoot = path.resolve(__dirname, '..', process.env.STORAGE_DIR || 'runtime/sites');

function cleanText(value, max, field) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const cleaned = value.replace(/\0/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (cleaned.length > max) throw new HttpError(413, `${field} exceeds the maximum size`);
  return cleaned;
}

function cleanFiles(files, required = true) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    if (!required) return null;
    throw new HttpError(400, 'files must be an object containing html, css, and js');
  }
  return {
    html: cleanText(files.html || '', MAX_FILE_SIZE, 'files.html'),
    css: cleanText(files.css || '', MAX_FILE_SIZE, 'files.css'),
    js: cleanText(files.js || '', MAX_FILE_SIZE, 'files.js')
  };
}

function slug(value, field) {
  const result = cleanText(value, 63, field).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(result)) {
    throw new HttpError(400, `${field} must contain only letters, numbers, and hyphens`);
  }
  return result;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const origins = (process.env.CORS_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
app.use(helmet());
app.use(cors({
  origin: origins.length ? origins : true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  limit: Number(process.env.RATE_LIMIT_MAX || 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

let firebaseAuth;
async function verifyAuth(req, _res, next) {
  if (String(process.env.REQUIRE_AUTH).toLowerCase() !== 'true') return next();
  try {
    if (!firebaseAuth) {
      let admin;
      try { admin = require('firebase-admin'); } catch { throw new Error('firebase-admin is not installed'); }
      if (!admin.apps.length) {
        const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
        if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
          throw new Error('Firebase Admin credentials are not configured');
        }
        admin.initializeApp({ credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey
        }) });
      }
      firebaseAuth = admin.auth();
    }
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'A Firebase bearer token is required');
    req.user = await firebaseAuth.verifyIdToken(header.slice(7));
    return next();
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    return next(new HttpError(401, 'Invalid or unverifiable Firebase bearer token'));
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'vasuaihosting-backend' }));

app.post('/api/generate', verifyAuth, async (req, res, next) => {
  try {
    const prompt = cleanText(req.body && req.body.prompt, MAX_PROMPT_SIZE, 'prompt');
    if (!prompt) throw new HttpError(400, 'prompt is required');
    const existingFiles = req.body && req.body.existingFiles ? cleanFiles(req.body.existingFiles, false) : null;
    if (!process.env.GEMINI_API_KEY) throw new HttpError(503, 'Gemini API is not configured');
    const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            html: { type: 'STRING' },
            css: { type: 'STRING' },
            js: { type: 'STRING' },
            message: { type: 'STRING' }
          },
          required: ['html', 'css', 'js', 'message']
        }
      }
    });
    const context = existingFiles ? `\nExisting files to improve:\n${JSON.stringify(existingFiles)}` : '';
    const result = await model.generateContent(
      `Return only a JSON object matching the requested schema. Generate a complete, accessible website for this request: ${prompt}${context}`
    );
    const raw = result.response.text();
    let output;
    try { output = JSON.parse(raw); } catch { throw new HttpError(502, 'Gemini returned invalid JSON'); }
    const files = cleanFiles(output, true);
    const message = cleanText(output.message || 'Website generated successfully.', 2_000, 'message');
    return res.json({ files, message });
  } catch (error) { return next(error); }
});

app.post('/api/deployments', verifyAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const projectName = cleanText(body.projectName, 120, 'projectName');
    const subdomain = slug(body.subdomain, 'subdomain');
    const visibility = body.visibility === 'private' ? 'private' : 'public';
    const files = cleanFiles(body.files);
    if (String(process.env.DEPLOYMENT_MODE).toLowerCase() !== 'local') {
      return res.status(501).json({
        error: 'deployment_provider_unavailable',
        message: 'No hosting provider is configured. Set DEPLOYMENT_MODE=local for local deployments.'
      });
    }
    const destination = path.join(storageRoot, subdomain);
    await fs.mkdir(destination, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(destination, 'index.html'), files.html, 'utf8'),
      fs.writeFile(path.join(destination, 'style.css'), files.css, 'utf8'),
      fs.writeFile(path.join(destination, 'script.js'), files.js, 'utf8'),
      fs.writeFile(path.join(destination, 'metadata.json'), JSON.stringify({ projectName, visibility }, null, 2), 'utf8')
    ]);
    const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
    return res.status(201).json({ url: `${base}/sites/${subdomain}/`, subdomain, visibility, message: 'Deployment saved locally.' });
  } catch (error) { return next(error); }
});

app.use('/sites', express.static(storageRoot, { index: 'index.html', dotfiles: 'deny' }));
app.use((req, _res, next) => next(new HttpError(404, 'Route not found')));
app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status === 500 ? 'internal_server_error' : 'request_error', message: status === 500 ? 'An unexpected server error occurred.' : error.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Vasu AI backend listening on port ${PORT}`));
}

module.exports = app;
