# Phase 0 — Baseline and housekeeping

This repository keeps the server-connected game page as the production master:

- `public/KALAK_3PATTI.html` is the deployed game page.
- `server.js` owns configuration, persistence, authentication, and lifecycle.
- `match-manager.js` owns the live match.
- `game-engine.js` is the server-side game engine.
- `realtime.js` owns authenticated WebSocket sessions.
- `tests/` contains the local infrastructure and multi-browser smoke test kit.

## Local smoke test

```bash
npm ci
npm test
node tests/fake-upstash.js
```

## Render verification

After a manual deploy, check:

1. Render logs show `Table storage: Upstash Redis (survives restarts).`
2. Render logs show `Deployed commit: <short-sha>`.
3. `https://kalak-3patti.onrender.com/healthz` returns JSON with `ok: true`.
4. The admin panel footer shows the same deployed commit.
5. `/api/health` reports `storage: "upstash"` when both Upstash variables are configured.

## Storage rules

Runtime files are ignored and must not be uploaded:

- `node_modules/`
- `tournament-config.json`
- `match-state.json`

Do not commit passwords, tokens, or Render environment values. Configure `ADMIN_PASSWORD`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` only in Render's Environment settings.
