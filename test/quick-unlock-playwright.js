const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:8765/';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
async function fresh(b, prf) {
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: prf } });
  await p.goto(BASE);
  await p.fill('#setup-pass', 'correct horse 1'); await p.fill('#setup-pass2', 'correct horse 1'); await p.click('#setup-btn');
  await p.waitForSelector('#screen-app:not([hidden])', { timeout: 20000 });
  await p.evaluate(() => navigator.clipboard.writeText('شراء PoS\nعبر:1111;مدى\nبـSAR 25\nلـALBAIK 1\n5/11/26 10:00'));
  await p.click('#paste-btn'); await p.waitForFunction(() => /Added 1/.test(document.querySelector('#import-result').textContent));
  return p;
}
async function lock(p) { await p.click('#lock-now'); await p.waitForSelector('#screen-lock:not([hidden])'); await p.waitForTimeout(300); }
(async () => {
  const b = await chromium.launch();
  // ---- Face ID ----
  let p = await fresh(b, true);
  await p.click('#tab-settings'); await p.waitForTimeout(200);
  await p.fill('#quick-pass', 'wrong password!'); await p.click('#quick-face');
  await p.waitForFunction(() => !document.querySelector('#quick-error').hidden);
  ok(/wrong/.test(await p.textContent('#quick-error')), 'wrong password refused when turning on Face ID');
  await p.fill('#quick-pass', 'correct horse 1'); await p.click('#quick-face');
  await p.waitForFunction(() => /Face ID/.test(document.querySelector('#quick-status').textContent), null, { timeout: 20000 });
  ok(true, 'Face ID on: ' + await p.textContent('#quick-status'));
  const q = await p.evaluate(() => new Promise(r => { const o = indexedDB.open('finance-phone'); o.onsuccess = () => { const g = o.result.transaction('vault').objectStore('vault').get('quick'); g.onsuccess = () => r(JSON.stringify(g.result)); }; }));
  ok(!/ALBAIK|correct horse/.test(q) && /"kind":"passkey"/.test(q), 'stored quick record holds only wrapped key');
  await lock(p);
  ok(await p.isVisible('#face-btn') && await p.isHidden('#pass-field'), 'lock screen shows Face ID button, no password box');
  await p.evaluate(() => navigator.clipboard.writeText('شراء PoS\nعبر:1111;مدى\nبـSAR 9\nلـBARNS 2\n6/11/26 10:00'));
  await p.click('#face-btn');
  await p.waitForSelector('#screen-app:not([hidden])', { timeout: 20000 });
  ok((await p.textContent('#tx-count')).includes('of 1') || (await p.textContent('#tx-count')).includes('of 2'), 'Face ID unlocks the data: ' + await p.textContent('#tx-count'));
  await p.waitForTimeout(800);
  ok((await p.textContent('#tx-count')).includes('of 2'), 'clipboard texts still added with Face ID: ' + await p.textContent('#tx-count'));
  await lock(p);
  await p.click('#lock-use-pass');
  ok(await p.isVisible('#pass-field'), 'Use password instead shows password');
  await p.fill('#lock-pass', 'correct horse 1'); await p.click('#lock-btn');
  await p.waitForSelector('#screen-app:not([hidden])', { timeout: 20000 });
  ok(true, 'password still works');
  // change password turns it off
  await p.click('#tab-settings'); await p.waitForTimeout(200);
  await p.fill('#pw-old', 'correct horse 1'); await p.fill('#pw-new', 'battery staple 22'); await p.fill('#pw-new2', 'battery staple 22'); await p.click('#pw-btn');
  await p.waitForFunction(() => /changed/.test(document.querySelector('#pw-done').textContent), null, { timeout: 20000 });
  await p.waitForTimeout(300);
  ok(/Off/.test(await p.textContent('#quick-status')), 'password change turns quick unlock off');
  console.log('errors:', p.errs.length ? p.errs : 'none');
  // ---- PIN ----
  p = await fresh(b, true);
  await p.click('#tab-settings'); await p.waitForTimeout(200);
  await p.click('#quick-pin-btn'); await p.fill('#quick-pin', '123456'); await p.fill('#quick-pass', 'correct horse 1'); await p.click('#quick-pin-btn');
  ok(/harder/.test(await p.textContent('#quick-error')), 'easy PIN refused');
  await p.fill('#quick-pin', '482915'); await p.click('#quick-pin-btn');
  await p.waitForFunction(() => /PIN/.test(document.querySelector('#quick-status').textContent), null, { timeout: 20000 });
  await lock(p);
  ok(await p.isVisible('#pin-field'), 'lock screen asks for PIN');
  await p.fill('#lock-pin', '111111'); await p.click('#lock-btn');
  await p.waitForFunction(() => /tries left/.test(document.querySelector('#lock-error').textContent), null, { timeout: 20000 });
  ok(true, await p.textContent('#lock-error'));
  await p.fill('#lock-pin', '482915'); await p.click('#lock-btn');
  await p.waitForSelector('#screen-app:not([hidden])', { timeout: 20000 });
  ok(true, 'PIN unlocks');
  await lock(p);
  for (let i = 0; i < 5; i++) { await p.fill('#lock-pin', '00000' + i); await p.click('#lock-btn'); await p.waitForFunction(() => !document.querySelector('#lock-btn').disabled && !document.querySelector('#lock-error').hidden, null, { timeout: 20000 }); await p.waitForTimeout(100); }
  ok(await p.isVisible('#pass-field') && /turned off/.test(await p.textContent('#lock-error')), '5 wrong PINs → password needed: ' + await p.textContent('#lock-error'));
  await p.reload(); await p.waitForSelector('#screen-lock:not([hidden])'); await p.waitForTimeout(300);
  ok(await p.isVisible('#pass-field') && await p.isHidden('#pin-field'), 'PIN stays off after reload');
  const w = await p.evaluate(() => document.documentElement.scrollWidth); ok(w <= 390, 'no horizontal scroll');
  console.log('errors:', p.errs.length ? p.errs : 'none');
  // ---- no PRF ----
  p = await fresh(b, false);
  await p.click('#tab-settings'); await p.waitForTimeout(200);
  await p.fill('#quick-pass', 'correct horse 1'); await p.click('#quick-face');
  await p.waitForFunction(() => !document.querySelector('#quick-error').hidden, null, { timeout: 20000 });
  ok(/PIN instead/.test(await p.textContent('#quick-error')) && /Off/.test(await p.textContent('#quick-status')), 'no PRF → clear message, stays off: ' + await p.textContent('#quick-error'));
  await p.screenshot({ path: process.argv[2], fullPage: false });
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
