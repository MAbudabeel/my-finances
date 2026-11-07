// Browser test for the Wallets tab: serve this folder (python3 -m http.server 8765 --bind 127.0.0.1) then node test/wallet-playwright.js [outdir]
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:8765/';
const OUT = process.argv[2] || __dirname;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
  const now = () => new Date().toISOString();

  await page.goto(BASE);
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.fill('#setup-pass', 'correct horse 1'); await page.fill('#setup-pass2', 'correct horse 1'); await page.click('#setup-btn');
  await page.waitForSelector('#screen-app:not([hidden])', { timeout: 15000 });

  await page.click('#tab-wallets');
  await page.waitForSelector('#view-wallets:not([hidden])');
  ok((await page.$$('#wal-list li')).length === 5, 'five wallets listed');
  await page.screenshot({ path: OUT + '/w1-empty.png' });

  const set = async (name, amt, limit) => {
    await page.click(`.wal-row:has-text("${name}")`);
    await page.waitForSelector('#dlg-wallet[open]');
    await page.fill('#dlg-wallet-amount', amt);
    if (limit) await page.fill('#dlg-wallet-limit', limit);
    await page.click('#dlg-wallet-save');
    await page.waitForSelector('#dlg-wallet:not([open])', { state: 'attached' });
  };
  await page.click('.wal-row:has-text("STC Pay")');
  await page.fill('#dlg-wallet-amount', 'abc'); await page.click('#dlg-wallet-save');
  ok(await page.isVisible('#dlg-wallet-error'), 'bad amount refused');
  await page.click('#dlg-wallet [data-close]');
  await set('STC Pay', '500');
  await set('D360', '1,250.75');
  await set('urpay', '٢٠٠');
  await set('barq', '0');
  await set('ANB', '1200', '10000');
  await page.waitForTimeout(300);
  ok((await page.textContent('#wal-total')).includes('1,950.75'), 'wallet total ' + await page.textContent('#wal-total'));
  ok((await page.textContent('#wal-owed')).includes('1,200.00'), 'card owed ' + await page.textContent('#wal-owed'));

  await page.waitForTimeout(1100); // texts arrive after the balances were set (times are to the second)
  // The clipboard as the wallet automation leaves it: wallet file + Al Rajhi file.
  const riyadh = new Date(Date.now() + 3 * 3600000);
  const ymd = String(riyadh.getUTCFullYear()).slice(2) + '/' + (riyadh.getUTCMonth() + 1) + '/' + riyadh.getUTCDate();
  const clip = '##WALLET:STCPAY##تم الدفع بمبلغ 30.00 ريال لدى KUDU\n##AT## ' + now() + '\n' +
    '##WALLET:ANB##شراء بطاقة ائتمانية **5555 بمبلغ 300.00 SAR لدى NAHDI\n##AT## ' + now() + '\n' +
    '##WALLET:STCPAY##Welcome to STC Bank\n##AT## ' + now() + '\n' +
    '##SMS##حوالة صادرة\nبـSR 100\nمن1234\nلـ9999;OWN NAME\n' + ymd + ' 00:01\n' +
    '##WALLET:URPAY##Received SAR 100.00 from OWN NAME\n##AT## ' + now() + '\n';
  await page.evaluate((t) => navigator.clipboard.writeText(t), clip);
  await page.click('#tab-overview');
  await page.click('#paste-btn');
  await page.waitForFunction(() => /Added/.test(document.querySelector('#import-result').textContent));
  console.log('  ', await page.textContent('#import-result'));
  ok(/Added 4/.test(await page.textContent('#import-result')), 'four transactions added');
  await page.click('#tab-wallets');
  ok(!/spent|Updated|available/.test(await page.textContent('#wal-list')), 'list shows only names and balances');
  await page.click('#wal-list-title'); // the next tap writes the done marker
  await page.waitForTimeout(200);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === '##WALLET-DONE##', 'done marker on clipboard');
  ok((await page.textContent('#wal-total')).includes('2,020.75'), 'total after texts ' + await page.textContent('#wal-total'));
  ok((await page.textContent('#wal-owed')).includes('1,500.00'), 'owed after purchase ' + await page.textContent('#wal-owed'));
  await page.screenshot({ path: OUT + '/w2-wallets.png', fullPage: true });

  await page.click('.wal-row:has-text("STC Pay")');
  await page.waitForSelector('#dlg-wallet[open]');
  ok(!(await page.isHidden('#dlg-wallet-unread-box')), 'unread text shown in the wallet');
  await page.screenshot({ path: OUT + '/w3-detail.png' });
  await page.click('#dlg-wallet [data-close]');

  await page.click('#tab-overview');
  await page.waitForSelector('#view-overview:not([hidden])');
  const spend = await page.textContent('#kpi-spending');
  ok(spend.includes('330.00'), 'spending = KUDU 30 + NAHDI 300 only: ' + spend);
  ok(await page.isVisible('.tx-desc:has-text("between your accounts")'), 'transfer pair labelled');
  await page.screenshot({ path: OUT + '/w4-overview.png', fullPage: true });
  for (const w of [320, 390]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.click('#tab-wallets');
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(sw <= w, `no horizontal scroll at ${w}px (${sw})`);
    if (w === 320) { await page.screenshot({ path: OUT + '/w5-320.png', fullPage: true }); await page.click('.wal-row:has-text("ANB")'); await page.waitForSelector('#dlg-wallet[open]'); await page.screenshot({ path: OUT + '/w6-anb.png' }); await page.click('#dlg-wallet [data-close]'); }
  }
  ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
  await browser.close();
})();
