# Vasu AI Hosting backend

Node.js 20+ API for the existing frontend. Copy `.env.example` to `.env` and set
`GEMINI_API_KEY` (Google AI Studio). Install and run:

```sh
npm install
npm start
```

`GET /health` is a simple health check. `POST /api/generate` accepts
`{prompt, existingFiles}` and returns `{files:{html,css,js},message}`. Gemini is
forced to return the JSON schema and all input/output is size-validated.

Set `REQUIRE_AUTH=true` to require a Firebase ID token in
`Authorization: Bearer <token>`. Configure Firebase Admin with
`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` (the
private key may contain escaped `\n` characters). With the default
`REQUIRE_AUTH=false`, authentication remains optional.

The frontend's API button stores its backend URL in `localStorage` as `nx_api`;
alternatively set its `CFG.API_BASE`. For Render or Railway, use this directory
as the service root, `npm install` as the build command, and `npm start` as the
start command. Set environment variables in the provider dashboard, never in
source control.

There is no hosting-provider integration in this project yet. Deployment
requests return HTTP 501 by default. For a temporary local-only deployment,
set `DEPLOYMENT_MODE=local`, `PUBLIC_BASE_URL`, and optionally `STORAGE_DIR`.
Files are saved below the runtime storage directory and served at `/sites/:subdomain/`;
this is not a production multi-tenant hosting provider.
