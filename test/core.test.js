// node --test test/   (Node 20+; no dependencies)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');
globalThis.self = globalThis;
require('../js/demo.js');

// Real Al Rajhi formats (from finance-app/sync/test, card digits are fake).
const REAL = {
  pos: 'شراء PoS\n\nعبر:1111;مدى-ابل باي\n\nبـSAR 4\n\nلـMONTE CAR\n\n3/11/26 22:05',
  cardPayment: 'بطاقة فيزا:سداد بـSR 120 \n\nعبر2222;فيزا\n\nرصيد:1000.00 SR \n\n5/11/26 11:53',
  online: 'شراء إنترنت بـSR 129 \n\nعبر2222;فيزا\n\nلـAmazon sa\n\nرصيد:871.00 SR\n\n5/11/26 11:53',
};

test('parses the real POS alert', () => {
  const t = Core.parseAlRajhiSms(REAL.pos);
  assert.equal(t.amount, -4);
  assert.equal(t.merchant, 'MONTE CAR');
  assert.equal(t.card_last4, '1111');
  assert.equal(t.date, '2026-11-03T22:05:00+03:00');
  assert.equal(t.raw_category, 'pos_purchase');
});

test('card payoff is money into the card (transfer), not spending', () => {
  const t = Core.parseAlRajhiSms(REAL.cardPayment);
  assert.equal(t.amount, 120);
  assert.equal(t.raw_category, 'card_payment');
  assert.equal(Core.categorize({ ...t, amount: 12000 }).category, 'transfer');
});

test('online purchase with amount on the header line', () => {
  const t = Core.parseAlRajhiSms(REAL.online);
  assert.equal(t.amount, -129);
  assert.equal(t.merchant, 'Amazon sa');
  assert.equal(t.balance_after, 871);
  assert.equal(t.description, 'شراء إنترنت | Amazon sa');
});

test('older layout, Arabic digits, English layout, foreign currency', () => {
  const a = Core.parseAlRajhiSms('شراء عبر نقاط البيع\nبطاقة: ٤٣٢١ ;مدى\nمبلغ: ٢٥٫٥٠ ر.س\nلدى: PANDA RETAIL CO\nالرصيد: 8,450.25 SAR\nفي: 5/11/2026 13:22');
  assert.equal(a.amount, -25.5);
  assert.equal(a.merchant, 'PANDA RETAIL CO');
  const b = Core.parseAlRajhiSms('Online Purchase\nCard: *4321\nAmount: USD 10.99\nAt: SPOTIFY\nDate: 2026-11-03 03:10');
  assert.equal(b.currency, 'USD');
  assert.equal(b.amount, -10.99);
});

test('OTPs and marketing are ignored', () => {
  assert.equal(Core.parseAlRajhiSms('رمز التحقق: 123456 لا تشاركه مع أحد'), null);
  assert.equal(Core.parseAlRajhiSms('Enjoy 20% off with Al Rajhi cards this weekend!'), null);
});

test('splits Shortcut queue (markers) and hand-pasted texts (date line ends each one)', () => {
  const q = `##SMS## 2026-11-05T11:53:10+03:00\n${REAL.cardPayment}\n##SMS## 2026-11-05T11:54:00+03:00\n${REAL.online}\n`;
  const a = Core.splitMessages(q);
  assert.equal(a.length, 2);
  assert.equal(a[0].receivedAt, '2026-11-05T11:53:10+03:00');
  const b = Core.splitMessages(`${REAL.pos}\n\n${REAL.online}\n\n${REAL.cardPayment}`);
  assert.equal(b.length, 3);
  assert.equal(Core.parseAlRajhiSms(b[1].text).merchant, 'Amazon sa');
  assert.equal(Core.splitMessages(REAL.pos).length, 1);
  assert.equal(Core.splitMessages('').length, 0);
  // A code text (no date line) between two alerts doesn't swallow the next one.
  const c = Core.splitMessages(`${REAL.pos}\n\nرمز التحقق: 123456 لا تشاركه مع أحد\n\n${REAL.online}`);
  assert.equal(c.length, 3);
  assert.equal(Core.parseAlRajhiSms(c[2].text).merchant, 'Amazon sa');
  // The old layout (card line starting with بطاقة) stays one message.
  assert.equal(Core.splitMessages('شراء عبر نقاط البيع\nبطاقة: ٤٣٢١ ;مدى\nمبلغ: ٢٥٫٥٠ ر.س\nلدى: PANDA\nفي: 5/11/2026 13:22').length, 1);
});

test('re-adding the same texts never duplicates', async () => {
  const d = Core.emptyData();
  const text = `${REAL.pos}\n\n${REAL.online}`;
  const r1 = await Core.importTexts(d, text);
  assert.equal(r1.inserted, 2);
  const r2 = await Core.importTexts(d, text);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.duplicates, 2);
  assert.equal(d.transactions.length, 2);
  // Whitespace differences (Shortcut vs copy from Messages) still match.
  const r3 = await Core.importTexts(d, REAL.pos.replace(/\n\n/g, '\n'));
  assert.equal(r3.duplicates, 1);
});

test('foreign amounts are converted to SAR and the original kept', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, 'Online Purchase\nCard: *4321\nAmount: USD 10.00\nAt: SOMESHOP\nDate: 2026-11-03 03:10');
  const t = d.transactions[0];
  assert.equal(t.amount, -3750);
  assert.equal(t.original_amount, -1000);
  assert.equal(t.original_currency, 'USD');
});

test('unknown merchant goes to Other (QA M3)', () => {
  assert.equal(Core.categorize({ merchant: 'ABC GENERAL EST', amount: -1000, raw_category: 'pos_purchase' }).category, 'other');
});

test('UTC timestamps are bucketed by Riyadh date (QA F5)', () => {
  assert.equal(Core.toDay('2026-09-30T21:30:00Z'), '2026-10-01');
  assert.equal(Core.toDay('2026-11-03T22:05:00+03:00'), '2026-11-03');
});

test('manual category survives and "always" creates a rule', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, 'شراء PoS\nعبر:1111;مدى\nبـSAR 30\nلـXYZ SHOP\n1/10/26 10:00\n\nشراء PoS\nعبر:1111;مدى\nبـSAR 40\nلـXYZ SHOP\n9/10/26 10:00');
  assert.equal(d.transactions[0].category, 'other');
  Core.recategorize(d, d.transactions[0].id, 'groceries', true);
  assert.equal(d.transactions[0].category, 'groceries');
  assert.equal(d.transactions[1].category, 'groceries'); // via rule
  await Core.importTexts(d, 'شراء PoS\nعبر:1111;مدى\nبـSAR 50\nلـXYZ SHOP\n15/10/26 10:00');
  assert.equal(d.transactions[2].category, 'groceries');
});

// Demo data = 6 months of realistic texts ending "now". Checks the QA scenarios.
async function demoData(now) {
  const d = Core.emptyData();
  const r = await Core.importTexts(d, self.FinDemo.demoTexts(now));
  return { d, r };
}

test('demo: every text is read, OTPs ignored', async () => {
  const { r } = await demoData(new Date());
  assert.equal(r.skipped, 0, JSON.stringify(r.errors));
  assert.ok(r.inserted > 100);
  assert.ok(r.ignored >= 5);
});

test('demo: salary, subscriptions, price change, cancelled, refund, transfers', async () => {
  const now = new Date();
  const { d } = await demoData(now);
  const subs = Core.subscriptionsOut(d);
  const byName = (n) => subs.find((s) => s.name.toLowerCase().includes(n));
  assert.ok(byName('netflix'), 'Netflix detected');
  assert.equal(byName('netflix').status, 'active');
  assert.equal(byName('shahid').amount, 44.99, 'latest price used (QA F4)');
  assert.equal(byName('spotify'), undefined, 'Spotify is cancelled so not listed');
  assert.ok(d.subscriptions.find((s) => s.merchant_key.includes('spotify')).status === 'cancelled');
  assert.equal(byName('panda'), undefined, 'weekly groceries are not a subscription');

  // Two months ago: 300 noon purchase + 300 refund nets to 0, not income (QA F3).
  const m2 = Core.shiftMonth(Core.monthOf(Core.today()), -2);
  const s2 = Core.monthSummary(d, m2);
  assert.equal(s2.income, 18000);
  assert.equal(s2.salary, 18000);
  assert.equal(s2.refunds, 300);
  const cats = Core.categoryBreakdown(d, m2);
  assert.equal(cats.find((c) => c.category === 'shopping'), undefined, 'refund nets shopping to zero');
  // Rent transfer and card payoff are excluded from income and spending.
  assert.equal(s2.transfers_out, 4500);
  assert.equal(s2.transfers_in, 600);
  // Category totals equal spending (QA TOT-03).
  const sum = cats.reduce((a, c) => a + c.amount, 0);
  assert.equal(Math.round(sum * 100), Math.round(s2.spending * 100));
});

test('salary breakdown compares expected with received', async () => {
  const { d } = await demoData(new Date());
  const v = Core.setSalaryProfile(d, [
    { label: 'Basic salary', type: 'earning', amount: 14000 },
    { label: 'Housing allowance', type: 'earning', amount: 3500 },
    { label: 'Transport allowance', type: 'earning', amount: 1200 },
    { label: 'GOSI', type: 'deduction', amount: 1706.25 },
  ]);
  assert.equal(v.gross, 18700);
  assert.equal(v.expected_net, 16993.75);
  assert.ok(v.detected.length >= 5);
  assert.equal(v.latest_difference, 18000 - 16993.75);
  assert.throws(() => Core.setSalaryProfile(d, [{ label: '', type: 'earning', amount: 1 }]));
  assert.throws(() => Core.setSalaryProfile(d, [{ label: 'x', type: 'earning', amount: -1 }]));
  assert.throws(() => Core.setSalaryProfile(d, new Array(31).fill({ label: 'x', type: 'earning', amount: 1 })));
});

test('subscription can be marked "not a subscription" and stays that way', async () => {
  const { d } = await demoData(new Date());
  const netflix = d.subscriptions.find((s) => s.merchant_key.includes('netflix'));
  Core.setSubscriptionStatus(d, netflix.id, 'ignored');
  await Core.importTexts(d, 'شراء إنترنت بـSR 56.00\nعبر2222;فيزا\nلـNETFLIX.COM\nرصيد:500.00 SR\n1/1/27 03:10');
  assert.equal(d.subscriptions.find((s) => s.id === netflix.id).status, 'ignored');
  assert.equal(Core.subscriptionsOut(d).find((s) => s.id === netflix.id), undefined);
});

test('backup data validation rejects garbage', () => {
  assert.throws(() => Core.validateData({}));
  assert.throws(() => Core.validateData({ version: 1, transactions: [{ amount: 'x' }], subscriptions: [] }));
  const ok = Core.validateData(JSON.parse(JSON.stringify(Core.emptyData())));
  assert.equal(ok.version, 1);
});

test('merchant names with markup are kept as plain text', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, 'شراء PoS\nعبر:1111;مدى\nبـSAR 5\nلـ<img src=x onerror=alert(1)>\n1/11/26 10:00');
  assert.equal(d.transactions[0].merchant, '<img src=x onerror=alert(1)>');
});

// Real local-transfer layout (from the user, amount and names changed).
test('incoming local transfer from an employer is salary income', async () => {
  const sms = 'حوالة محلية واردة بـSR 18000.00\nلـ1234\nمن;EMPLOYER COMPANY\n26/9/28 09:01';
  const t = Core.parseAlRajhiSms(sms, { receivedAt: '2026-09-28T06:02:00Z' });
  assert.equal(t.amount, 18000);
  assert.equal(t.raw_category, 'transfer_in');
  assert.equal(t.merchant, 'EMPLOYER COMPANY');
  assert.equal(t.date, '2026-09-28T09:01:00+03:00', 'yy/m/d when d/m/yy would be in the future');
  const d = Core.emptyData();
  await Core.importTexts(d, sms);
  assert.equal(d.transactions[0].category, 'salary');
  assert.equal(Core.monthSummary(d, '2026-09').salary, 18000);
  // A small incoming transfer from a person stays a transfer.
  const p = Core.parseAlRajhiSms('حوالة محلية واردة بـSR 300\nلـ1234\nمن;AHMED\n1/11/26 10:00', { receivedAt: '2026-11-01T07:00:00Z' });
  assert.equal(Core.categorize({ ...p, amount: 30000 }).category, 'transfer');
  assert.equal(p.date, '2026-11-01T10:00:00+03:00', 'normal d/m/yy unchanged');
});

test('monthly incoming transfers of the same size become salary', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, ['27/8/26', '27/9/26', '27/10/26'].map((dt) => `حوالة محلية واردة بـSR 9000\nلـ1234\nمن;ABDULLAH\n${dt} 09:00`).join('\n'));
  assert.ok(d.transactions.every((t) => t.category === 'salary'));
});


test('transfer between own accounts is a transfer, and a text caught twice is added once', async () => {
  const sms = 'حوالة بين حساباتك\nمبلغ:SR 1000\nمن:1234\nالى:5678\n26/9/28 09:17';
  const t = Core.parseAlRajhiSms(sms);
  assert.equal(t.amount, -1000);
  assert.equal(t.raw_category, 'own_transfer');
  assert.equal(t.date, '2026-09-28T09:17:00+03:00');
  const d = Core.emptyData();
  const r = await Core.importTexts(d, '##SMS##\n' + sms + '\n##SMS##\n' + sms);
  assert.equal(r.inserted, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(d.transactions[0].category, 'transfer');
  const s = Core.monthSummary(d, '2026-09');
  assert.equal(s.spending, 0);
  assert.equal(s.income, 0);
});

test('outgoing internal transfer to a person: money out, name after ";"', async () => {
  const sms = 'حوالة داخلية صادرة بـSR 2500\nمن1234\nلـ5678;محمد أحمد\n26/9/28 09:22';
  const t = Core.parseAlRajhiSms(sms);
  assert.equal(t.amount, -2500);
  assert.equal(t.raw_category, 'transfer_out');
  assert.equal(t.merchant, 'محمد أحمد');
  assert.equal(t.date, '2026-09-28T09:22:00+03:00');
  assert.equal(Core.categorize({ ...t, amount: -250000 }).category, 'transfer');
});

test('loan installment: the installment is spending (Loans), the remaining amount is ignored', async () => {
  const sms = 'خصم: قسط تمويل\nالقسط: 2000.50 SAR\nمن: 1234\nالمبلغ المتبقي: SAR 40000.00\n28/9/26 20:06';
  const t = Core.parseAlRajhiSms(sms);
  assert.equal(t.amount, -2000.5);
  assert.equal(t.raw_category, 'loan_installment');
  assert.equal(t.balance_after, 40000);
  assert.equal(t.date, '2026-09-28T20:06:00+03:00', 'day-first date');
  const d = Core.emptyData();
  await Core.importTexts(d, ['28/8/26', '28/9/26', '28/10/26'].map((dt) => sms.replace('28/9/26', dt)).join('\n'));
  assert.ok(d.transactions.every((x) => x.category === 'financing'));
  assert.equal(Core.monthSummary(d, '2026-09').spending, 2000.5);
  const loan = d.subscriptions.find((x) => x.category === 'financing');
  assert.ok(loan, 'detected as a recurring payment');
  assert.equal(loan.kind, 'recurring');
  assert.equal(loan.cycle, 'monthly');
});

test('incoming transfer from an airline is a travel refund, not salary or a transfer', async () => {
  const sms = 'حوالة محلية واردة بـSR 398\nلـ1234\nمن8004;FLYADEAL AIRLINE COMPANY ONE PERSON\n26/10/6 09:04';
  const t = Core.parseAlRajhiSms(sms);
  assert.equal(t.amount, 398);
  assert.equal(t.merchant, 'FLYADEAL AIRLINE COMPANY ONE PERSON');
  assert.equal(t.date, '2026-10-06T09:04:00+03:00');
  const d = Core.emptyData();
  await Core.importTexts(d, sms);
  assert.equal(d.transactions[0].category, 'travel');
  assert.equal(d.transactions[0].type, 'refund');
  const s = Core.monthSummary(d, '2026-10');
  assert.equal(s.income, 0);
  assert.equal(s.refunds, 398);
  // A big refund from a company that's a known merchant is still not salary.
  assert.equal(Core.categorize({ ...t, amount: 250000 }).category, 'travel');
  // "من1234" with only digits is an account, not a name.
  assert.equal(Core.parseAlRajhiSms('حوالة داخلية صادرة بـSR 10\nمن1234\nلـ5678;X\n1/11/26 10:00').account_last4, '1234');
});

test('online purchase at STC with من line: spending in Bills, monthly charges become a subscription', async () => {
  const sms = 'شراء انترنت بـSR 50.00 \nعبر1111;مدى-ابل باي\nمن1234\nلـSTC\n17/10/26 16:52';
  const t = Core.parseAlRajhiSms(sms);
  assert.equal(t.amount, -50);
  assert.equal(t.merchant, 'STC');
  const d = Core.emptyData();
  await Core.importTexts(d, ['17/8/26', '17/9/26', '17/10/26'].map((x) => sms.replace('17/10/26', x)).join('\n'));
  assert.ok(d.transactions.every((x) => x.category === 'bills'));
  const sub = Core.subscriptionsOut(d)[0];
  assert.equal(sub.name, 'Stc');
  assert.equal(sub.status, 'active');
});

test('international POS (key:value lines): merchant from لدى:, yy/m/d date, transport', () => {
  const t = Core.parseAlRajhiSms('شراء عبر نقاط البيع دولية\nبطاقة:1111;مدى\nمبلغ:SAR 23.00\nدولة:Saudi Arabia\nلدى:bolt.eu\n26/10/18 15:32', { receivedAt: '2026-10-18T12:33:00Z' });
  assert.equal(t.amount, -23);
  assert.equal(t.merchant, 'bolt.eu');
  assert.equal(t.date, '2026-10-18T15:32:00+03:00');
  assert.equal(Core.categorize({ ...t, amount: -2300 }).category, 'transport');
  // Day-first texts still read day-first.
  assert.equal(Core.parseSmsDate('3/11/26 22:05', '2026-11-03T19:06:00Z'), '2026-11-03T22:05:00+03:00');
  assert.equal(Core.parseSmsDate('28/9/26 20:06', '2026-09-28T17:07:00Z'), '2026-09-28T20:06:00+03:00');
});

test('ATM withdrawal with plain ب before the amount: Cash, location kept', () => {
  const t = Core.parseAlRajhiSms('سحب:صراف آلي بSR 500\nعبر1111;مدى\nمنSOME STATION\n27/10/26 17:26', { receivedAt: '2026-10-27T14:27:00Z' });
  assert.equal(t.amount, -500);
  assert.equal(t.raw_category, 'atm_withdrawal');
  assert.equal(t.merchant, 'SOME STATION');
  assert.equal(t.date, '2026-10-27T17:26:00+03:00');
  assert.equal(Core.categorize({ ...t, amount: -50000 }).category, 'cash');
});
