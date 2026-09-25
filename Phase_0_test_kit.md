# Phase 0 test kit

This directory contains local-only infrastructure checks. Render does not run these files.

## Fake Upstash REST server

```bash
node tests/fake-upstash.js
```

The harness implements the exact `GET`, `SET`, and `DEL` REST command shapes used by `server.js`.

## Multi-browser smoke test

Install Playwright in a local checkout if it is not already available:

```bash
npm install --no-save @playwright/test
npx playwright install chromium
```

Run against a local or deployed server:

```bash
BASE_URL=http://127.0.0.1:3000 npx playwright test tests/multibrowser-smoke.spec.js
```

The smoke test opens two independent browser contexts and verifies that both can load the production master page, while health and version endpoints remain reachable. It does not create a real table or use credentials.

For the full two-player acceptance scenarios, use the Phase 2–5 test suite and a separate test table with throwaway passwords.
