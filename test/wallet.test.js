// Wallets & credit card. node --test test/
// These texts are made-up examples in the usual Saudi wallet style; replace them with
// real ones (card digits changed) once the user sends samples.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

const AT = (h, m) => `2026-11-07T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`;
const W = (tag, text, at) => `##WALLET:${tag}##${text}\n##AT## ${at}\n`;

test('wallet marker glued to the text, with the arrival time, splits and parses', async () => {
  const input = W('STCPAY', 'تم الدفع بمبلغ 25.00 ريال لدى DR CAFE\nرصيدك الحالي 474.50 ريال', AT(9, 15));
  const msgs = Core.splitMessages(input);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].wallet, 'stcpay');
  assert.equal(msgs[0].receivedAt, AT(9, 15));
  assert.ok(!/##/.test(msgs[0].text));
  const t = Core.parseWalletSms(msgs[0].text, 'stcpay', { receivedAt: msgs[0].receivedAt });
  assert.equal(t.amount, -25);
  assert.equal(t.balance_after, 474.5);
  assert.equal(t.merchant, 'DR CAFE');
  assert.equal(t.date, AT(9, 15));
});

test('one-line glued file from iOS (no line breaks at all) still splits', () => {
  const input = '##WALLET:URPAY##Purchase SAR 40.00 at JAHEZ Balance SAR 160.00 ##AT## 2026-11-07T10:00:00+03:00##WALLET:URPAY##Received SAR 100.00 from AHMED ##AT## 2026-11-07T11:00:00+03:00';
  const msgs = Core.splitMessages(input);
  assert.equal(msgs.length, 2);
  const a = Core.parseWalletSms(msgs[0].text, 'urpay', msgs[0]);
  const b = Core.parseWalletSms(msgs[1].text, 'urpay', msgs[1]);
  assert.equal(a.amount, -40); assert.equal(a.balance_after, 160); assert.equal(a.merchant, 'JAHEZ');
  assert.equal(b.amount, 100); assert.equal(b.merchant, 'AHMED');
});

test('two identical coffees at different times are two payments; the same text twice is one', async () => {
  const d = Core.emptyData();
  const coffee = 'تم خصم 18.00 ر.س من محفظتك لدى BARNS';
  let r = await Core.importTexts(d, W('BARQ', coffee, AT(8, 0)) + W('BARQ', coffee, AT(15, 30)));
  assert.equal(r.inserted, 2);
  r = await Core.importTexts(d, W('BARQ', coffee, AT(8, 0)));
  assert.equal(r.inserted, 0); assert.equal(r.duplicates, 1);
});

test('mixed clipboard: Al Rajhi texts and wallet texts together', async () => {
  const d = Core.emptyData();
  const input = '##SMS##شراء PoS\nعبر:1111;مدى-ابل باي\nبـSAR 4\nلـMONTE CAR\n3/11/26 22:05\n' + W('D360', 'Payment of SAR 12.00 at HUNGERSTATION', AT(12, 0));
  const r = await Core.importTexts(d, input);
  assert.equal(r.inserted, 2);
  assert.equal(r.wallet_texts, true);
  assert.equal(d.transactions.filter((t) => t.account === 'd360').length, 1);
  assert.equal(d.transactions.filter((t) => !t.account).length, 1);
});

test('balance: starting amount, then texts with and without a balance', async () => {
  const d = Core.emptyData();
  Core.setWalletStart(d, 'stcpay', 500, { at: AT(7, 0) });
  await Core.importTexts(d, W('STCPAY', 'تم الدفع بمبلغ 30.00 ريال لدى KUDU', AT(9, 0)));
  let v = Core.walletsView(d).wallets.find((w) => w.id === 'stcpay');
  assert.equal(v.balance, 470);
  await Core.importTexts(d, W('STCPAY', 'تم الدفع بمبلغ 10.00 ريال لدى ALBAIK رصيدك 455.00 ريال', AT(10, 0)));
  v = Core.walletsView(d).wallets.find((w) => w.id === 'stcpay');
  assert.equal(v.balance, 455); // the text's own balance wins
  // A text from before the starting amount was set is already part of it.
  await Core.importTexts(d, W('STCPAY', 'تم الدفع بمبلغ 99.00 ريال لدى OLD', AT(6, 0)));
  v = Core.walletsView(d).wallets.find((w) => w.id === 'stcpay');
  assert.equal(v.balance, 455);
});

test('credit card: purchases raise what you owe, a payment lowers it; available from limit', async () => {
  const d = Core.emptyData();
  Core.setWalletStart(d, 'anb', 1200, { at: AT(7, 0), limit: 10000 });
  await Core.importTexts(d, W('ANB', 'شراء عبر نقاط البيع بطاقة ائتمانية **5555 بمبلغ 300.00 SAR لدى NAHDI', AT(9, 0)));
  let c = Core.walletsView(d).wallets.find((w) => w.id === 'anb');
  assert.equal(c.balance, -1500); assert.equal(c.available, 8500);
  await Core.importTexts(d, W('ANB', 'تم استلام سداد بمبلغ 1000.00 SAR لبطاقتك الائتمانية', AT(11, 0)));
  c = Core.walletsView(d).wallets.find((w) => w.id === 'anb');
  assert.equal(c.balance, -500);
  // A text that states the available limit resets it.
  await Core.importTexts(d, W('ANB', 'Purchase SAR 50.00 at STARBUCKS card **5555 Available limit SAR 9,400.00', AT(12, 0)));
  c = Core.walletsView(d).wallets.find((w) => w.id === 'anb');
  assert.equal(c.balance, -600); assert.equal(c.available, 9400);
  const t = d.transactions.find((x) => x.merchant === 'STARBUCKS');
  assert.equal(t.category, 'coffee'); // card spending counts as spending
});

test('Al Rajhi -> STC Pay top-up is one transfer, not spending and not "sent to people"', async () => {
  const d = Core.emptyData();
  // Al Rajhi outgoing transfer to the user's own wallet (name is a person's name, not "STC Pay").
  await Core.importTexts(d, '##SMS##حوالة صادرة\nبـSR 200\nمن1234\nلـ9999;OWN NAME\n26/11/7 09:00\n');
  const bank = d.transactions[0];
  assert.equal(bank.raw_category, 'transfer_out');
  await Core.importTexts(d, W('STCPAY', 'تم استلام حوالة بمبلغ 200.00 ريال من OWN NAME', AT(9, 1)));
  const wal = d.transactions.find((t) => t.account === 'stcpay');
  assert.equal(bank.link, wal.id); assert.equal(wal.link, bank.id);
  assert.equal(bank.category, 'transfer'); assert.equal(wal.category, 'transfer');
  const p = Core.planView(d, '2026-11-07');
  assert.equal(p.sent, 0);
  const s = Core.monthSummary(d, Core.periodOf(d, '2026-11-07'));
  assert.equal(s.spending, 0); assert.equal(s.income, 0);
  // Then spending from the wallet counts once.
  await Core.importTexts(d, W('STCPAY', 'تم الدفع بمبلغ 45.00 ريال لدى HUNGERSTATION', AT(13, 0)));
  assert.equal(Core.monthSummary(d, Core.periodOf(d, '2026-11-07')).spending, 45);
});

test('Al Rajhi paying the ANB card by SADAD pairs with the card payment', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, '##SMS##سداد فاتورة بـSR 1000\nلـANB CREDIT CARD\n7/11/26 10:00\n');
  await Core.importTexts(d, W('ANB', 'تم استلام سداد بمبلغ 1000.00 SAR', AT(10, 5)));
  assert.ok(d.transactions.every((t) => t.category === 'transfer' && t.link));
  assert.equal(Core.monthSummary(d, Core.periodOf(d, '2026-11-07')).spending, 0);
});

test('a hand-changed category breaks the pair, deleting one half restores the other', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, '##SMS##حوالة صادرة\nبـSR 75\nمن1234\nلـ9999;SARA\n26/11/7 09:00\n');
  await Core.importTexts(d, W('URPAY', 'Received SAR 75.00 from SARA', AT(9, 2)));
  const [a, b] = d.transactions;
  assert.ok(a.link && b.link);
  Core.deleteTransaction(d, b.id);
  assert.ok(!a.link);
  assert.equal(a.category, 'transfer'); // back to an ordinary transfer to a person
  assert.ok(Core.planView(d, '2026-11-07').sent > 0);
});

test('unreadable wallet texts are kept for a look; codes are ignored', async () => {
  const d = Core.emptyData();
  const r = await Core.importTexts(d, W('STCPAY', 'Welcome to the new STC Bank app!', AT(9, 0)) + W('STCPAY', 'رمز التحقق 1234 لا تشارك', AT(9, 1)));
  assert.equal(r.inserted, 0);
  assert.equal(r.unread, 1);
  assert.equal(Core.walletsView(d).unread.length, 1);
});

test('old backups without wallets still load', () => {
  const d = Core.emptyData(); delete d.wallets; delete d.wallet_unread;
  Core.validateData(d);
  assert.equal(d.wallets.length, 5);
});

test('the done marker and emptied file are ignored', async () => {
  const d = Core.emptyData();
  const r = await Core.importTexts(d, '##WALLET-DONE##');
  assert.equal(r.inserted, 0);
  const r2 = await Core.importTexts(d, '-\n' + W('BARQ', 'Paid SAR 9.00 to ALI', AT(9, 0)));
  assert.equal(r2.inserted, 1);
});

// Real ANB card texts (card digits changed). "Balance" on these is the credit still available.
const ANB_ALIEXPRESS = 'International Online Purchase\nApple Pay\nVISA Card:1111\nCountry:FRA\nAmount:SAR 186.14\nExchange rate:1.00\nFees and VAT:SAR 4.28\nBalance:SAR 3,941.03\nTotal amount:SAR 190.42\nAt:ALIEXPRESS.COM\nOn:07/11/26 18:43';
const ANB_SMASCO = 'Online Purchase\nApple Pay\nVISA Card:1111\nAmount:SAR 80.49\nBalance:SAR 4,131.45\nAt:Smasco\nOn:07/11/26 18:36';

test('real ANB texts: total with fees is the amount, Balance is available credit', () => {
  const a = Core.parseWalletSms(ANB_ALIEXPRESS, 'anb', {});
  assert.equal(a.amount, -190.42);
  assert.equal(a.available_after, 3941.03);
  assert.equal(a.balance_after, null);
  assert.equal(a.merchant, 'ALIEXPRESS.COM');
  assert.equal(a.card_last4, '1111');
  assert.equal(a.date, '2026-11-07T18:43:00+03:00');
  const b = Core.parseWalletSms(ANB_SMASCO, 'anb', {});
  assert.equal(b.amount, -80.49); assert.equal(b.available_after, 4131.45); assert.equal(b.merchant, 'Smasco');
});

test('real ANB texts keep what you owe in line with the limit', async () => {
  const d = Core.emptyData();
  Core.setWalletStart(d, 'anb', 4211.94, { at: '2026-11-07T15:55:00+03:00', limit: 10000 });
  await Core.importTexts(d, W('ANB', ANB_SMASCO, '2026-11-07T18:36:05+03:00') + W('ANB', ANB_ALIEXPRESS, '2026-11-07T18:43:05+03:00'));
  const c = Core.walletsView(d).wallets.find((w) => w.id === 'anb');
  assert.equal(c.available, 3941.03);
  assert.equal(c.balance, -6058.97);
  assert.equal(Core.monthSummary(d, Core.periodOf(d, '2026-11-07')).spending, 270.91);
});

// Real urpay text (card digits changed): a mada purchase with no balance.
const URPAY_MCD = 'شراء\nبطاقة:مدى;1111\nمبلغ:SAR 3.0\nلدى:MCDONALDS-MUNISIYAH\nفي:27-01-2026 21:28';

test('real urpay text: purchase taken off the balance, its own date kept', async () => {
  const t = Core.parseWalletSms(URPAY_MCD, 'urpay', { receivedAt: '2026-01-27T21:28:09+03:00' });
  assert.equal(t.amount, -3);
  assert.equal(t.merchant, 'MCDONALDS-MUNISIYAH');
  assert.equal(t.balance_after, null);
  assert.equal(t.date, '2026-01-27T21:28:00+03:00');
  const d = Core.emptyData();
  Core.setWalletStart(d, 'urpay', 39, { at: '2026-01-27T20:00:00+03:00' });
  await Core.importTexts(d, W('URPAY', URPAY_MCD, '2026-01-27T21:28:09+03:00'));
  const u = Core.walletsView(d).wallets.find((w) => w.id === 'urpay');
  assert.equal(u.balance, 36);
  assert.equal(d.transactions[0].category, 'dining');
});

// Real urpay top-up, paid with the ANB card through Apple Pay (card digits changed).
const URPAY_TOPUP = 'إضافة الأموال عبر Apple Pay\nمبلغ:50 SR\nبطاقة: Visa - 1111\nإلى: urpay\n17-10-2026 19:59';

test('real urpay top-up adds to urpay; paid by the ANB card it is one transfer, not spending', async () => {
  const t = Core.parseWalletSms(URPAY_TOPUP, 'urpay', {});
  assert.equal(t.amount, 50);
  assert.equal(t.raw_category, 'wallet_topup');
  assert.equal(t.date, '2026-10-17T19:59:00+03:00');
  const d = Core.emptyData();
  Core.setWalletStart(d, 'urpay', 39, { at: '2026-10-17T10:00:00+03:00' });
  Core.setWalletStart(d, 'anb', 1000, { at: '2026-10-17T10:00:00+03:00', limit: 10000 });
  await Core.importTexts(d, W('URPAY', URPAY_TOPUP, '2026-10-17T19:59:10+03:00') +
    W('ANB', 'Online Purchase\nApple Pay\nVISA Card:1111\nAmount:SAR 50.00\nBalance:SAR 8,950.00\nAt:urpay\nOn:17/10/26 19:59', '2026-10-17T19:59:08+03:00'));
  const v = Core.walletsView(d, Core.periodOf(d, '2026-10-17')).wallets;
  assert.equal(v.find((w) => w.id === 'urpay').balance, 89);
  assert.equal(v.find((w) => w.id === 'anb').balance, -1050);
  assert.ok(d.transactions.every((x) => x.link && x.category === 'transfer'));
  assert.equal(Core.monthSummary(d, Core.periodOf(d, '2026-10-17')).spending, 0);
});

// Real STC Bank (STC Pay) formats, card digits and names changed.
test('STC Pay: foreign online purchase spends the SAR total with fees, keeps the balance', () => {
  const t = Core.parseWalletSms('Online Purchase\nVia: *1234,Visa\nAmount: 149.05 USD\nFrom: ALIEXP\nExchange rate: 3.754176\nVAT: 0.00 SAR\nFees: 11.19 SAR\nTotal due amount: 570.75 SAR\nRemaining balance: 84.54 SAR\nCountry: LU\nAt: 03/11/26 22:33', 'stcpay', {});
  assert.equal(t.amount, -570.75);
  assert.equal(t.currency, 'SAR');
  assert.equal(t.merchant, 'ALIEXP');
  assert.equal(t.raw_category, 'online_purchase');
  assert.equal(t.card_last4, '1234');
  assert.equal(t.balance_after, 84.54);
  assert.equal(t.date, '2026-11-03T22:33:00+03:00');
});

test('STC Pay: mada Apple Pay purchase', () => {
  const t = Core.parseWalletSms('online purchase\nCard:*5678;mada-Apple Pay\nAmount:10 SR\nAccount number:0000 \nAt:barq \n27/10/26 00:02', 'stcpay', {});
  assert.equal(t.amount, -10);
  assert.equal(t.merchant, 'barq');
  assert.equal(t.card_last4, '5678');
  assert.equal(t.date, '2026-10-27T00:02:00+03:00');
});

test('STC Pay: internal outward transfer', () => {
  const t = Core.parseWalletSms('Internal outward transfer\nAmount:100SR\nTo:A B\nAcc:000\nAt:01/10/26 13:21', 'stcpay', {});
  assert.equal(t.amount, -100);
  assert.equal(t.raw_category, 'transfer_out');
  assert.equal(t.merchant, 'A B');
  assert.equal(t.date, '2026-10-01T13:21:00+03:00');
});
