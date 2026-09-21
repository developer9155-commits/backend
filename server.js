import express from 'express';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';

const app = express();

const PORT = Number(process.env.PORT || 10000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const MAX_BODY = process.env.MAX_BODY_BYTES || '250kb';

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
      // Allow requests without an Origin header
      // and allow all origins when configured as *
      if (
        !origin ||
        allowedOrigins === '*' ||
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed by CORS'));
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
  // Prevent duplicate initialization
  if (admin.apps.length) {
    return admin.app();
  }

  /*
    Option 1:
    FIREBASE_SERVICE_ACCOUNT_JSON
  */

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

  /*
    Option 2:
    Separate Firebase credentials
  */

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

/*
  Initialize Firebase once when server starts.
*/

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

/*
  IMPORTANT:

  express-rate-limit requires ipKeyGenerator()
  when using req.ip because IPv6 addresses need
  to be normalized correctly.

  Logged-in users are limited by Firebase UID.

  Unauthenticated requests are limited by IP.
*/

const limiter = rateLimit({
  windowMs: 60 * 1000,

  limit: Number(
    process.env.GENERATION_RATE_LIMIT || 8
  ),

  standardHeaders: 'draft-8',

  legacyHeaders: false,

  keyGenerator: req => {
    // Firebase user
    if (req.user?.uid) {
      return `user:${req.user.uid}`;
    }

    // IPv4 / IPv6-safe IP key
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
  const authHeader = req.get('Authorization') || '';

  /*
    Expected:

    Authorization: Bearer FIREBASE_ID_TOKEN
  */

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
    firebaseConfigured: !firebaseInitError
  });
});

/* -------------------------------------------------------
   AI GENERATION
------------------------------------------------------- */

app.post(
  '/generate',
  requireFirebaseUser,
  limiter,
  async (req, res) => {
    /*
      Make sure Gemini is configured.
    */

    if (!ai) {
      return res.status(500).json({
        error:
          'Gemini API is not configured on the backend.'
      });
    }

    /*
      Validate request body.
    */

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

    /*
      Prevent extremely large prompts.
    */

    if (prompt.length > 120000) {
      return res.status(413).json({
        error:
          'The request is too large. Please shorten the project or files.'
      });
    }

    /*
      Gemini instruction.
    */

    const instruction = `
${system}

IMPORTANT OUTPUT RULES:

- Return only the requested JSON object.
- Do not wrap the JSON in markdown fences.
- Keep html, css and js complete and self-contained as requested.
- Never include API keys.
- Never include Firebase service-account credentials.
- Never include server secrets.
- Never include backend environment variables in generated code.

${prompt}
`;

    try {
      console.log(
        `Generation request from Firebase user: ${req.user?.uid || 'unknown'}`
      );

      const response =
        await ai.models.generateContent({
          model: MODEL,

          contents: instruction,

          config: {
            temperature: 0.35,

            maxOutputTokens: Number(
              process.env.MAX_OUTPUT_TOKENS || 24000
            ),

            responseMimeType:
              'application/json',

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

      /*
        Gemini response
      */

      const text =
        typeof response?.text === 'string'
          ? response.text
          : '';

      if (!text) {
        console.error(
          'Gemini returned an empty response.'
        );

        return res.status(502).json({
          error:
            'Gemini returned an empty response. Please try again.'
        });
      }

      /*
        Parse JSON returned by Gemini.
      */

      let result;

      try {
        result = JSON.parse(text);
      } catch (parseError) {
        console.error(
          'Gemini JSON parse error:',
          parseError?.message
        );

        console.error(
          'Gemini raw response:',
          text.slice(0, 2000)
        );

        return res.status(502).json({
          error:
            'Gemini returned invalid JSON. Please try again.'
        });
      }

      /*
        Validate generated website.
      */

      if (
        !result ||
        typeof result.html !== 'string' ||
        !result.html.trim()
      ) {
        return res.status(502).json({
          error:
            'Gemini returned an incomplete website. Please try again.'
        });
      }

      /*
        Make sure optional fields always exist.
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

      console.log(
        `Generation successful for user: ${req.user?.uid || 'unknown'}`
      );

      return res.json({
        result
      });

    } catch (err) {
      /*
        IMPORTANT:
        Log the actual Gemini error in Render logs.
      */

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

      /*
        Gemini rate limit
      */

      const status =
        Number(err?.status) || 500;

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
        Temporary Gemini/server problem
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
  /*
    Request too large
  */

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request is too large.'
    });
  }

  /*
    CORS
  */

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
      `Gemini API: ${ai ? 'configured' : 'NOT CONFIGURED'}`
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
