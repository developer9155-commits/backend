import express from 'express';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';

const app = express();

const PORT = Number(process.env.PORT || 10000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MAX_BODY = process.env.MAX_BODY_BYTES || '250kb';

const MAX_OUTPUT_TOKENS = Number(
  process.env.MAX_OUTPUT_TOKENS || 32000
);

const GENERATION_RETRIES = Number(
  process.env.GENERATION_RETRIES || 2
);

/* -------------------------------------------------------
   CORS
------------------------------------------------------- */

function parseOrigins(value) {
  if (!value || value === '*') return '*';

  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

const allowedOrigins = parseOrigins(
  process.env.ALLOWED_ORIGINS || '*'
);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins === '*' ||
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }

      return callback(
        new Error('Origin not allowed by CORS')
      );
    },

    methods: ['GET', 'POST', 'OPTIONS'],

    allowedHeaders: [
      'Content-Type',
      'Authorization'
    ]
  })
);

/* -------------------------------------------------------
   BODY PARSER
------------------------------------------------------- */

app.use(
  express.json({
    limit: MAX_BODY
  })
);

/* -------------------------------------------------------
   FIREBASE ADMIN INITIALIZATION
------------------------------------------------------- */

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (raw) {
    try {
      const serviceAccount = JSON.parse(raw);

      return admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } catch (err) {
      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${err.message}`
      );
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin credentials are missing. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.'
    );
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey
    })
  });
}

let firebaseInitError = null;

try {
  initFirebaseAdmin();
} catch (err) {
  firebaseInitError = err;

  console.error(
    'Firebase Admin initialization failed:',
    err?.message || err
  );
}

/* -------------------------------------------------------
   GEMINI
------------------------------------------------------- */

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    })
  : null;

/* -------------------------------------------------------
   RATE LIMITER
------------------------------------------------------- */

const limiter = rateLimit({
  windowMs: 60 * 1000,

  limit: Number(
    process.env.GENERATION_RATE_LIMIT || 8
  ),

  standardHeaders: 'draft-8',

  legacyHeaders: false,

  keyGenerator: req => {
    if (req.user?.uid) {
      return `user:${req.user.uid}`;
    }

    return `ip:${ipKeyGenerator(req.ip)}`;
  },

  handler: (req, res) => {
    return res.status(429).json({
      error:
        'Too many generation requests. Please wait a moment and try again.'
    });
  }
});

/* -------------------------------------------------------
   FIREBASE AUTHENTICATION
------------------------------------------------------- */

async function requireFirebaseUser(req, res, next) {
  const authHeader =
    req.get('Authorization') || '';

  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'A Firebase bearer token is required.'
    });
  }

  if (firebaseInitError) {
    return res.status(500).json({
      error:
        'Firebase Admin authentication is not configured on the backend.'
    });
  }

  try {
    const token = authHeader
      .slice(7)
      .trim();

    if (!token) {
      return res.status(401).json({
        error: 'A Firebase bearer token is required.'
      });
    }

    const decodedToken =
      await admin.auth().verifyIdToken(token);

    req.user = decodedToken;

    next();
  } catch (err) {
    console.warn(
      'Firebase token verification failed:',
      err?.code || err?.message
    );

    return res.status(401).json({
      error:
        'Your Firebase session is invalid or expired. Please sign in again.'
    });
  }
}

/* -------------------------------------------------------
   HEALTH CHECK
------------------------------------------------------- */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'nexora-ai-backend',
    model: MODEL,
    geminiConfigured: Boolean(ai),
    firebaseConfigured: !firebaseInitError,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    generationRetries: GENERATION_RETRIES
  });
});

/* -------------------------------------------------------
   CLEAN GEMINI RESPONSE
------------------------------------------------------- */

function cleanGeminiText(text) {
  if (typeof text !== 'string') {
    return '';
  }

  let cleaned = text.trim();

  /*
    Remove accidental markdown fences.
  */

  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7).trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3).trim();
  }

  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3).trim();
  }

  return cleaned;
}

/* -------------------------------------------------------
   GEMINI JSON PARSER
------------------------------------------------------- */

function parseGeminiJson(text) {
  const cleaned = cleanGeminiText(text);

  if (!cleaned) {
    throw new Error('Gemini returned an empty response.');
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    /*
      Do not try to "repair" HTML/CSS/JS JSON manually.
      A truncated JSON string cannot be safely reconstructed
      because quotes, backslashes and newlines may be missing.
    */

    const positionMatch =
      error?.message?.match(/position (\d+)/i);

    const position = positionMatch
      ? Number(positionMatch[1])
      : null;

    const start =
      position !== null
        ? Math.max(0, position - 500)
        : Math.max(0, cleaned.length - 1500);

    const end =
      position !== null
        ? Math.min(cleaned.length, position + 500)
        : cleaned.length;

    const aroundError =
      cleaned.slice(start, end);

    console.error(
      'Gemini JSON parse error:',
      error?.message
    );

    console.error(
      'Gemini response length:',
      cleaned.length
    );

    console.error(
      'Gemini response near error:',
      aroundError
    );

    throw error;
  }
}

/* -------------------------------------------------------
   GENERATE WEBSITE
------------------------------------------------------- */

async function generateWebsite(system, prompt) {
  const instruction = `
${system}

IMPORTANT OUTPUT RULES:

1. Return ONLY one valid JSON object.
2. Do NOT use markdown code fences.
3. The JSON must contain exactly these fields:
   - html
   - css
   - js
   - message
4. html, css, js and message must all be JSON strings.
5. Properly escape all quotes, backslashes and newlines required by JSON.
6. Make sure the JSON object is completely finished before stopping.
7. NEVER stop in the middle of an HTML, CSS or JavaScript string.
8. Do not include API keys.
9. Do not include Firebase service-account credentials.
10. Do not include server secrets.
11. Do not include backend environment variables.
12. Do not include base64 encoded images.
13. Do not generate unnecessarily huge code.
14. Keep the website professional and complete.
15. Prefer external image URLs, CSS gradients, or lightweight placeholders instead of embedding large image data.
16. Avoid unnecessary comments and repeated code.
17. Make the generated HTML, CSS and JavaScript concise while preserving the requested design and functionality.

CRITICAL:
Before returning the response, verify that:
- all JSON strings are closed
- all JSON brackets are closed
- the final character is the closing } of the JSON object
- html is complete
- css is complete
- js is complete

USER REQUEST:

${prompt}
`;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= GENERATION_RETRIES + 1;
    attempt++
  ) {
    try {
      console.log(
        `Gemini generation attempt ${attempt}/${GENERATION_RETRIES + 1}`
      );

      const response =
        await ai.models.generateContent({
          model: MODEL,

          contents: instruction,

          config: {
            temperature: 0.25,

            maxOutputTokens: MAX_OUTPUT_TOKENS,

            responseMimeType: 'application/json',

            responseSchema: {
              type: 'object',

              properties: {
                html: {
                  type: 'string'
                },

                css: {
                  type: 'string'
                },

                js: {
                  type: 'string'
                },

                message: {
                  type: 'string'
                }
              },

              required: [
                'html',
                'css',
                'js',
                'message'
              ]
            }
          }
        });

      const text =
        typeof response?.text === 'string'
          ? response.text
          : '';

      const finishReason =
        response?.candidates?.[0]?.finishReason ||
        response?.candidates?.[0]?.finish_reason ||
        'unknown';

      console.log(
        `Gemini response length: ${text.length}`
      );

      console.log(
        `Gemini finish reason: ${finishReason}`
      );

      if (!text.trim()) {
        throw new Error(
          'Gemini returned an empty response.'
        );
      }

      /*
        If the model stopped because it reached the
        output limit, retry instead of immediately
        sending an invalid JSON response to frontend.
      */

      const normalizedFinishReason =
        String(finishReason).toUpperCase();

      if (
        normalizedFinishReason.includes('MAX_TOKENS') ||
        normalizedFinishReason.includes('LENGTH')
      ) {
        console.warn(
          'Gemini response appears to have been truncated.'
        );

        throw new Error(
          'Gemini response was truncated because it reached the output limit.'
        );
      }

      const result =
        parseGeminiJson(text);

      /*
        Validate generated website.
      */

      if (
        !result ||
        typeof result.html !== 'string' ||
        !result.html.trim()
      ) {
        throw new Error(
          'Gemini returned an incomplete website.'
        );
      }

      /*
        Make optional fields safe.
      */

      if (typeof result.css !== 'string') {
        result.css = '';
      }

      if (typeof result.js !== 'string') {
        result.js = '';
      }

      if (typeof result.message !== 'string') {
        result.message = '';
      }

      /*
        Basic sanity checks.
      */

      if (result.html.length < 50) {
        throw new Error(
          'Gemini returned HTML that is too short.'
        );
      }

      console.log(
        `Generation successful on attempt ${attempt}`
      );

      return result;

    } catch (error) {
      lastError = error;

      console.error(
        `Gemini attempt ${attempt} failed:`,
        error?.message || error
      );

      /*
        Retry only for generation/JSON problems.

        API authentication, quota and invalid-request
        errors should not be unnecessarily retried.
      */

      const status =
        Number(error?.status) || 0;

      if (
        status === 400 ||
        status === 401 ||
        status === 403 ||
        status === 429
      ) {
        throw error;
      }

      if (
        attempt <= GENERATION_RETRIES
      ) {
        console.log(
          'Retrying Gemini generation...'
        );

        await new Promise(resolve =>
          setTimeout(resolve, 800)
        );
      }
    }
  }

  throw lastError ||
    new Error(
      'Gemini failed to generate a complete website.'
    );
}

/* -------------------------------------------------------
   AI GENERATION ROUTE
------------------------------------------------------- */

app.post(
  '/generate',
  requireFirebaseUser,
  limiter,
  async (req, res) => {

    if (!ai) {
      return res.status(500).json({
        error:
          'Gemini API is not configured on the backend.'
      });
    }

    const system =
      typeof req.body?.system === 'string'
        ? req.body.system.trim()
        : '';

    const prompt =
      typeof req.body?.prompt === 'string'
        ? req.body.prompt.trim()
        : '';

    if (!system || !prompt) {
      return res.status(400).json({
        error:
          'Both system instructions and prompt are required.'
      });
    }

    if (prompt.length > 120000) {
      return res.status(413).json({
        error:
          'The request is too large. Please shorten the project or files.'
      });
    }

    try {
      console.log(
        `Generation request from Firebase user: ${
          req.user?.uid || 'unknown'
        }`
      );

      const result =
        await generateWebsite(
          system,
          prompt
        );

      console.log(
        `Generation successful for user: ${
          req.user?.uid || 'unknown'
        }`
      );

      return res.json({
        result
      });

    } catch (err) {

      console.error(
        'Gemini generation error:',
        err?.message || err
      );

      console.error(
        'Gemini error status:',
        err?.status || 'unknown'
      );

      console.error(
        'Gemini error code:',
        err?.code || 'unknown'
      );

      const status =
        Number(err?.status) || 500;

      /*
        Gemini rate limit
      */

      if (status === 429) {
        return res.status(429).json({
          error:
            'Gemini rate limit reached. Please wait a moment and try again.'
        });
      }

      /*
        Invalid request
      */

      if (status === 400) {
        return res.status(400).json({
          error:
            'Gemini rejected the request. Try a shorter or clearer prompt.'
        });
      }

      /*
        Authentication/API key problem
      */

      if (
        status === 401 ||
        status === 403
      ) {
        return res.status(502).json({
          error:
            'The Gemini API authentication failed. Please check the Gemini API key configured in Render.'
        });
      }

      /*
        Truncated/incomplete JSON.
      */

      if (
        err?.message?.includes(
          'truncated'
        ) ||
        err?.message?.includes(
          'Unterminated'
        ) ||
        err?.message?.includes(
          'Unexpected end'
        ) ||
        err?.message?.includes(
          'incomplete website'
        )
      ) {
        return res.status(502).json({
          error:
            'The AI generated an incomplete website after multiple attempts. Please try generating again or use a slightly shorter prompt.'
        });
      }

      /*
        General Gemini/server problem
      */

      return res.status(502).json({
        error:
          'The AI service is temporarily unavailable. Please try again.'
      });
    }
  }
);

/* -------------------------------------------------------
   GLOBAL ERROR HANDLER
------------------------------------------------------- */

app.use((err, req, res, next) => {

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request is too large.'
    });
  }

  if (
    err?.message ===
    'Origin not allowed by CORS'
  ) {
    return res.status(403).json({
      error: 'Origin not allowed.'
    });
  }

  console.error(
    'Unhandled server error:',
    err
  );

  return res.status(500).json({
    error: 'Internal server error.'
  });
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Nexora AI backend listening on 0.0.0.0:${PORT}`
    );

    console.log(
      `Gemini model: ${MODEL}`
    );

    console.log(
      `Gemini max output tokens: ${MAX_OUTPUT_TOKENS}`
    );

    console.log(
      `Gemini generation retries: ${GENERATION_RETRIES}`
    );

    console.log(
      `Gemini API: ${
        ai ? 'configured' : 'NOT CONFIGURED'
      }`
    );

    console.log(
      `Firebase Admin: ${
        firebaseInitError
          ? 'NOT CONFIGURED'
          : 'ready'
      }`
    );
  }
);
