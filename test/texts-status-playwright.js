// Browser test: serve this folder (python3 -m http.server 8765 --bind 127.0.0.1) then node test/texts-status-playwright.js
// Checks the quiet notes that tell you when bank texts stop arriving or can't be read.
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch();
  const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install({ time: new Date('2026-11-08T12:00:00+03:00') });
  await page.goto(BASE);
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.fill('#setup-pass', 'correct horse 1'); await page.fill('#setup-pass2', 'correct horse 1'); await page.click('#setup-btn');
  await page.waitForSelector('#screen-app:not([hidden])', { timeout: 15000 });
  await page.click('#type-btn');
  await page.fill('#type-text', 'شراء PoS\nعبر:1111;مدى\nبـSAR 18\nلـSTARBUCKS\n8/11/26 08:59');
  await page.click('#type-add');
  await page.waitForFunction(() => /Added 1/.test(document.querySelector('#import-result').textContent));
  ok(!(await page.$eval('#last-import', (e) => e.classList.contains('stale'))), 'fresh import: no warning');

  // Five days later, nothing new: the line turns amber and says what to check.
  await page.clock.setSystemTime(new Date('2026-11-13T12:00:00+03:00'));
  await page.reload();
  await page.waitForSelector('#screen-lock:not([hidden])');
  // The phone refuses the clipboard (Paste not tapped).
  await page.evaluate(() => { navigator.clipboard.readText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await page.fill('#lock-pass', 'correct horse 1'); await page.click('#lock-btn');
  await page.waitForSelector('#screen-app:not([hidden])', { timeout: 15000 });
  const line = await page.textContent('#last-import');
  ok(/nothing new for [45] days/.test(line) && await page.$eval('#last-import', (e) => e.classList.contains('stale')), 'gap shown: ' + line);
  await page.waitForFunction(() => /didn’t let the app read/.test(document.querySelector('#import-result').textContent));
  ok(true, 'clipboard refused: quiet note shown');
  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close();
})();
