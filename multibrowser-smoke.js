const { test, expect } = require('@playwright/test');

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('two independent browser contexts can load the server-connected master', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const pages = await Promise.all([first.newPage(), second.newPage()]);
    await Promise.all(pages.map(page => page.goto(baseURL, { waitUntil: 'domcontentloaded' })));
    await Promise.all(pages.map(page => expect(page).toHaveTitle(/KALAK|3PATTI/i)));
    const health = await pages[0].request.get(`${baseURL}/healthz`);
    expect(health.ok()).toBeTruthy();
    const body = await health.json();
    expect(body.ok).toBe(true);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
