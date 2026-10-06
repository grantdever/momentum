// Takes the README screenshots against made-up data (tools/demo-data.mjs).
// Not part of npm test; needs playwright-core and a Chromium. See README.
//   python3 -m http.server 8741 &
//   node tools/demo-data.mjs 2026-10-06 > /tmp/demo-backup.json
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.mjs CHROME=/path/to/chrome \
//     node tools/screenshots.mjs http://127.0.0.1:8741/ /tmp/demo-backup.json docs/screenshots
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [,, base, backup, outDir] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'dark', serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base);
await page.waitForSelector('#wizard-restore', { state: 'visible' });
// End-to-end: restore through the wizard button, like the phone runbook.
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#wizard-restore')]);
await chooser.setFiles(backup);
await page.waitForFunction(() => document.getElementById('import-status').textContent.startsWith('Restored'));
const status = await page.textContent('#import-status');
const view = await page.evaluate(() => document.querySelector('.view.active').id);
const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('momentum.settings')));
console.log(JSON.stringify({ status, view, ids: settings.habits.map((h) => h.id), onboarding: settings.onboarding ?? null }));
await page.screenshot({ path: `${outDir}/settings.png` });
await page.click('#nav [data-view="today"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/today.png` });
await page.click('#nav [data-view="history"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/recent.png` });
await page.click('[data-history-view="overview"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/overview.png` });
console.log('errors:', JSON.stringify(errors));
await browser.close();
