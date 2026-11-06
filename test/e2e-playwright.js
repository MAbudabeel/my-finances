// Browser test: serve this folder (python3 -m http.server 8765 --bind 127.0.0.1) then node test/e2e-playwright.js
const { chromium, devices } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8765/';
const OUT = __dirname;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('request', (r) => requests.push(r.url()));
  const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
  const unlock = async (pw) => { await page.fill('#lock-pass', pw); await page.click('#lock-btn'); await page.waitForSelector('#screen-app:not([hidden])', { timeout: 15000 }); };

  await page.goto(BASE);
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.screenshot({ path: OUT + '/01-setup.png' });
  await page.fill('#setup-pass', 'short'); await page.fill('#setup-pass2', 'short'); await page.click('#setup-btn');
  ok(await page.isVisible('#setup-error'), 'short password refused');
  await page.fill('#setup-pass', 'correct horse 1'); await page.fill('#setup-pass2', 'correct horse 1'); await page.click('#setup-btn');
  await page.waitForSelector('#screen-app:not([hidden])', { timeout: 15000 });
  ok(true, 'vault created');

  const texts = 'شراء PoS\n\nعبر:1111;مدى-ابل باي\n\nبـSAR 87.50\n\nلـPANDA\n\n3/11/26 22:05\n\nشراء إنترنت بـSR 129 \n\nعبر2222;فيزا\n\nلـAmazon sa\n\nرصيد:871.00 SR\n\n5/11/26 11:53\n\nرمز التحقق: 123456 لا تشاركه مع أحد\n\nشراء PoS\nعبر:1111;مدى\nبـSAR 5\nلـ<img src=x onerror=alert(1)>\n4/11/26 10:00';
  await page.click('#type-btn');
  await page.fill('#type-text', texts);
  await page.click('#type-add');
  await page.waitForSelector('#import-result:not([hidden])');
  const res = await page.textContent('#import-result');
  console.log('  import:', res);
  ok(/Added 3/.test(res), 'three transactions added, OTP ignored');
  ok((await page.textContent('#kpi-spending')).includes('221.50'), 'spending shown: ' + await page.textContent('#kpi-spending'));
  ok((await page.$$('#tx-body img')).length === 0, 'markup in merchant not rendered as HTML');
  await page.click('#type-btn'); await page.fill('#type-text', texts); await page.click('#type-add');
  await page.waitForFunction(() => /already added/.test(document.querySelector('#import-result').textContent));
  ok(true, 'second paste: ' + await page.textContent('#import-result'));

  // Clipboard paste path
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('##SMS## 2026-11-06T09:00:00+03:00\nشراء PoS\nعبر:1111;مدى\nبـSAR 18\nلـSTARBUCKS\n6/11/26 08:59\n'));
  await page.click('#paste-btn');
  await page.waitForFunction(() => /Added 1/.test(document.querySelector('#import-result').textContent));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok(clip === '', 'clipboard paste added 1 and clipboard cleared');
  await page.screenshot({ path: OUT + '/02-overview.png', fullPage: true });

  await page.click('.tx-open:has-text("PANDA")');
  await page.waitForSelector('#dlg-tx[open]');
  await page.screenshot({ path: OUT + '/03-detail.png' });
  await page.selectOption('#dlg-tx-cat', 'shopping');
  await page.click('#dlg-tx-save');

  const raw = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('finance-phone'); r.onsuccess = () => { const g = r.result.transaction('vault').objectStore('vault').get('main'); g.onsuccess = () => res(JSON.stringify(g.result)); };
  }));
  ok(!/PANDA|Amazon|87\.5|STARBUCKS/.test(raw), 'IndexedDB holds no readable merchant/amount (' + raw.length + ' bytes)');
  const ls = await page.evaluate(() => JSON.stringify(localStorage));
  ok(!/PANDA|Amazon/.test(ls), 'localStorage has no financial data: ' + ls);

  await page.reload();
  await page.waitForSelector('#screen-lock:not([hidden])');
  await page.fill('#lock-pass', 'wrong password'); await page.click('#lock-btn');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('#lock-error').textContent));
  ok(true, 'wrong password refused');
  await unlock('correct horse 1');
  ok((await page.textContent('#tx-count')).includes('4 of 4'), 'data persisted after reload: ' + await page.textContent('#tx-count'));
  const pandaCat = await page.$eval('#tx-body tr:has-text("PANDA") select', (s) => s.value);
  ok(pandaCat === 'shopping', 'category change persisted');

  await page.click('#lock-now');
  await page.waitForSelector('#screen-lock:not([hidden])');
  ok(true, 'Lock button locks');
  await unlock('correct horse 1');

  await page.click('#tab-salary');
  await page.fill('#earning-rows li:nth-child(1) .pay-amount', '14000');
  await page.fill('#earning-rows li:nth-child(2) .pay-amount', '3500');
  await page.click('#calc-gosi');
  ok((await page.$eval('#deduction-rows .pay-amount', (i) => i.value)) === '1706.25', 'GOSI calculated');
  await page.click('#pay-save');
  await page.waitForFunction(() => document.querySelector('#pay-saved').textContent === 'Saved');
  await page.screenshot({ path: OUT + '/04-salary.png', fullPage: true });

  await page.click('#tab-settings');
  await page.click('#backup-btn');
  await page.waitForSelector('#dlg-backup[open]');
  const dlP = page.waitForEvent('download');
  await page.click('#backup-download');
  const dl = await dlP;
  const backupPath = OUT + '/backup.json';
  await dl.saveAs(backupPath);
  const bk = fs.readFileSync(backupPath, 'utf8');
  ok(/finance-phone-vault/.test(bk) && !/PANDA/.test(bk), 'backup file is encrypted (' + dl.suggestedFilename() + ')');
  await page.click('#dlg-backup [data-close]');
  await page.screenshot({ path: OUT + '/05-settings.png', fullPage: true });

  await page.fill('#pw-old', 'correct horse 1'); await page.fill('#pw-new', 'new password 22'); await page.fill('#pw-new2', 'new password 22');
  await page.click('#pw-btn');
  await page.waitForFunction(() => /Password changed/.test(document.querySelector('#pw-done').textContent), null, { timeout: 15000 });
  await page.reload();
  await page.waitForSelector('#screen-lock:not([hidden])');
  await page.fill('#lock-pass', 'correct horse 1'); await page.click('#lock-btn');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('#lock-error').textContent));
  await unlock('new password 22');
  ok(true, 'password changed: old refused, new works');

  await page.click('#tab-settings');
  await page.click('#wipe-btn');
  ok(await page.isDisabled('#wipe-go'), 'delete disabled until DELETE typed');
  await page.fill('#wipe-confirm', 'delete');
  await page.click('#wipe-go');
  await page.waitForSelector('#screen-setup:not([hidden])');
  const dbs = await page.evaluate(() => indexedDB.databases());
  ok(!dbs.some((d) => d.name === 'finance-phone'), 'database deleted');

  await page.click('#setup-restore');
  await page.setInputFiles('#restore-file', backupPath);
  await page.fill('#restore-pass', 'new password 22');
  await page.click('#restore-go');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('#restore-error').textContent), null, { timeout: 15000 });
  ok(true, 'restore with wrong password refused');
  await page.fill('#restore-pass', 'correct horse 1');
  await page.click('#restore-go');
  await page.waitForSelector('#screen-app:not([hidden])', { timeout: 15000 });
  ok((await page.textContent('#tx-count')).includes('4 of 4'), 'restored from backup');
  await page.reload();
  await unlock('correct horse 1');
  ok(true, 'restored vault opens with the backup password');

  const ctx2 = await browser.newContext({ ...devices['iPhone 13'] });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('pageerror(demo): ' + e.message));
  p2.on('console', (m) => { if (m.type() === 'error') errors.push('demo: ' + m.text()); });
  p2.on('request', (r) => requests.push(r.url()));
  await p2.goto(BASE);
  await p2.click('#setup-demo');
  await p2.waitForSelector('#screen-app:not([hidden])');
  await p2.waitForTimeout(300);
  await p2.screenshot({ path: OUT + '/06-demo.png', fullPage: true });
  const w = await p2.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(w[0] <= w[1], 'no horizontal scroll at iPhone width ' + w.join('/'));
  await p2.setViewportSize({ width: 320, height: 640 });
  await p2.waitForTimeout(300);
  const w2 = await p2.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(w2[0] <= w2[1], 'no horizontal scroll at 320px ' + w2.join('/'));
  await p2.click('#tab-salary');
  await p2.screenshot({ path: OUT + '/07-demo-salary.png', fullPage: true });
  const foreign = requests.filter((u) => !u.startsWith(BASE));
  ok(foreign.length === 0, 'no requests outside the app ' + foreign.join(', '));
  console.log('console:', errors.length ? errors : 'clean');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
