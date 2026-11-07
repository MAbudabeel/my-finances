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
  assert.equal(Core.monthSummary(d, '2026-10').salary, 18000, 'paid on the 28th: counts for the next month');
  d.meta.month_mode = 'calendar';
  assert.equal(Core.monthSummary(d, '2026-09').salary, 18000, 'calendar months when chosen');
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

test('SADAD bill: payee from الخدمة, Bills, bill number not kept', async () => {
  const sms = 'سداد فاتورة\nمن:1234\nمبلغ:SAR 200.00\nمفوتر:002\nالخدمة:الشركة السعودية للكهرباء\nالفاتورة:10000000001\n26/2/26 21:57';
  const t = Core.parseAlRajhiSms(sms);
  assert.equal(t.amount, -200);
  assert.equal(t.merchant, 'الشركة السعودية للكهرباء');
  assert.equal(t.date, '2026-02-26T21:57:00+03:00');
  const d = Core.emptyData();
  await Core.importTexts(d, sms);
  assert.equal(d.transactions[0].category, 'bills');
  assert.ok(!d.transactions[0].raw.includes('10000000001'));
  // Pasting it again is still recognised as the same text.
  assert.equal((await Core.importTexts(d, sms)).duplicates, 1);
});

test('file written by newer iOS: ##SMS## on the same line as the text, and one-line texts', async () => {
  const samples = [
    ['شراء PoS\nعبر:1111;مدى-ابل باي\nبـSAR 28\nلـCOFFEE AD\n27/10/26 12:10', -28, 'COFFEE AD'],
    ['شراء إنترنت بـSR 66.50 \nعبر2222;فيزا\nلـAmazon sa\nرصيد:0.47 SR\n26/10/26 13:15', -66.5, 'Amazon sa'],
    ['حوالة داخلية صادرة بـSR 250\nمن1234\nلـ5678;محمد أحمد\n26/9/28 09:22', -250, 'محمد أحمد'],
    ['سحب:صراف آلي بSR 100\nعبر1111;مدى\nمنSOME STATION\n27/10/26 17:26', -100, 'SOME STATION'],
    ['شراء عبر نقاط البيع دولية\nبطاقة:1111;مدى\nمبلغ:SAR 23.00\nدولة:Saudi Arabia\nلدى:bolt.eu\n26/10/18 15:32', -23, 'bolt.eu'],
    ['خصم: قسط تمويل\nالقسط: 2000.50 SAR\nمن: 1234\nالمبلغ المتبقي: SAR 40000.00\n28/9/26 20:06', -2000.5, null],
    ['حوالة محلية واردة بـSR 18000.00\nلـ1234\nمن;EMPLOYER COMPANY\n26/9/28 09:01', 18000, 'EMPLOYER COMPANY'],
  ];
  for (const [sms, amount, merchant] of samples) {
    const oneLine = sms.replace(/\n/g, ' ');
    const t = Core.parseAlRajhiSms(oneLine, { receivedAt: '2026-10-28T09:00:00Z' });
    assert.ok(t, 'parsed: ' + oneLine);
    assert.equal(t.amount, amount, oneLine);
    assert.equal(t.merchant, merchant, oneLine);
  }
  // Marker glued to the text, multi-line and one-line entries mixed.
  const file = '##SMS##' + samples[0][0] + '\n##SMS##' + samples[1][0].replace(/\n/g, ' ') + '\n##SMS## ' + samples[2][0] + '\n';
  const d = Core.emptyData();
  const r = await Core.importTexts(d, file);
  assert.equal(r.inserted, 3, JSON.stringify(r));
  assert.equal(r.ignored, 0);
  // No line break between entries.
  const r2 = await Core.importTexts(Core.emptyData(), '##SMS##' + samples[3][0].replace(/\n/g, ' ') + '##SMS##' + samples[4][0].replace(/\n/g, ' '));
  assert.equal(r2.inserted, 2, JSON.stringify(r2));
});

test('Saudi merchants: common PoS names land in the right category', () => {
  const pos = (m) => Core.categorize({ merchant: m, amount: -1000, raw_category: 'pos_purchase' }).category;
  assert.equal(pos('HYPER PANDA 123'), 'groceries');
  assert.equal(pos('TAMWEENAT AL NOOR'), 'groceries');
  assert.equal(pos('ALBAIK 0045'), 'dining');
  assert.equal(pos('BARNS 11'), 'coffee');
  assert.equal(pos('ALDREES 334'), 'fuel');
  assert.equal(pos('NAJM INSURANCE'), 'car');
  assert.equal(pos('NAHDI MEDICAL CO'), 'health');
  assert.equal(pos('BARBER SHOP'), 'personal_care');
  assert.equal(pos('IKEA RIYADH'), 'home');
  assert.equal(pos('NOON.COM'), 'shopping');
  // Short words only match whole words, and names don't trigger categories on transfers.
  assert.equal(pos('القانون'), 'other');
  assert.equal(pos('ZAINAB'), 'other');
  assert.equal(Core.categorize({ merchant: 'Karim Ahmed', amount: -50000, raw_category: 'transfer_out' }).category, 'transfer');
});

test('saved transactions are re-sorted once after a keyword update, manual choices kept', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, 'شراء PoS\nعبر:1111;مدى\nبـSAR 50\nلـALDREES 1\n1/11/26 10:00\n\nشراء PoS\nعبر:1111;مدى\nبـSAR 9\nلـSHOP X\n1/11/26 11:00');
  d.transactions[0].category = 'transport'; // as an older version filed it
  Core.recategorize(d, d.transactions[1].id, 'dining', false);
  d.meta.cat_version = 1;
  assert.equal(Core.upgradeCategories(d), true);
  assert.equal(d.transactions[0].category, 'fuel');
  assert.equal(d.transactions[1].category, 'dining');
  assert.equal(Core.upgradeCategories(d), false);
});

test('unknown shops are listed until the user picks, and "Other" stops the asking', async () => {
  const d = Core.emptyData();
  const t = (m, a) => `شراء PoS\nعبر:1111;مدى\nبـSAR ${a}\nلـ${m}\n1/11/26 10:${a}\n`;
  await Core.importTexts(d, [t('XYZ TRADING EST', 11), t('XYZ TRADING EST', 12), t('QWE ABC', 13), t('ALBAIK 1', 14)].join('\n'));
  let u = Core.unknownShops(d);
  assert.deepEqual(u.map((s) => s.merchant), ['XYZ TRADING EST', 'QWE ABC']);
  Core.recategorize(d, u[0].tx_id, 'groceries', true);
  Core.recategorize(d, u[1].tx_id, 'other', true);
  assert.equal(Core.unknownShops(d).length, 0);
  assert.ok(d.transactions.filter((x) => x.merchant === 'XYZ TRADING EST').every((x) => x.category === 'groceries'));
});

test('statement PDF rows: layout grouping, types, names, and no double count with texts', async () => {
  const it = (x, y, str) => ({ page: 2, x, y, str });
  const items = [
    it(65, 803, 'Date'), it(158, 803, 'Transaction Details'), it(319, 803, 'Debit'),
    it(50, 778, '2026/07/27'), it(111, 784, 'POS purchase Apple pay (Domestic)'), it(111, 776, 'Time:19:41:59, Notes:(1111222233334444-555566667777) ALBAIK'),
    it(111, 770, 'BRANCH 9, RIYADH, SA'), it(311, 778, '30.00 SAR'), it(403, 778, '0.00 SAR'), it(486, 778, '970.00 SAR'),
    it(50, 752, '2026/07/28'), it(111, 758, 'Sariee Inward Payments'), it(111, 750, 'Time:09:04:45, Notes:PAYROLL-SRJHI00000000001-'),
    it(111, 744, 'XXBANK0000001-EXAMPLE TRADING COMPANY-'), it(313, 752, '0.00 SAR'), it(393, 752, '9,000.00 SAR'), it(484, 752, '9,970.00 SAR'),
    it(50, 726, '2026/07/28'), it(111, 732, 'Internal Transfer'), it(111, 721, 'Time:17:37:26, Notes:W-/TOACCT/00000000000000001TOسالم-ايجار'),
    it(305, 726, '2,500.00 SAR'), it(403, 726, '0.00 SAR'), it(486, 726, '7,470.00 SAR'),
    it(50, 700, '2026/07/29'), it(111, 706, 'Outward IPS Credit Transaction Charges'), it(111, 695, 'Time:09:29:42, Notes:9100000000000001/SOMEONE'),
    it(313, 700, '1.15 SAR'), it(403, 700, '0.00 SAR'), it(484, 700, '7,468.85 SAR'),
    it(50, 674, '2026/07/30'), it(111, 680, 'Partial payment'), it(111, 669, 'Time:17:23:47, Notes:T24 INST. 45 LOAN 00000000'),
    it(305, 674, '100.00 SAR'), it(403, 674, '0.00 SAR'), it(486, 674, '7,368.85 SAR')
  ];
  const rows = Core.statementRows(items);
  assert.equal(rows.length, 5);
  const d = Core.emptyData();
  await Core.importTexts(d, 'شراء PoS\nعبر:1111;مدى-ابل باي\nبـSAR 30\nلـALBAIK 9\n27/7/26 19:41');
  const r = Core.importStatement(d, rows);
  assert.equal(r.inserted, 4); assert.equal(r.matched, 1);
  const by = (m) => d.transactions.find((t) => t.merchant === m);
  assert.equal(by('EXAMPLE TRADING COMPANY').category, 'salary');
  assert.equal(by('سالم').category, 'housing'); // transfer note says rent
  assert.equal(by('Bank charges').category, 'bank_fees');
  assert.ok(d.transactions.some((t) => t.raw_category === 'loan_installment' && t.category === 'financing'));
  assert.equal(Core.importStatement(d, rows).inserted, 0);
});

test('pay months run from payday to the day before the next payday', async () => {
  const d = Core.emptyData();
  const sal = (dd, a) => `حوالة محلية واردة بـSR ${a}\nلـ1234\nمن;EMPLOYER COMPANY\n${dd} 09:00\n`;
  const pos = (dd, a) => `شراء PoS\nعبر:1111;مدى\nبـSAR ${a}\nلـALBAIK 1\n${dd} 12:00\n`;
  await Core.importTexts(d, [sal('28/9/26', 9000), sal('27/10/26', 9000), pos('27/9/26', 11), pos('28/9/26', 22), pos('26/10/26', 33), pos('27/10/26', 44), pos('5/11/26', 55)].join('\n'));
  assert.equal(Core.periodOf(d, '2026-09-27'), '2026-09');
  assert.equal(Core.periodOf(d, '2026-09-28'), '2026-10');
  assert.equal(Core.periodOf(d, '2026-10-26'), '2026-10');
  assert.equal(Core.periodOf(d, '2026-10-27'), '2026-11');
  // No November salary yet: December is expected to start on the usual payday (median day 27 or 28).
  assert.ok(['2026-11-27', '2026-11-28'].includes(Core.periodRange(d, '2026-12').start));
  assert.deepEqual(Core.periodRange(d, '2026-10'), { start: '2026-09-28', end: '2026-10-26', payday: true });
  assert.equal(Core.monthSummary(d, '2026-10').spending, 22 + 33);
  assert.equal(Core.monthSummary(d, '2026-11').spending, 44 + 55);
  assert.deepEqual(Core.monthsWithData(d), ['2026-09', '2026-10', '2026-11']);
  d.meta.month_mode = 'calendar';
  assert.equal(Core.periodOf(d, '2026-09-28'), '2026-09');
  assert.equal(Core.periodRange(d, '2026-10').start, '2026-10-01');
});

test('plan: safe to spend until payday counts spending, transfers to people and bills still due', async () => {
  const d = Core.emptyData();
  const now = new Date(2026, 10, 7); // 7 Nov 2026
  await Core.importTexts(d, FinDemo.demoTexts(now));
  Core.detect(d, { asOf: '2026-11-07' });
  const p = Core.planView(d, '2026-11-07');
  assert.equal(p.month, '2026-11');
  assert.equal(p.start, '2026-10-27');
  assert.equal(p.payday, '2026-11-27');
  assert.equal(p.days_left, 20);
  assert.equal(p.day, 12);
  assert.equal(p.income, 18000);
  assert.equal(p.sent, 4500); // rent to the landlord
  const rent = p.bills.find((b) => b.name === 'Landlord');
  assert.ok(rent && rent.paid, 'monthly rent transfer is found and marked paid');
  const stc = p.bills.find((b) => b.name === 'Stc');
  assert.ok(stc && !stc.paid && stc.date === '2026-11-15');
  assert.ok(!p.bills.some((b) => /spotify/i.test(b.name)), 'cancelled subscriptions are left out');
  const due = p.bills.filter((b) => !b.paid).reduce((a, b) => a + b.amount, 0);
  assert.equal(Math.round(due * 100), Math.round(p.bills_left * 100));
  assert.equal(Math.round(p.safe * 100), Math.round((p.income - p.spent - p.sent - p.bills_left) * 100));
  assert.equal(p.pace, 'on_track');
  assert.equal(p.recap.month, '2026-10');
  assert.ok(p.recap.has_data);
  assert.equal(p.recap.top[0].category, 'groceries');
  assert.equal(Math.round(p.recap.saved * 100), Math.round((p.recap.income - p.recap.spent - p.recap.sent) * 100));
});

test('plan: before any salary the plan says so instead of a negative number', async () => {
  const d = Core.emptyData();
  await Core.importTexts(d, 'شراء PoS\nعبر:1111;مدى\nبـSAR 50\nلـALBAIK 1\n3/11/26 12:00\n');
  const p = Core.planView(d, '2026-11-05');
  assert.equal(p.pace, 'no_income');
  assert.equal(p.per_day, 0);
  assert.equal(p.bills.length, 0);
  assert.equal(p.recap.has_data, false);
});
