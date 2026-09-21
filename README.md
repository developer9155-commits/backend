# Nexora AI Backend

Secure Gemini proxy for Nexora AI Builder.

## Local

```bash
npm install
cp .env.example .env
npm start
```

The API runs on `http://localhost:10000` and exposes:

- `GET /health`
- `POST /generate`

`POST /generate` requires `Authorization: Bearer <Firebase ID token>`.

## Render

Create a Render **Web Service** from this folder/repository.

- Build Command: `npm install`
- Start Command: `npm start`
- Plan: Free

Add the environment variables from `.env.example` in Render. Never commit `.env` or a Firebase service-account key.

Set `ALLOWED_ORIGINS` to the exact origin(s) serving the Nexora frontend after deployment, for example:

`https://your-frontend.example.com`

## Firebase service account

In Firebase Console / Google Cloud IAM, create a service account key for the project and store the JSON only in Render's environment variables as `FIREBASE_SERVICE_ACCOUNT_JSON`.

Do not put this credential in `firebase-config.js` or any browser file.
