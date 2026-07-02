'use strict';

// Screenshot an authenticated Home Assistant Lovelace dashboard to a PNG.
// Usage: ha-shot <dashboard-path> [output.png] [WIDTHxHEIGHT]
//   ha-shot /lovelace/0 /tmp/dash.png 1280x800
// Auth: injects the add-on's Long-Lived Access Token (HA_TOKEN) into
// localStorage `hassTokens` before navigation, mirroring the HA frontend's
// own token bootstrap. Requires the "HA Token" add-on option to be set.

const { chromium } = require('playwright-core');

const HEADER_HEIGHT = 56; // HA app top bar, cropped out of the screenshot

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function main() {
  const path = process.argv[2];
  const output = process.argv[3] || `/tmp/ha-shot-${Date.now()}.png`;
  const size = process.argv[4] || '1280x800';

  if (!path || path === '--help' || path === '-h') {
    console.log('Usage: ha-shot <dashboard-path> [output.png] [WIDTHxHEIGHT]');
    console.log('Example: ha-shot /lovelace/0 /tmp/dash.png 1280x800');
    process.exit(path ? 0 : 2);
  }

  const token = process.env.HA_TOKEN;
  if (!token) {
    fail('ha-shot: no HA Token configured.\n' +
      'Set the "HA Token" (Long-Lived Access Token) option in the add-on\n' +
      'configuration, then restart the add-on. Create one in Home Assistant:\n' +
      'Profile → Security → Long-lived access tokens.');
  }

  const baseUrl = (process.env.HA_URL || 'http://homeassistant:8123').replace(/\/+$/, '');
  const clientId = `${baseUrl}/`;
  const m = /^(\d+)[xX](\d+)$/.exec(size);
  if (!m) fail(`ha-shot: bad size "${size}", expected WIDTHxHEIGHT e.g. 1280x800`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 1 || height < 1 || width > 4000 || height > 4000) {
    fail(`ha-shot: size out of range "${size}" (each dimension must be 1–4000)`);
  }
  const target = baseUrl + (path.startsWith('/') ? path : `/${path}`);

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width, height: height + HEADER_HEIGHT },
      deviceScaleFactor: 1,
    });

    // Seed auth + hide the sidebar BEFORE any HA script runs.
    await context.addInitScript(({ token, hassUrl, clientId }) => {
      window.localStorage.setItem('hassTokens', JSON.stringify({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 1800,
        hassUrl,
        clientId,
        expires: 9999999999999,
        refresh_token: '',
      }));
      window.localStorage.setItem('dockedSidebar', '"always_hidden"');
    }, { token, hassUrl: baseUrl, clientId });

    const page = await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the panel to finish loading (HA is nested shadow DOM).
    await page.waitForFunction(() => {
      const ha = document.querySelector('home-assistant');
      const main = ha && ha.shadowRoot && ha.shadowRoot.querySelector('home-assistant-main');
      const resolver = main && main.shadowRoot &&
        main.shadowRoot.querySelector('partial-panel-resolver');
      if (!resolver || resolver._loading) return false;
      const panel = resolver.children[0];
      return panel && !panel._loading;
    }, { timeout: 15000 }).catch(() => { /* handled by the auth-redirect check below */ });

    // A bad/expired token makes HA redirect to /auth/authorize (client-side,
    // after load) — check AFTER the wait so we don't screenshot a login page.
    if (new URL(page.url()).pathname.startsWith('/auth/authorize')) {
      throw new Error('authentication failed — the HA Token was rejected. ' +
        'Generate a fresh Long-Lived Access Token and update the add-on option.');
    }

    await page.waitForTimeout(750); // let cards paint

    await page.screenshot({
      path: output,
      clip: { x: 0, y: HEADER_HEIGHT, width, height },
    });
    console.log(output);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`ha-shot: ${err.message || err}`);
  process.exit(1);
});
