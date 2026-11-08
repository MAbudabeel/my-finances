// Finance tracker logic, ported from the laptop version (finance-app/backend/src
// and finance-app/sync/parsers). Runs in the browser and in Node (for tests).
// Works on one in-memory object ("data"); store.js encrypts and saves it.
//
// Amounts are integer halalas internally (1 SAR = 100). Negative = money out.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ======================================================================
  // Dates (calendar days in Riyadh, UTC+3, no DST)
  // ======================================================================
  var DAY = 86400000;
  function pad(n) { return String(n).padStart(2, '0'); }
  function parseDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCMonth() !== +m[2] - 1) return null;
    return d;
  }
  function fmtDay(d) { return d.toISOString().slice(0, 10); }
  /** "2026-11-05", "2026-11-05T10:00:00+03:00", "05/11/2026" -> "YYYY-MM-DD" (Riyadh day) */
  function toDay(value) {
    if (value instanceof Date) return fmtDay(new Date(value.getTime() + 3 * 3600000));
    var s = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseDay(s) ? s : null;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      if (!parseDay(s.slice(0, 10))) return null;
      if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
        var t = Date.parse(s);
        if (isNaN(t)) return null;
        return new Date(t + 3 * 3600000).toISOString().slice(0, 10);
      }
      return s.slice(0, 10);
    }
    var dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
    if (dmy) {
      var iso = dmy[3] + '-' + pad(dmy[2]) + '-' + pad(dmy[1]);
      return parseDay(iso) ? iso : null;
    }
    return null;
  }
  function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / DAY); }
  function addDays(day, n) { return fmtDay(new Date(parseDay(day).getTime() + n * DAY)); }
  function addMonths(day, n) {
    var d = parseDay(day);
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return fmtDay(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
  }
  function monthOf(day) { return String(day).slice(0, 7); }
  function isMonth(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')); }
  function monthRange(month) { var start = month + '-01'; return { start: start, end: addDays(addMonths(start, 1), -1) }; }
  function shiftMonth(month, n) { return monthOf(addMonths(month + '-01', n)); }
  function today() { return fmtDay(new Date(Date.now() + 3 * 3600000)); }

  // ======================================================================
  // Money
  // ======================================================================
  var MAX_SAR = 1e9;
  function checkH(h) {
    if (!Number.isSafeInteger(h) || Math.abs(h) > MAX_SAR * 100) throw new Error('amount out of range');
    return h;
  }
  function toHalalas(v) {
    if (typeof v === 'number') { if (!isFinite(v)) throw new Error('amount must be a number'); return checkH(Math.round(v * 100)); }
    if (typeof v === 'string') {
      var s = v.replace(/[,\s]/g, '');
      if (!/^[-+]?\d+(\.\d{1,3})?$/.test(s)) throw new Error('invalid amount');
      return checkH(Math.round(Number(s) * 100));
    }
    throw new Error('amount is required');
  }
  function toSar(h) { return h === null || h === undefined ? null : Math.round(h) / 100; }

  // ======================================================================
  // Al Rajhi SMS parser (same rules as finance-app/sync/parsers/alrajhi-sms.js)
  // ======================================================================
  var ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '٫': '.', '٬': ',' };
  function normDigits(s) { return String(s).replace(/[٠-٩٫٬]/g, function (c) { return ARABIC_DIGITS[c]; }); }

  var TYPE_RULES = [
    { re: /بطاقة[^\n:]*:\s*سداد|سداد\s*(بطاقة|البطاقة)|card\s*(re)?payment/i, type: 'card_payment', channel: 'transfer', sign: +1 },
    // Between your own accounts: moves money, not income or spending.
    { re: /بين\s*حساباتك|between (your|own) accounts|own account transfer/i, type: 'own_transfer', channel: 'transfer', sign: -1 },
    // Loan / financing installment, e.g. "خصم: قسط تمويل" with "القسط: 123 SAR".
    { re: /قسط|تمويل|installment|loan/i, type: 'loan_installment', channel: 'other', sign: -1 },
    { re: /راتب|salary|payroll/i, type: 'salary', channel: 'transfer', sign: +1 },
    { re: /استرداد|استرجاع|refund|reversal/i, type: 'refund', channel: 'other', sign: +1 },
    { re: /(حوالة|تحويل)[^\n\d]*?(واردة|وارد)|incoming (transfer|remittance)|transfer received/i, type: 'transfer_in', channel: 'transfer', sign: +1 },
    { re: /إيداع|ايداع|deposit/i, type: 'deposit', channel: 'other', sign: +1 },
    { re: /(حوالة|تحويل)|outgoing (transfer|remittance)|transfer/i, type: 'transfer_out', channel: 'transfer', sign: -1 },
    { re: /سحب|صراف|atm|withdrawal/i, type: 'atm_withdrawal', channel: 'atm', sign: -1 },
    { re: /سداد|فاتورة|sadad|bill/i, type: 'bill_payment', channel: 'sadad', sign: -1 },
    { re: /رسوم|fee|charge/i, type: 'fee', channel: 'other', sign: -1 },
    { re: /شراء\s*(إنترنت|انترنت|عبر الإنترنت|اونلاين)|online purchase|e-?commerce|internet purchase/i, type: 'online_purchase', channel: 'online', sign: -1 },
    { re: /شراء|نقاط البيع|\bpos\b|purchase/i, type: 'pos_purchase', channel: 'pos', sign: -1 }
  ];
  var IGNORE = /رمز التحقق|كلمة المرور|رمز التفعيل|\botp\b|one[- ]time|verification code|لا تشارك|do not share/i;
  var CUR = '(SAR|SR|USD|EUR|GBP|AED|BHD|KWD|QAR|OMR|EGP|JOD|ر\\.?\\s?س|ريال|دولار)';
  var NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
  var CURRENCY_ALIASES = { SR: 'SAR', 'ر.س': 'SAR', 'رس': 'SAR', 'ر. س': 'SAR', 'ريال': 'SAR', 'دولار': 'USD' };
  function normCurrency(c) {
    if (!c) return 'SAR';
    var k = c.trim();
    return CURRENCY_ALIASES[k] || CURRENCY_ALIASES[k.replace(/\s/g, '')] || k.toUpperCase();
  }
  function toNumber(s) { return Number(s.replace(/,/g, '')); }
  function parseAmount(value) {
    if (!value) return null;
    var v = normDigits(value), m;
    m = v.match(new RegExp(CUR + '\\s*' + NUM, 'i'));
    if (m) return { amount: toNumber(m[2]), currency: normCurrency(m[1]) };
    m = v.match(new RegExp(NUM + '\\s*' + CUR + '?', 'i'));
    if (m) return { amount: toNumber(m[1]), currency: normCurrency(m[2]) };
    return null;
  }
  function toRiyadhIso(date) { return new Date(date.getTime() + 3 * 3600000).toISOString().replace(/\.\d{3}Z$/, '+03:00'); }
  function parseSmsDate(value, fallback) {
    if (value) {
      var v = normDigits(value), m, y, mo, d;
      if ((m = v.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y = m[1]; mo = m[2]; d = m[3]; }
      else if ((m = v.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d)(?!\d)/))) {
        // yy/m/d with a one-digit day, e.g. 26/10/6 = 6 Oct 2026 (transfer alerts)
        y = '20' + pad(m[1]); mo = m[2]; d = m[3];
      }
      else if ((m = v.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/))) {
        d = m[1]; mo = m[2]; y = m[3].length === 2 ? '20' + m[3] : m[3];
        // Al Rajhi uses both d/m/yy (card alerts) and yy/m/d (transfers): pick the
        // reading that isn't in the future and is closest to when the text arrived.
        var ref = fallback ? new Date(fallback) : new Date();
        if (isNaN(ref)) ref = new Date();
        if (m[3].length === 2 && +m[3] >= 1 && +m[3] <= 31 && +m[1] <= 99) {
          var r = ref.getTime();
          var asDmy = Date.UTC(+y, +mo - 1, +d), asYmd = Date.UTC(2000 + +m[1], +m[2] - 1, +m[3]);
          var okDmy = asDmy - r <= 2 * DAY, okYmd = asYmd - r <= 2 * DAY && new Date(asYmd).getUTCDate() === +m[3];
          if (okYmd && (!okDmy || Math.abs(r - asYmd) < Math.abs(r - asDmy))) { y = String(2000 + +m[1]); mo = m[2]; d = m[3]; }
        }
      }
      if (y && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
        var t = v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        var date = y + '-' + pad(mo) + '-' + pad(d);
        return t ? date + 'T' + pad(t[1]) + ':' + t[2] + ':' + (t[3] || '00') + '+03:00' : date;
      }
    }
    if (fallback) { var f = new Date(fallback); if (!isNaN(f)) return toRiyadhIso(f); }
    return null;
  }
  var AMOUNT_RE = new RegExp('(?:^|\\s)(?:بـ|ب\\s|ب(?=(?:SAR|SR|USD|EUR|GBP|AED)\\s*\\d)|بمبلغ|مبلغ\\s*:|المبلغ\\s*:|القسط\\s*:|amount\\s*:|amt\\s*:)\\s*(' + CUR + '?\\s*' + NUM + '\\s*' + CUR + '?)', 'i');
  var MERCHANT_RE = /^(?:لـ|لدى\s*:?|الخدمة\s*:|at\s*:|merchant\s*:)\s*(.+)$/i;
  var TO_RE = /^(?:إلى|الى|to)\s*[:;]\s*(.+)$/i;
  var FROM_RE = /^(?:من|from)\s*[:;]?\s*((?:\*?\d{3,}\s*;?\s*)?.*)$/i; // من: X, من;X, من1234, من1234;X
  var CARD_RE = /^(?:عبر|بطاقة|البطاقة|card)\s*:?\s*\*?(\d{4})\s*(?:;\s*(.+))?$/i;
  var BALANCE_RE = /^(?:رصيد|الرصيد|الرصيد المتاح|المبلغ المتبقي|remaining|balance|bal|available balance)\s*:?\s*(.+)$/i;
  var DATE_LINE_RE = /^(?:(?:في|التاريخ|تاريخ|date|on)\s*:?\s*)?\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/i;
  var INLINE_FIELD = /\s+(?=عبر\s*[:\d]|بـ|لـ|لدى\s*:|من\s*[:;\dA-Za-z]|الى\s*:|إلى\s*:|رصيد\s*:|مبلغ\s*:|القسط\s*:|المبلغ المتبقي|دولة\s*:|بطاقة\s*:|مفوتر\s*:|الخدمة\s*:|الفاتورة\s*:|\d{1,4}\/\d{1,2}\/\d{1,4}\s+\d{1,2}:\d{2})/;
  function last4(s) { if (!s) return null; var m = normDigits(s).match(/(\d{4})(?!.*\d)/); return m ? m[1] : null; }

  /** Parse one Al Rajhi alert. Returns a transaction-like object or null (OTP, marketing, unknown). */
  function parseAlRajhiSms(text, meta) {
    meta = meta || {};
    if (!text || typeof text !== 'string') return null;
    if (IGNORE.test(text)) return null;
    var lines = normDigits(text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    // Some iOS versions hand Shortcuts the alert as one line: split it at the field labels.
    if (lines.length === 1) lines = lines[0].split(INLINE_FIELD).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return null;
    var header = lines[0];
    var rule = TYPE_RULES.find(function (r) { return r.re.test(header); }) || TYPE_RULES.find(function (r) { return r.re.test(text); });
    if (!rule) return null;

    var amount = null, merchant = null, to = null, from = null, card = null, cardNetwork = null, balance = null, dateText = null;
    lines.forEach(function (line) {
      var m;
      if (!amount && (m = line.match(AMOUNT_RE))) amount = parseAmount(m[1]);
      if ((m = line.match(CARD_RE))) { card = card || m[1]; cardNetwork = cardNetwork || (m[2] || '').trim() || null; return; }
      if ((m = line.match(BALANCE_RE))) { balance = balance || parseAmount(m[1]); return; }
      if (DATE_LINE_RE.test(line)) { dateText = dateText || line; return; }
      if (line === header) return;
      if (!merchant && (m = line.match(MERCHANT_RE))) {
        if (/^\*?\d{3,}$/.test(m[1].trim())) { to = to || m[1].trim(); return; }
        var acctName = m[1].trim().match(/^\*?(\d{3,})\s*;\s*(.+)$/); // لـ1234;NAME
        if (acctName) { to = to || acctName[1]; merchant = acctName[2].trim(); return; }
        merchant = m[1].trim(); return;
      }
      if (!to && (m = line.match(TO_RE))) { to = m[1].trim(); return; }
      if (!from && (m = line.match(FROM_RE)) && m[1].trim()) {
        var fv = m[1].trim(), fa = fv.match(/^\*?(\d{3,})\s*(?:;\s*(.*))?$/);
        from = fa ? (fa[2] && fa[2].trim()) || fa[1] : fv;
        return;
      }
    });
    if (!amount) return null;

    var counterparty = merchant || (rule.sign > 0 ? from : to) || (rule.type === 'atm_withdrawal' ? from : null) || null;
    var foreign = amount.currency !== 'SAR';
    var headerType = header.replace(AMOUNT_RE, '').trim();
    return {
      date: parseSmsDate(dateText, meta.receivedAt),
      amount: Math.round(rule.sign * amount.amount * 100) / 100,
      currency: foreign ? amount.currency : 'SAR',
      description: [headerType, counterparty].filter(Boolean).join(' | '),
      merchant: counterparty,
      raw_category: rule.type,
      channel: rule.channel,
      card_last4: card,
      card_network: cardNetwork,
      account_last4: last4(rule.sign > 0 ? to : from),
      balance_after: balance ? balance.amount : null,
      raw: text
    };
  }

  // The iOS Shortcut queues texts as "##SMS## <date>\n<text>". Without markers
  // (texts pasted by hand), each Al Rajhi alert ends with a date-only line.
  // Wallet and credit card texts come from their own automation as "##WALLET:STCPAY##<text>"
  // with "##AT## <date the text arrived>" added at the end (wallet texts often carry no date).
  var MARKER_RE = /^##(SMS|WALLET:([A-Za-z0-9_]{1,20}))##[ \t]*(.*)$/;
  var AT_RE = /##AT##\s*([0-9T:+\-.Z ]{10,40})/;
  // First line of an alert (purchase, card payoff, deposit, transfer, ATM, bill, refund, fee).
  var HEADER_START = /^(شراء|بطاقة[^:\d]*:\s*سداد|إيداع|ايداع|حوالة|تحويل|سحب|سداد|استرداد|استرجاع|رسوم|online purchase|pos purchase|purchase|atm withdrawal|incoming transfer|outgoing transfer|salary|refund)/i;
  function splitMessages(input) {
    var text = String(input || '').replace(/\r\n?/g, '\n')
      .replace(/##WALLET-DONE##/g, '\n')
      .replace(/([^\n])##(SMS|WALLET:)/g, '$1\n##$2');
    var out = [];
    if (/^##(SMS|WALLET:[A-Za-z0-9_]+)##/m.test(text)) {
      var cur = null;
      text.split('\n').forEach(function (line) {
        var m = line.match(MARKER_RE);
        if (m) {
          if (cur) out.push(cur);
          // "##SMS## 2026-11-05T11:53..." carries a date; "##SMS##شراء PoS..." carries the text itself.
          var rest = m[3].trim();
          var isDate = /^\d{4}-\d{2}-\d{2}/.test(rest);
          cur = { receivedAt: isDate ? rest : null, wallet: m[2] ? m[2].toLowerCase() : null, lines: rest && !isDate ? [rest] : [] };
        }
        else if (cur) cur.lines.push(line);
      });
      if (cur) out.push(cur);
    } else {
      var buf = [];
      var flush = function () { if (buf.some(function (x) { return x.trim(); })) out.push({ lines: buf }); buf = []; };
      text.split('\n').forEach(function (line) {
        var l = normDigits(line.trim());
        if (/^-{3,}$/.test(l)) { flush(); return; }
        // Texts without a date line (codes, offers) end where the next alert starts.
        if (IGNORE.test(l)) { flush(); out.push({ lines: [line] }); return; }
        if (HEADER_START.test(l) && !CARD_RE.test(l) && !BALANCE_RE.test(l)) flush();
        buf.push(line);
        if (DATE_LINE_RE.test(l)) { out.push({ lines: buf }); buf = []; }
      });
      if (buf.some(function (l) { return l.trim(); })) out.push({ lines: buf });
    }
    return out.map(function (m) {
      var t = m.lines.join('\n').trim(), at = t.match(AT_RE);
      if (at) t = t.replace(AT_RE, '').trim();
      if (m.wallet && !t) return null;
      return {
        text: t, receivedAt: (at && at[1].trim()) || m.receivedAt || null, wallet: m.wallet || null,
        // Wallet texts are told apart by when they arrived too: two identical 25 SAR coffees are two payments.
        key: m.wallet ? 'w:' + m.wallet + '|' + (at ? at[1].trim() : '') + '|' + t : t
      };
    }).filter(function (m) { return m && m.text && !/^-+$/.test(m.text); });
  }

  // ======================================================================
  // Categories (same as finance-app/backend/src/categorize.js)
  // ======================================================================
  var CATEGORIES = [
    { id: 'salary', label: 'Salary', kind: 'income' },
    { id: 'income', label: 'Other income', kind: 'income' },
    { id: 'refund', label: 'Refunds', kind: 'income' },
    { id: 'groceries', label: 'Groceries', kind: 'spending' },
    { id: 'dining', label: 'Dining & delivery', kind: 'spending' },
    { id: 'coffee', label: 'Coffee', kind: 'spending' },
    { id: 'fuel', label: 'Fuel', kind: 'spending' },
    { id: 'transport', label: 'Rides & transport', kind: 'spending' },
    { id: 'car', label: 'Car & maintenance', kind: 'spending' },
    { id: 'bills', label: 'Bills & utilities', kind: 'spending' },
    { id: 'subscriptions', label: 'Subscriptions', kind: 'spending' },
    { id: 'shopping', label: 'Shopping & clothes', kind: 'spending' },
    { id: 'home', label: 'Home & furniture', kind: 'spending' },
    { id: 'personal_care', label: 'Personal care & beauty', kind: 'spending' },
    { id: 'health', label: 'Health & pharmacy', kind: 'spending' },
    { id: 'housing', label: 'Rent & housing', kind: 'spending' },
    { id: 'government', label: 'Government & fees', kind: 'spending' },
    { id: 'financing', label: 'Loans & installments', kind: 'spending' },
    { id: 'education', label: 'Education', kind: 'spending' },
    { id: 'travel', label: 'Travel', kind: 'spending' },
    { id: 'entertainment', label: 'Entertainment', kind: 'spending' },
    { id: 'charity', label: 'Charity & zakat', kind: 'spending' },
    { id: 'bank_fees', label: 'Bank fees', kind: 'spending' },
    { id: 'cash', label: 'Cash withdrawal', kind: 'spending' },
    { id: 'transfer', label: 'Transfers', kind: 'transfer' },
    { id: 'other', label: 'Other', kind: 'spending' }
  ];
  var CATEGORY_IDS = {};
  CATEGORIES.forEach(function (c) { CATEGORY_IDS[c.id] = true; });

  // First match wins, so the order matters: specific groups first, broad words ("market", "food", "mall") last.
  var BUILTIN = [
    ['salary', ['salary', 'payroll', 'راتب', 'رواتب', 'مسير', 'wps ']],
    ['refund', ['refund', 'reversal', 'استرداد', 'استرجاع', 'cashback']],
    ['financing', ['tabby', 'تابي', 'tamara', 'تمارا', 'installment', 'قسط', 'تمويل', 'finance repayment', 'loan', 'mortgage', 'عقاري', 'emkan', 'امكان', 'nayifat', 'النايفات', 'tamam', 'تمام', 'spotii', 'postpay', 'mispay']],
    ['housing', ['rent', 'إيجار', 'ايجار', 'ejar', 'real estate', 'عقار', 'sakani', 'سكني', 'owners association', 'اتحاد ملاك', 'rental', 'rent payment', 'إيجار شقة', 'apartment rent', 'villa rent', 'sakan', 'سكن', 'maintenance fee', 'رسوم صيانة', 'service charge', 'compound', 'كمباوند', 'dar al arkan', 'دار الأركان', 'roshn', 'روشن', 'retal', 'ريتال']],
    ['charity', ['zakat', 'زكاة', 'ehsan', 'إحسان', 'charity', 'صدقة', 'donation', 'تبرع', 'jood', 'خيرية', 'خيري', 'kafalah', 'كفالة', 'waqf', 'وقف', 'ehsan.sa', 'sadaqa', 'صدقات', 'zakat al fitr', 'زكاة الفطر', 'adahi', 'أضاحي', 'udhiyah', 'أضحية', 'orphan', 'أيتام', 'mosque', 'مسجد', 'جامع', 'quran association', 'جمعية تحفيظ', 'bunyan', 'بنيان', 'ensan', 'إنسان', 'al birr', 'البر', 'tarahum', 'تراحم', 'sila', 'food bank', 'بنك الطعام', 'eta3m', 'إطعام', 'furijat', 'فرجت']],
    ['transfer', ['transfer', 'تحويل', 'حوالة', 'sarie', 'سريع', 'stc pay', 'stcpay', 'stc bank', 'urpay', 'own account', 'internal transfer', 'credit card payment', 'سداد بطاقة', 'barq', 'برق', 'alinma pay', 'd360', 'wise']],
    ['subscriptions', ['netflix', 'shahid', 'شاهد', 'spotify', 'anghami', 'أنغامي', 'osn', 'starzplay', 'starz play', 'disney', 'youtube premium', 'youtube', 'apple.com/bill', 'apple.com', 'itunes', 'icloud', 'apple music', 'google one', 'google storage', 'google *', 'google play', 'amazon prime', 'primevideo', 'prime video', 'openai', 'chatgpt', 'anthropic', 'claude.ai', 'perplexity', 'midjourney', 'github', 'notion', 'grammarly', 'zoom.us', 'microsoft', 'xbox', 'playstation', 'psn', 'nintendo', 'adobe', 'canva', 'dropbox', 'linkedin', 'duolingo', 'crunchyroll', 'weyyak', 'tod tv', 'stc tv', 'jawwy tv', 'beinsports', 'bein', 'audible', 'kindle unl', 'snapchat', 'nordvpn', 'expressvpn', 'surfshark', 'fitness time', 'fitnesstime', 'وقت اللياقة', "gold's gym", 'golds gym', 'leejam', 'لجام', 'nuvola', 'armah', 'body masters', 'gym', 'نادي رياضي', 'spotify ab', 'netflix.com', 'shahid vip', 'osn+', 'tod', 'yango', 'apple tv', 'hbo', 'paramount', 'discovery+', 'bein connect', 'icloud storage', 'google workspace', 'office 365', 'microsoft 365', 'chatgpt plus', 'claude pro', 'gemini', 'copilot', 'telegram premium', 'x premium', 'twitter blue', 'discord nitro', 'patreon', 'onlyfans', 'medium', 'substack', 'calm', 'headspace', 'strava', 'fitbod', 'myfitnesspal', 'peloton', 'noon one', 'careem plus', 'jahez plus', 'hungerstation pro', 'keeta pro', 'amazon music', 'deezer', 'soundcloud', 'tidal', 'iptv', 'tvplayers']],
    ['bills', ['saudi electricity', 'الكهرباء', 'كهرباء', 'مياه', 'sec bill', 'national water', 'المياه', 'nwc', 'stc', 'mobily', 'موبايلي', 'zain', 'زين', 'virgin mobile', 'lebara', 'salam mobile', 'friendi', 'redbull mobile', 'yaqoot', 'sawa', 'jawwy', 'internet', 'fiber', 'سداد فاتورة', 'bill payment', 'sadad bill', 'فاتورة', 'sec ', 'الشركة السعودية للكهرباء', 'marafiq', 'مرافق', 'water bill', 'electricity', 'telecom', 'اتصالات', 'mobile bill', 'prepaid', 'recharge', 'شحن رصيد', 'sawa card', 'بطاقة سوا', 'salam', 'go telecom', 'gotelecom', 'integrated telecom', 'dawiyat', 'ضوئيات', 'gas cylinder', 'غاز']],
    ['government', ['absher', 'أبشر', 'moi', 'وزارة الداخلية', 'muqeem', 'مقيم', 'traffic', 'مخالفة', 'المرور', 'passport', 'الجوازات', 'jawazat', 'iqama', 'إقامة', 'balady', 'بلدي', 'بلدية', 'amanah', 'أمانة', 'municipality', 'najiz', 'ناجز', 'محكمة', 'zatca', 'gosi', 'qiwa', 'قوى', 'musaned', 'مساند', 'efaa', 'إيفاء', 'enjaz', 'tasheel', 'تسهيل', 'chamber of commerce', 'الغرفة التجارية', 'sadad moi', 'government', 'حكومي', 'ministry', 'وزارة', 'moj', 'وزارة العدل', 'mol', 'hrsd', 'وزارة الموارد', 'mohre', 'tawakkalna', 'سجل تجاري', 'commercial registration', 'mci', 'وزارة التجارة', 'saber', 'سابر', 'ncar', 'sfda', 'الغذاء والدواء', 'spa ', 'الموانئ', 'customs', 'الجمارك', 'zakat tax', 'الزكاة والضريبة', 'fines', 'غرامة', 'غرامات', 'violation', 'دفع المخالفات', 'najm traffic', 'saher', 'ساهر', 'driving license', 'رخصة', 'istimara', 'استمارة', 'civil affairs', 'الأحوال المدنية', 'ahwal']],
    ['cash', ['atm', 'cash withdrawal', 'سحب نقدي', 'سحب']],
    ['bank_fees', ['fee', 'fees', 'رسوم', 'commission', 'عمولة', 'vat on fee', 'annual fee']],
    ['groceries', ['panda', 'بنده', 'danube', 'الدانوب', 'tamimi', 'التميمي', 'othaim', 'العثيم', 'carrefour', 'كارفور', 'lulu', 'لولو', 'nesto', 'bindawood', 'bin dawood', 'بن داود', 'farm superstores', 'المزرعة', 'al raya', 'alraya', 'الراية', 'al sadhan', 'السدحان', 'manuel', 'spar', 'hyper', 'هايبر', 'supermarket', 'super market', 'سوبرماركت', 'سوبر ماركت', 'mini market', 'minimarket', 'market', 'ماركت', 'aswaq', 'aswag', 'أسواق', 'tamweenat', 'tamwinat', 'تموينات', 'baqala', 'baqalah', 'bakala', 'bqala', 'بقالة', 'بقاله', 'foodstuff', 'food stuff', 'مواد غذائية', 'grocery', 'groceries', 'ninja', 'نينجا', 'nana', 'نعناع', 'butcher', 'ملحمة', 'لحوم', 'خضار', 'فواكه', 'vegetable', 'تمور', 'nova water', 'berain', 'بيرين', 'water delivery', 'mark & save', 'mark and save', 'ramez', 'رامز', 'grand hyper', 'hyper al wafa', 'sarawat', 'سراوات', 'zad', 'al nahdi markets', 'carrefour market', 'spinneys', 'waitrose', 'choithrams', 'danube express', 'nesto hyper', 'lulu express', 'ghazal', 'al jazera', 'supermarkets', 'hypermarket', 'هايبر ماركت', 'dukan', 'دكان', 'bnoon', 'إنعام', 'mart', 'مارت', 'fresh', 'طازج', 'almarai', 'المراعي', 'nadec', 'نادك', 'sadafco', 'alwatania', 'الوطنية للدواجن', 'mazraa', 'مزرعة', 'dates', 'تمر', 'samaya', 'رطب', 'bateel', 'monoprix', 'lulu hyper', 'al meera']],
    ['coffee', ['starbucks', 'ستاربكس', 'dunkin', 'tim hortons', 'barns', 'بارنز', 'half million', 'كوفي', 'coffee', 'cafe', 'café', 'كافيه', 'قهوة', 'محمصة', 'roaster', 'roastery', 'dr.cafe', 'dr cafe', 'costa', 'caribou', 'brew92', 'brew 92', 'overdose', 'arabica', 'joffee', 'dose', 'kyan', 'elixir bunn', 'camel step', 'specialty', 'espresso', 'krispy kreme', 'cafe bateel', 'medd', 'kif', 'draft cafe', 'barista', 'باريستا', 'tea', 'شاي', 'chai', 'karak', 'كرك', 'juice', 'عصير', 'عصائر', 'kaffeine', 'khobar coffee', 'mocha', 'موكا', 'latte', 'brew', 'coffe', 'cofe', 'kafe', 'kafeh', 'قهوه', 'الكوفي', 'crumbs', 'pinkberry', 'cheesecake factory']],
    ['dining', ['albaik', 'al baik', 'البيك', 'kudu', 'كودو', 'herfy', 'هرفي', 'mcdonald', 'ماكدونالدز', 'burger king', 'kfc', 'popeyes', 'hardee', 'texas chicken', 'pizza', 'بيتزا', 'papa john', 'little caesar', 'domino', 'subway', 'shake shack', 'five guys', 'maestro', 'shawarma', 'شاورما', 'shawarmer', 'شاورمر', 'mama noura', 'ماما نورة', 'al tazaj', 'الطازج', 'romansiah', 'الرومانسية', 'najd village', 'قرية نجد', 'burgerizzr', 'burger', 'برجر', 'chicken', 'broast', 'بروست', 'grill', 'مشويات', 'steak', 'mandi', 'مندي', 'kabsa', 'كبسة', 'restaurant', 'resturant', 'مطعم', 'مطاعم', 'mataam', 'matam', 'مطبخ', 'kitchen', 'buffet', 'بوفيه', 'بوفية', 'bakery', 'مخبز', 'مخابز', 'sweets', 'حلويات', 'dessert', 'ice cream', 'baskin', 'cinnabon', 'hungerstation', 'hungerst', 'هنقرستيشن', 'jahez', 'جاهز', 'mrsool', 'مرسول', 'toyou', 'to you', 'keeta', 'كيتا', 'the chefz', 'chefz', 'careem food', 'talabat', 'food', 'shawaya house', 'بيت الشواية', 'burger fuel', 'section-b', 'takya', 'nozomi', 'myazu', 'il baretto', 'piatto', 'copper branch', 'lusin', 'fuddruckers', 'applebee', 'chili\'s', 'tgi', 'nando', 'wingstop', 'buffalo wild', 'johnny rockets', 'hardees', 'dajen', 'داجن', 'al shorfa', 'sushi', 'سوشي', 'noodle', 'ramen', 'asian', 'thai', 'indian', 'biryani', 'برياني', 'zaatar', 'زعتر', 'fatayer', 'فطائر', 'mutabbaq', 'مطبق', 'manakish', 'مناقيش', 'falafel', 'فلافل', 'foul', 'فول', 'tamees', 'تميس', 'luqaimat', 'لقيمات', 'kunafa', 'كنافة', 'saadeddin', 'سعد الدين', 'abu zaid', 'kabab', 'كباب', 'مشاوي', 'grills', 'fried', 'وجبات', 'meals', 'eatery', 'diner', 'cafeteria', 'كافتيريا', 'كفتيريا', 'canteen', 'shake', 'smoothie', 'donut', 'دونات', 'waffle', 'وافل', 'crepe', 'كريب', 'pancake', 'tacos', 'taco', 'pasta', 'باستا', 'sandwich', 'ساندويتش', 'fast food', 'ferjan', 'فريج', 'najdiyat', 'نجديات', 'mathbi', 'مثبي', 'mandi house', 'haneeth', 'حنيذ', 'madghoot', 'مضغوط', 'snoonu', 'qlub', 'cheef', 'chef', 'chefs', 'sweet', 'lounge', 'nakhah', 'نكهة']],
    ['fuel', ['aldrees', 'al drees', 'الدريس', 'sasco', 'ساسكو', 'petromin', 'بترومين', 'naft', 'نفط', 'fuel', 'وقود', 'petrol', 'بنزين', 'gasoline', 'gas station', 'محطة', 'mahatta', 'mahattat', 'محطات', 'station', 'stations', 'aramco', 'أرامكو', 'al bassam', 'البسام', 'sahel', 'ساحل', 'gas', 'محروقات', 'tasweeq', 'petrol station', 'fuel station', 'adnoc', 'benzine', 'benzin', 'diesel', 'ديزل']],
    ['car', ['najm', 'نجم', 'car wash', 'carwash', 'غسيل سيارات', 'مغسلة سيارات', 'car service', 'oil change', 'تغيير زيت', 'زيوت', 'tire', 'tyre', 'كفرات', 'إطارات', 'spare parts', 'auto parts', 'قطع غيار', 'workshop', 'ورشة', 'mvpi', 'فحص دوري', 'tameeni', 'تأميني', 'bcare', 'abdul latif jameel', 'jameel motors', 'toyota', 'hyundai', 'nissan', 'lexus', 'kia', 'honda', 'chevrolet', 'gmc', 'mazda', 'tasjeel', 'car care', 'auto care', 'autocare', 'motors', 'motor', 'سيارات', 'الجميح', 'aljomaih', 'abdul latif', 'alj ', 'petromin express', 'tamkeen', 'car insurance', 'تأمين سيارات', 'malath', 'ملاذ', 'al rajhi takaful', 'takaful', 'تكافل', 'tire shop', 'balancing', 'ميزان', 'بنشر', 'puncture', 'cardoc', 'towing', 'سطحة', 'satha', 'car accessories', 'زينة سيارات', 'tint', 'تظليل', 'detailing', 'تلميع', 'polish']],
    ['transport', ['uber', 'careem', 'كريم', 'bolt', 'jeeny', 'جيني', 'saptco', 'سابتكو', 'riyadh metro', 'metro', 'riyadh bus', 'darb', 'parking', 'مواقف', 'mawaqif', 'yelo', 'theeb', 'ذيب', 'budget rent', 'lumi', 'key car', 'hanco', 'rent a car', 'تأجير سيارات', 'salik', 'toll', 'taxi', 'تاكسي', 'kaiian', 'swvl', 'bus', 'باص', 'حافلات', 'metro riyadh', 'careem bike', 'uber eats', 'karwa', 'mowasalat', 'كروة']],
    ['travel', ['saudia', 'السعودية للطيران', 'riyadh air', 'flynas', 'طيران ناس', 'flyadeal', 'طيران أديل', 'flydubai', 'emirates', 'etihad', 'qatar airways', 'gulf air', 'turkish airlines', 'egyptair', 'airline', 'airways', 'booking.com', 'agoda', 'expedia', 'trip.com', 'airbnb', 'almosafer', 'المسافر', 'tajawal', 'wego', 'rehlat', 'flyin', 'gathern', 'جاذر', 'hotel', 'فندق', 'resort', 'منتجع', 'chalet', 'شاليه', 'marriott', 'hilton', 'hyatt', 'radisson', 'novotel', 'ibis', 'movenpick', 'intercontinental', 'holiday inn', 'sar railway', 'haramain', 'قطار', 'nusuk', 'نسك', 'umrah', 'عمرة', 'duty free', 'saudia airlines', 'saudi airlines', 'nas air', 'flynas.com', 'riyadhair', 'air arabia', 'pegasus', 'oman air', 'kuwait airways', 'british airways', 'lufthansa', 'klm', 'air france', 'jazeera airways', 'middle east airlines', 'royal jordanian', 'hotels.com', 'kayak', 'skyscanner', 'cleartrip', 'musafir', 'holidayme', 'seera', 'سيرة', 'al tayyar', 'الطيار', 'travel', 'سفر', 'سياحة', 'tourism', 'tours', 'visa services', 'vfs', 'tasheer', 'تأشيرة', 'embassy', 'سفارة', 'suite', 'سويت', 'شقق فندقية', 'apartments', 'furnished', 'مفروشة', 'inn', 'lodge', 'crowne plaza', 'sheraton', 'westin', 'four seasons', 'ritz', 'fairmont', 'rosewood', 'shangri-la', 'sofitel', 'pullman', 'mercure', 'swissotel', 'rotana', 'روتانا', 'kempinski', 'jumeirah', 'address', 'millennium', 'golden tulip', 'boudl', 'بودل', 'braira', 'بريرا', 'narcissus', 'نارسيس', 'red sea global', 'alula', 'العلا', 'amaala', 'soudah', 'السودة']],
    ['health', ['nahdi', 'النهدي', 'dawaa', 'الدواء', 'whites', 'pharmacy', 'pharmacies', 'pharma', 'صيدلية', 'صيدليات', 'hospital', 'مستشفى', 'clinic', 'clinics', 'عيادة', 'عيادات', 'medical', 'طبي', 'طبية', 'dental', 'أسنان', 'sulaiman al habib', 'hmg', 'الحبيب', 'dallah', 'mouwasat', 'المواساة', 'saudi german', 'مستوصف', 'polyclinic', 'laboratory', 'lab', 'مختبر', 'optic', 'optics', 'نظارات', 'magrabi', 'المغربي', 'tawuniya', 'bupa', 'بوبا', 'medgulf', 'orange pharmacy', 'صيدليات أورانج', 'united pharmacy', 'kunooz', 'كنوز', 'al-nahdi', 'dr.', 'doctor', 'dr ', 'دكتور', 'physio', 'علاج طبيعي', 'dermatology', 'جلدية', 'eye', 'عيون', 'vision', 'optical', 'بصريات', 'hearing', 'dentist', 'orthodont', 'تقويم', 'vaccin', 'تطعيم', 'fakeeh', 'فقيه', 'almana', 'المانع', 'kfsh', 'king faisal specialist', 'national guard hospital', 'care medical', 'رعاية', 'dr sulaiman', 'sghgroup', 'saudi german hospital', 'al hammadi', 'الحمادي', 'dr. sulaiman', 'medical center', 'مجمع طبي', 'مركز طبي', 'labs', 'al borg', 'البرج', 'delta medical', 'دلتا', 'seha', 'صحة', 'tabeeb', 'طبيب', 'vezeeta', 'cura', 'كيورا', 'altibbi', 'الطبي']],
    ['personal_care', ['barber', 'barbershop', 'حلاق', 'حلاقة', 'salon', 'صالون', 'مشغل', 'beauty', 'تجميل', 'laundry', 'مغسلة', 'مصبغة', 'dry clean', 'perfume', 'perfumes', 'عطور', 'oud', 'عود', 'arabian oud', 'العربية للعود', 'qurashi', 'القرشي', 'ajmal', 'rasasi', 'الرصاصي', 'sephora', 'nice one', 'نايس ون', 'golden scent', 'faces', 'وجوه', 'bath & body', 'cosmetic', 'cosmetics', 'spa', 'abdul samad', 'عبدالصمد', 'oud milano', 'swiss arabian', 'lattafa', 'لطافة', 'nabeel', 'al majed oud', 'الماجد للعود', 'dkhoon', 'دخون', 'bakhoor', 'بخور', 'mikyajy', 'مكياجي', 'kayali', 'bath and body', 'body shop', 'the body shop', 'huda beauty', 'boots', 'بوتس', 'nails', 'nail', 'أظافر', 'hair', 'شعر', 'men salon', 'gents', 'massage', 'مساج', 'hammam', 'حمام مغربي', 'wax', 'threading', 'حناء', 'henna', 'tailor', 'خياط', 'خياطة', 'tailoring', 'alteration', 'dry cleaning', 'مكوى', 'كوي', 'ironing', 'washing', 'غسيل ملابس']],
    ['education', ['school', 'schools', 'مدرسة', 'مدارس', 'university', 'جامعة', 'academy', 'أكاديمية', 'institute', 'معهد', 'kindergarten', 'nursery', 'حضانة', 'روضة', 'course', 'udemy', 'coursera', 'tuition', 'training', 'تدريب', 'noon academy', 'نون أكاديمي', 'madrasati', 'classera', 'rawdah', 'قرآن', 'تحفيظ', 'tutor', 'tutoring', 'مدرس خصوصي', 'دروس', 'lessons', 'ielts', 'toefl', 'british council', 'berlitz', 'wall street english', 'language', 'لغة', 'لغات', 'qiyas', 'قياس', 'etec', 'هيئة تقويم', 'كتب', 'kitabi']],
    ['entertainment', ['cinema', 'cinemas', 'vox', 'muvi', 'amc', 'reel cinemas', 'سينما', 'webook', 'tazkarti', 'boulevard', 'بوليفارد', 'riyadh season', 'موسم', 'qiddiya', 'sparkys', 'snow city', 'bowling', 'escape room', 'theme park', 'steam', 'midasbuy', 'razer gold', 'pubg', 'game', 'games', 'six flags', 'al hokair', 'الحكير', 'sparky', 'fun city', 'فن سيتي', 'magic planet', 'kidzania', 'كيدزانيا', 'trampoline', 'ترامبولين', 'karting', 'go kart', 'كارتينج', 'paintball', 'zoo', 'حديقة حيوان', 'museum', 'متحف', 'exhibition', 'معرض', 'concert', 'حفل', 'tickets', 'تذاكر', 'ticketmaster', 'platinumlist', 'events', 'فعاليات', 'festival', 'مهرجان', 'park', 'منتزه', 'playstation store', 'nintendo eshop', 'epic games', 'roblox', 'fortnite', 'free fire', 'pubg mobile', 'jawaker', 'جواكر', 'yalla ludo', 'ludo', 'genshin', 'clash', 'supercell', 'razer']],
    ['home', ['ikea', 'ايكيا', 'home centre', 'homecentre', 'home center', 'saco', 'ساكو', 'ace hardware', 'abyat', 'أبيات', 'pan emirates', 'homes r us', 'al muhaidib', 'المهيدب', 'furniture', 'أثاث', 'مفروشات', 'hardware', 'أدوات منزلية', 'household', 'carpet', 'سجاد', 'mattress', 'مراتب', 'lighting', 'إنارة', 'cleaning', 'تنظيف', 'سباكة', 'home box', 'homebox', 'danube home', 'داينوب هوم', 'al rugaib', 'الرقيب', 'midas furniture', 'ميداس', 'raghba', 'رغبة', 'pottery barn', 'west elm', 'safat home', 'jysk', 'اثاث', 'مطابخ', 'kitchens', 'appliances', 'أجهزة منزلية', 'electrical', 'كهربائيات', 'أدوات كهربائية', 'paint', 'دهانات', 'jotun', 'جوتن', 'national paints', 'tools', 'عدد وأدوات', 'نجارة', 'carpentry', 'ألمنيوم', 'aluminium', 'glass', 'زجاج', 'curtain', 'ستائر', 'plants', 'نباتات', 'nursery plant', 'مشتل', 'garden', 'حديقة', 'pest', 'مكافحة حشرات', 'maid', 'عاملة', 'khadamat', 'خدمات منزلية', 'almnzl', 'al manzil', 'المنزل']],
    ['shopping', ['amazon', 'أمازون', 'noon', 'نون', 'namshi', 'نمشي', 'trendyol', 'ounass', 'styli', 'sivvi', 'jarir', 'جرير', 'extra', 'اكسترا', 'shein', 'شي ان', 'centrepoint', 'centerpoint', 'h&m', 'zara', 'bershka', 'lefties', 'max fashion', 'redtag', 'red tag', 'splash', 'lc waikiki', 'defacto', 'nike', 'adidas', 'sun & sand', 'sun and sand', 'decathlon', 'toys r us', 'hamleys', 'mothercare', 'babyshop', 'aliexpress', 'temu', 'apple store', 'virgin megastore', 'blackbox', 'black box', 'mall', 'مول', 'store', 'متجر', 'boutique', 'fashion', 'أزياء', 'ملابس', 'عبايات', 'abaya', 'extra stores', 'x-cite', 'eros', 'emax', 'sharaf dg', 'iphone', 'samsung', 'huawei', 'xiaomi', 'lenovo', 'dell', 'hp ', 'electronics', 'الكترونيات', 'إلكترونيات', 'mobile shop', 'جوالات', 'جوال', 'accessories', 'اكسسوارات', 'gift', 'هدايا', 'flowers', 'ورود', 'زهور', 'florist', 'toys', 'ألعاب', 'toy', 'kids', 'أطفال', 'baby', 'مواليد', 'shoes', 'أحذية', 'حذاء', 'bags', 'حقائب', 'watch', 'ساعات', 'jewel', 'مجوهرات', 'ذهب', 'gold', 'لازوردي', 'lazurde', 'damas', 'داماس', 'al-fardan', 'optical store', 'bookstore', 'مكتبة', 'library', 'stationery', 'قرطاسية', 'pubs', 'sporting', 'sports', 'رياضة', 'marks & spencer', 'marks and spencer', 'debenhams', 'new look', 'next', 'gap', 'mango', 'massimo dutti', 'pull&bear', 'stradivarius', 'uniqlo', 'american eagle', 'aldo', 'charles & keith', 'skechers', 'puma', 'under armour', 'levi', 'tommy', 'calvin', 'guess', 'lacoste', 'miniso', 'ميniso', 'daiso', 'دايسو', 'ikea', 'al-othaim mall', 'نخيل مول', 'panorama', 'بانوراما', 'red sea mall', 'granada', 'غرناطة', 'riyadh park', 'الرياض بارك', 'kingdom centre', 'al nakheel', 'hayat mall', 'حياة مول', 'u walk', 'via riyadh', 'outlet', 'souq', 'سوق', 'bazaar', 'dukkan', 'online store', 'harrods', 'zid', 'babies', 'flower', 'alward', 'al ward', 'ups', 'dhl', 'aramex', 'smsa', 'ناقل', 'naqel', 'shipping']]
  ];
  var EMPLOYER_RE = /(company|\bco\b|corp|\bltd\b|limited|\best\b|establishment|group|holding|ministry|شركة|مؤسسة|مجموعة|وزارة|هيئة)/i;
  var HINTS = { loan_installment: 'financing', own_transfer: 'transfer', transfer_in: 'transfer', transfer_out: 'transfer', card_payment: 'transfer', fee: 'bank_fees', bill_payment: 'bills' };

  function normalizeText(s) {
    return String(s || '').toLowerCase().normalize('NFKC')
      .replace(/[ً-ٰٟ]/g, '')
      .replace(/[إأآ]/g, 'ا')
      .replace(/\s+/g, ' ').trim();
  }
  var COMPILED = BUILTIN.map(function (g) { return [g[0], g[1].map(normalizeText)]; });
  // Short words must stand alone ("zain" not in "zainab", "نون" not in "قانون"). An Arabic word may
  // carry ال / و / ب / ل in front, and endings like ات.
  var SHORT_RE = {};
  function matches(hay, needle) {
    if (needle.length <= 4 && /^[a-z0-9.]+$/.test(needle)) {
      if (!SHORT_RE[needle]) SHORT_RE[needle] = new RegExp('(^|[^a-z0-9])' + needle.replace(/\./g, '\\.') + '([^a-z0-9]|$)');
      return SHORT_RE[needle].test(hay);
    }
    if (needle.length <= 4 && /^[\u0621-\u064a]+$/.test(needle)) {
      if (!SHORT_RE[needle]) SHORT_RE[needle] = new RegExp('(^|[^\u0621-\u064a])(?:و|ب|ل|ف)?(?:ال|لل)?' + needle);
      return SHORT_RE[needle].test(hay);
    }
    return hay.indexOf(needle) !== -1;
  }
  // Keywords that are also people's names: ignored for transfers to or from a person.
  var NAME_LIKE = ['كريم', 'zain', 'زين', 'نجم', 'najm', 'تمام', 'tamam', 'جيني', 'ذيب', 'theeb', 'jood', 'kia', 'dose', 'برق', 'barq', 'امكان', 'نون', 'noon', 'lulu', 'لولو', 'nana', 'jameel', 'whites', 'amc', 'aramco', 'ارامكو', 'sar', 'total', 'next', 'apple', 'gold', 'ذهب', 'سلام', 'salam', 'رضا', 'rida', 'ولاء', 'walaa', 'ميرا', 'meera', 'الوفاء', 'al wafa', 'anwar', 'كيان', 'ego', 'فريج', 'سلام'].map(normalizeText);

  /** t.amount in halalas. Returns {category, source}. */
  function categorize(t, userRules) {
    var text = normalizeText((t.merchant || '') + ' ' + (t.description || ''));
    var rules = userRules || [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].pattern && text.indexOf(normalizeText(rules[i].pattern)) !== -1) return { category: rules[i].category, source: 'rule' };
    }
    var isCredit = t.amount > 0;
    var hint = normalizeText(t.raw_category);
    if (hint === 'salary' && isCredit) return { category: 'salary', source: 'auto' };
    // Money in from a known shop or airline is a refund in that category (e.g. flyadeal -> Travel).
    if (hint === 'transfer_in' && isCredit && t.merchant) {
      var who = normalizeText(t.merchant);
      for (var k = 0; k < COMPILED.length; k++) {
        if (['transfer', 'salary', 'refund', 'financing', 'housing', 'charity', 'government', 'bank_fees', 'cash'].indexOf(COMPILED[k][0]) !== -1) continue;
        if (COMPILED[k][1].some(function (w) { return NAME_LIKE.indexOf(w) === -1 && matches(who, w); })) return { category: COMPILED[k][0], source: 'auto' };
      }
    }
    if (hint === 'transfer_in' && t.amount >= 150000 && EMPLOYER_RE.test(text)) return { category: 'salary', source: 'auto' };
    if (hint === 'atm_withdrawal' && !isCredit) return { category: 'cash', source: 'auto' };
    if (hint === 'card_payment' || hint === 'own_transfer' || hint === 'wallet_topup') return { category: 'transfer', source: 'auto' };
    var person = hint === 'transfer_out' || hint === 'transfer_in';
    for (var j = 0; j < COMPILED.length; j++) {
      var cat = COMPILED[j][0], words = COMPILED[j][1];
      if (!words.some(function (w) { return !(person && NAME_LIKE.indexOf(w) !== -1) && matches(text, w); })) continue;
      if ((cat === 'salary' || cat === 'refund') && !isCredit) continue;
      return { category: cat, source: 'auto' };
    }
    if (hint === 'refund' && isCredit) return { category: 'refund', source: 'auto' };
    if (HINTS[hint] && (HINTS[hint] === 'transfer' || !isCredit)) return { category: HINTS[hint], source: 'auto' };
    if (hint && CATEGORY_IDS[hint]) return { category: hint, source: 'auto' };
    return { category: isCredit ? 'income' : 'other', source: 'auto' };
  }

  function typeFor(category, amount, subscriptionId) {
    if (category === 'transfer') return 'transfer';
    if (amount > 0) {
      if (category === 'salary') return 'salary';
      if (category === 'income') return 'income';
      return 'refund';
    }
    if (subscriptionId || category === 'subscriptions') return 'subscription';
    return 'spending';
  }

  // ======================================================================
  // Data object
  // ======================================================================
  function emptyData() {
    return {
      version: 1,
      transactions: [],
      subscriptions: [],
      rules: [],
      salary: null,
      next_id: 1,
      meta: { created_at: new Date().toISOString(), last_import_at: null, last_backup_at: null, cat_version: CAT_VERSION },
      wallets: defaultWallets(),
      wallet_unread: []
    };
  }

  /** Check a decrypted object looks like our data (for backups). Throws on garbage. */
  function validateData(d) {
    if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.transactions) || !Array.isArray(d.subscriptions)) {
      throw new Error('This file is not a finance backup.');
    }
    d.rules = Array.isArray(d.rules) ? d.rules : [];
    d.meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
    ensureWallets(d);
    d.transactions.forEach(function (t) {
      if (!t || typeof t !== 'object' || !Number.isSafeInteger(t.amount) || !parseDay(t.date) || !CATEGORY_IDS[t.category]) {
        throw new Error('The backup contains a damaged transaction.');
      }
    });
    var maxId = d.transactions.reduce(function (m, t) { return Math.max(m, t.id || 0); }, 0);
    d.subscriptions.forEach(function (s) { maxId = Math.max(maxId, s.id || 0); });
    d.next_id = Math.max(d.next_id || 1, maxId + 1);
    return d;
  }

  function nextId(data) { return data.next_id++; }

  // Approximate SAR per unit for alerts that only give a foreign amount.
  var SAR_RATES = { USD: 3.75, AED: 1.0211, BHD: 9.9469, QAR: 1.0302, OMR: 9.7493, KWD: 12.2, EUR: 4.05, GBP: 4.75, EGP: 0.077, JOD: 5.29 };

  function str(v, max) { return v === undefined || v === null ? null : String(v).slice(0, max); }

  function sortTx(data) {
    data.transactions.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.datetime || '') < (b.datetime || '') ? -1 : (a.datetime || '') > (b.datetime || '') ? 1 : a.id - b.id;
    });
  }

  /**
   * Add parsed transactions. Each item: parser output plus external_id.
   * Duplicates (same external_id) are skipped. Returns counts.
   */
  function importTransactions(data, list) {
    var result = { inserted: 0, duplicates: 0, skipped: 0, errors: [] };
    var byExt = {};
    data.transactions.forEach(function (t) { if (t.external_id) byExt[t.external_id] = t; });
    var rules = data.rules.slice().sort(function (a, b) { return b.pattern.length - a.pattern.length; });
    var now = new Date().toISOString();
    list.forEach(function (t, i) {
      try {
        var ext = str(t.external_id, 128);
        if (!ext) throw new Error('missing id');
        if (byExt[ext]) { result.duplicates++; return; }
        var date = toDay(t.date);
        if (!date) throw new Error('no date');
        var amount = toHalalas(t.amount);
        var currency = (str(t.currency, 3) || 'SAR').toUpperCase();
        var originalAmount = null, originalCurrency = null;
        if (currency !== 'SAR') {
          var rate = SAR_RATES[currency];
          if (!rate) throw new Error('unsupported currency ' + currency);
          originalAmount = amount; originalCurrency = currency;
          amount = Math.round(amount * rate);
        }
        if (amount === 0) { result.skipped++; return; }
        var description = str(t.description, 500) || '';
        var merchant = str(t.merchant, 120);
        var rawCategory = str(t.raw_category, 64);
        var c = categorize({ description: description, merchant: merchant, raw_category: rawCategory, amount: amount }, rules);
        var tx = {
          id: nextId(data),
          external_id: ext,
          date: date,
          datetime: typeof t.date === 'string' && t.date.length > 10 ? t.date.slice(0, 25) : null,
          amount: amount,
          description: description,
          merchant: merchant,
          raw_category: rawCategory,
          booking_status: 'booked',
          category: c.category,
          category_source: c.source,
          type: typeFor(c.category, amount, null),
          channel: str(t.channel, 16),
          card_last4: t.card_last4 ? String(t.card_last4).replace(/\D/g, '').slice(-4) || null : null,
          balance_after: t.balance_after !== undefined && t.balance_after !== null ? toHalalas(t.balance_after) : null,
          original_amount: originalAmount,
          original_currency: originalCurrency,
          subscription_id: null,
          // null = Al Rajhi; otherwise the wallet or card it belongs to (stcpay, d360, urpay, barq, anb).
          account: t.account && WALLET_IDS[t.account] ? t.account : null,
          available_after: t.available_after !== undefined && t.available_after !== null ? toHalalas(t.available_after) : null,
          // Long numbers (bill, reference, IBAN) are masked in the saved copy of the text.
          raw: typeof t.raw === 'string' ? t.raw.slice(0, 2000).replace(/\d{8,}/g, function (n) { return '…' + n.slice(-3); }) : null,
          created_at: now
        };
        data.transactions.push(tx);
        byExt[ext] = tx;
        result.inserted++;
      } catch (e) {
        result.skipped++;
        if (result.errors.length < 20) result.errors.push({ index: i, error: e.message });
      }
    });
    if (result.inserted) {
      sortTx(data);
      data.meta.last_import_at = now;
      detect(data);
    }
    return result;
  }

  /** Change a transaction's category. remember=true adds a rule for that merchant. */
  function recategorize(data, id, category, remember) {
    if (!CATEGORY_IDS[category]) throw new Error('unknown category');
    var t = data.transactions.find(function (x) { return x.id === id; });
    if (!t) throw new Error('not found');
    t.category = category;
    t.category_source = 'manual';
    t.type = typeFor(category, t.amount, t.subscription_id);
    if (remember) {
      var pattern = String(t.merchant || t.description || '').trim().slice(0, 100);
      if (pattern.length >= 3) {
        var existing = data.rules.find(function (r) { return r.pattern === pattern; });
        if (existing) existing.category = category; else data.rules.push({ pattern: pattern, category: category });
        recategorizeAll(data);
        return t;
      }
    }
    detect(data);
    return t;
  }

  function recategorizeAll(data) {
    var rules = data.rules.slice().sort(function (a, b) { return b.pattern.length - a.pattern.length; });
    data.transactions.forEach(function (t) {
      if (t.category_source === 'manual') return;
      var c = categorize(t, rules);
      t.category = c.category; t.category_source = c.source; t.type = typeFor(c.category, t.amount, null);
    });
    detect(data);
  }

  /** Shops the app couldn't place (spending in Other, not chosen by the user), most frequent first. */
  function unknownShops(data) {
    var by = {};
    data.transactions.forEach(function (t) {
      if (t.category !== 'other' || t.category_source !== 'auto' || t.amount >= 0) return;
      var name = String(t.merchant || '').trim();
      if (name.length < 3) return;
      var s = by[name] || (by[name] = { merchant: name, count: 0, total: 0, last_date: '', tx_id: t.id });
      s.count++; s.total -= t.amount;
      if (t.date >= s.last_date) { s.last_date = t.date; s.tx_id = t.id; }
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.count - a.count || b.total - a.total; });
  }

  // Bump when the built-in keywords change, so saved transactions are sorted again with the new list.
  var CAT_VERSION = 5;
  /** Re-sort auto-categorized transactions once after an update. Manual choices and rules are kept. Returns true if it ran. */
  function upgradeCategories(data) {
    if ((data.meta && data.meta.cat_version) === CAT_VERSION) return false;
    recategorizeAll(data);
    data.meta = data.meta || {};
    data.meta.cat_version = CAT_VERSION;
    return true;
  }

  function deleteTransaction(data, id) {
    var i = data.transactions.findIndex(function (x) { return x.id === id; });
    if (i === -1) throw new Error('not found');
    var gone = data.transactions.splice(i, 1)[0];
    if (gone && gone.link) unlink(data, gone.id);
    detect(data);
  }

  // ======================================================================
  // Subscriptions & salary detection (same rules as backend/src/subscriptions.js)
  // ======================================================================
  var SUBSCRIPTION_KINDS = { subscriptions: 1, bills: 1, entertainment: 1, education: 1 };
  var NOT_RECURRING = { groceries: 1, dining: 1, coffee: 1, transport: 1, fuel: 1, home: 1, personal_care: 1, cash: 1, transfer: 1, shopping: 1, refund: 1, travel: 1, health: 1 };
  var NOISE = ['pos purchase', 'online purchase', 'purchase', 'pos', 'e-commerce', 'ecommerce', 'apple pay', 'mada pay',
    'mada', 'visa', 'mastercard', 'debit card', 'credit card', 'card', 'payment', 'sadad', 'شراء عبر الانترنت',
    'شراء عبر نقاط البيع', 'شراء انترنت', 'شراء', 'نقاط البيع', 'مدى', 'دفع', 'سداد'].map(normalizeText);

  function merchantKey(t) {
    var s = normalizeText(t.merchant || t.description);
    NOISE.forEach(function (n) { s = s.split(n).join(' '); });
    s = s.replace(/\b[a-z]*\d[\w*]*\b/g, ' ')
      .replace(/[\d٠-٩]+/g, ' ')
      .replace(/[^\p{L}\s]/gu, ' ')
      .replace(/\b(sa|ksa|riyadh|jeddah|dammam|khobar|com|www|inc|ltd|co)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return s.split(' ').slice(0, 3).join(' ');
  }
  function median(nums) {
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function cycleFor(days) {
    if (days >= 5 && days <= 9) return 'weekly';
    if (days >= 25 && days <= 35) return 'monthly';
    if (days >= 85 && days <= 95) return 'quarterly';
    if (days >= 350 && days <= 380) return 'yearly';
    return null;
  }
  function nextAfter(day, cycle) {
    if (cycle === 'weekly') return addDays(day, 7);
    if (cycle === 'quarterly') return addMonths(day, 3);
    if (cycle === 'yearly') return addMonths(day, 12);
    return addMonths(day, 1);
  }
  var CYCLE_DAYS = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };
  function monthlyEquivalent(amount, cycle) {
    if (cycle === 'weekly') return Math.round(amount * 52 / 12);
    if (cycle === 'quarterly') return Math.round(amount / 3);
    if (cycle === 'yearly') return Math.round(amount / 12);
    return amount;
  }
  function prettyName(t) {
    var raw = (t.merchant || '').trim();
    var fromKey = !raw;
    if (fromKey) raw = merchantKey(t);
    raw = raw.split(/\s+/).filter(function (w) { return !/\d/.test(w); }).join(' ') || raw;
    if (fromKey || raw === raw.toUpperCase()) raw = raw.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); });
    return raw.slice(0, 60);
  }
  function analyzeGroup(charges) {
    var amounts = charges.map(function (c) { return Math.abs(c.amount); });
    var med = median(amounts);
    function near(list, m) { return list.filter(function (a) { return Math.abs(a - m) <= Math.max(m * 0.15, 100); }).length; }
    var recent = amounts.slice(-3);
    var steadyAll = near(amounts, med) / amounts.length >= 0.75;
    var steadyRecent = recent.length >= 2 && near(recent, median(recent)) === recent.length;
    if (!steadyAll && !steadyRecent) return null;
    if (charges.length < 2) return null;
    var gaps = [];
    for (var i = 1; i < charges.length; i++) gaps.push(daysBetween(charges[i - 1].date, charges[i].date));
    var cycle = cycleFor(median(gaps));
    if (!cycle) return null;
    return { cycle: cycle, amount: amounts[amounts.length - 1] };
  }

  function detect(data, opts) {
    var asOf = (opts && opts.asOf) || today();
    var txs = data.transactions;
    linkTransfers(data);

    // Refunds from a shop we couldn't place: use the category of what was bought there.
    txs.forEach(function (r) {
      if (!(r.category === 'refund' && r.category_source === 'auto' && r.amount > 0)) return;
      var key = r.merchant || r.description;
      var prev = null;
      txs.forEach(function (p) {
        if (p.amount < 0 && p.category !== 'transfer' && p.category !== 'cash' && (p.merchant === key || p.description === key)) {
          if (!prev || p.date >= prev.date) prev = p;
        }
      });
      if (prev) r.category = prev.category;
    });

    var rows = txs.filter(function (t) { return t.booking_status !== 'pending'; }).slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; });
    var debitGroups = new Map(), creditGroups = new Map();
    rows.forEach(function (r) {
      var key = merchantKey(r);
      if (!key) return;
      var groups = r.amount < 0 ? debitGroups : creditGroups;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    var found = new Map();
    debitGroups.forEach(function (charges, key) {
      var known = charges.some(function (c) { return c.category === 'subscriptions'; });
      if (!known && charges.every(function (c) { return NOT_RECURRING[c.category]; })) return;
      var info = analyzeGroup(charges);
      var status = 'active';
      var last = charges[charges.length - 1];
      if (!info) {
        if (!known) return;
        info = { cycle: 'monthly', amount: Math.abs(last.amount) };
        status = 'suspected';
      } else if (charges.length < 3 && !known) {
        status = 'suspected';
      }
      var overdue = daysBetween(last.date, asOf) - CYCLE_DAYS[info.cycle];
      if (overdue > Math.max(10, CYCLE_DAYS[info.cycle] / 2)) status = 'cancelled';
      var category = known ? 'subscriptions' : last.category;
      found.set(key, {
        name: prettyName(last), kind: SUBSCRIPTION_KINDS[category] ? 'subscription' : 'recurring',
        amount: info.amount, cycle: info.cycle, category: category, last_charged: last.date,
        next_renewal: nextAfter(last.date, info.cycle), status: status, occurrences: charges.length,
        txIds: charges.map(function (c) { return c.id; })
      });
    });

    // Upsert subscriptions (keep id, name and any manual status).
    var byKey = new Map();
    data.subscriptions.forEach(function (s) { byKey.set(s.merchant_key, s); });
    found.forEach(function (f, key) {
      var s = byKey.get(key);
      if (!s) {
        s = { id: nextId(data), merchant_key: key, name: f.name, status_source: 'auto' };
        data.subscriptions.push(s);
        byKey.set(key, s);
      }
      s.amount = f.amount; s.kind = f.kind; s.cycle = f.cycle; s.category = f.category;
      s.last_charged = f.last_charged; s.next_renewal = f.next_renewal; s.occurrences = f.occurrences;
      if (s.status_source !== 'manual') s.status = f.status;
    });

    // Reset links, then re-link.
    var byId = new Map();
    txs.forEach(function (t) {
      if (t.type === 'subscription' && t.category !== 'subscriptions') t.type = 'spending';
      t.subscription_id = null;
      byId.set(t.id, t);
    });
    found.forEach(function (f, key) {
      var s = byKey.get(key);
      if (s.status === 'ignored') return;
      f.txIds.forEach(function (id) {
        var t = byId.get(id);
        t.subscription_id = s.id;
        if (!(s.status === 'suspected' || f.kind !== 'subscription') && t.type === 'spending') t.type = 'subscription';
      });
    });

    // Drop auto-detected ones that no longer match anything.
    var before = data.subscriptions.length;
    data.subscriptions = data.subscriptions.filter(function (s) { return s.status_source === 'manual' || found.has(s.merchant_key); });

    // Salary: a steady monthly credit of at least 1,500 SAR not already classified.
    var salaryUpdates = 0;
    // When the bank itself marks payroll, regular transfers from people are not a salary.
    var hasPayroll = txs.some(function (t) { return t.raw_category === 'salary' && t.amount > 0; });
    creditGroups.forEach(function (credits) {
      if (hasPayroll) return;
      var auto = credits.filter(function (c) {
        return c.category_source === 'auto' && (c.category === 'income' || (c.category === 'transfer' && c.raw_category === 'transfer_in'));
      });
      if (auto.length < 2 || credits.some(function (c) { return c.category === 'transfer' && c.category_source !== 'auto'; })) return;
      var info = analyzeGroup(credits);
      if (!info || info.cycle !== 'monthly' || info.amount < 150000) return;
      auto.forEach(function (c) { c.category = 'salary'; c.type = 'salary'; salaryUpdates++; });
    });

    return { subscriptions: found.size, removed: before - data.subscriptions.length, salaryUpdates: salaryUpdates };
  }

  function setSubscriptionStatus(data, id, status) {
    if (['active', 'cancelled', 'ignored'].indexOf(status) === -1) throw new Error('bad status');
    var s = data.subscriptions.find(function (x) { return x.id === id; });
    if (!s) throw new Error('not found');
    s.status = status; s.status_source = 'manual';
    detect(data);
    return s;
  }

  // ======================================================================
  // Summaries (same maths as backend/src/summary.js). Outputs SAR numbers.
  // ======================================================================
  // ----- Months: calendar months, or pay months (from one payday to the day before the next) -----
  // A salary on the 15th or later starts the next month: paid 28 Nov -> "December" runs 28 Nov to the day before the December payday.
  function monthMode(data) { return (data && data.meta && data.meta.month_mode) || 'payday'; }
  function payStarts(data) {
    if (!data || monthMode(data) !== 'payday') return null;
    var starts = {}, days = [];
    data.transactions.forEach(function (t) {
      if (t.category !== 'salary' || t.amount <= 0 || !booked(t)) return;
      var dom = Number(t.date.slice(8, 10));
      var key = dom >= 15 ? shiftMonth(monthOf(t.date), 1) : monthOf(t.date);
      if (!starts[key] || t.date < starts[key]) starts[key] = t.date;
      if (dom >= 15) days.push(dom);
    });
    if (!Object.keys(starts).length) return null;
    days.sort(function (a, b) { return a - b; });
    var fallback = days.length ? days[Math.floor(days.length / 2)] : 27;
    return { starts: starts, fallback: fallback };
  }
  function periodStart(ps, key) {
    if (!ps) return key + '-01';
    if (ps.starts[key]) return ps.starts[key];
    var prev = shiftMonth(key, -1), last = Number(addDays(key + '-01', -1).slice(8, 10));
    var d = Math.min(ps.fallback, last);
    return prev + '-' + (d < 10 ? '0' : '') + d;
  }
  /** Returns day -> month key ("2026-12"), following the user's month setting. */
  function periodFn(data) {
    var ps = payStarts(data), memo = {};
    return function (day) {
      day = String(day).slice(0, 10);
      if (memo[day]) return memo[day];
      var key = day.slice(0, 7);
      if (ps) {
        var next = shiftMonth(key, 1);
        if (day >= periodStart(ps, next)) key = next;
        else if (day < periodStart(ps, key)) key = shiftMonth(key, -1);
      }
      memo[day] = key;
      return key;
    };
  }
  function periodOf(data, day) { return periodFn(data)(day); }
  /** {start, end, payday} for a month key. */
  function periodRange(data, key) {
    var ps = payStarts(data);
    if (!ps) return { start: key + '-01', end: addDays(addMonths(key + '-01', 1), -1), payday: false };
    return { start: periodStart(ps, key), end: addDays(periodStart(ps, shiftMonth(key, 1)), -1), payday: true };
  }
  function booked(t) { return t.booking_status !== 'pending'; }

  function monthSummary(data, month) {
    var income = 0, spending = 0, refunds = 0, salary = 0, subs = 0, count = 0, tin = 0, tout = 0;
    var per = periodFn(data);
    data.transactions.forEach(function (t) {
      if (!booked(t) || per(t.date) !== month) return;
      if (t.category === 'transfer') { if (t.amount > 0) tin += t.amount; else tout -= t.amount; return; }
      count++;
      if (t.type === 'salary' || t.type === 'income') income += t.amount;
      if (t.type === 'spending' || t.type === 'subscription' || t.type === 'refund') spending -= t.amount;
      if (t.type === 'refund') refunds += t.amount;
      if (t.type === 'salary') salary += t.amount;
      if (t.type === 'subscription' || (t.category === 'subscriptions' && (t.type === 'spending' || t.type === 'refund'))) subs -= t.amount;
    });
    return {
      month: month, income: toSar(income), spending: toSar(spending), net: toSar(income - spending),
      salary: toSar(salary), subscriptions: toSar(subs), refunds: toSar(refunds),
      transfers_in: toSar(tin), transfers_out: toSar(tout), transaction_count: count
    };
  }

  function monthlyTrend(data, endMonth, months) {
    var out = [];
    for (var i = months - 1; i >= 0; i--) {
      var m = shiftMonth(endMonth, -i);
      var s = monthSummary(data, m);
      out.push({ month: m, income: s.income, spending: s.spending, net: s.net, salary: s.salary });
    }
    return out;
  }

  function categoryBreakdown(data, month) {
    var sums = {}, counts = {};
    var per = periodFn(data);
    data.transactions.forEach(function (t) {
      if (!booked(t) || per(t.date) !== month || t.category === 'transfer') return;
      if (['spending', 'subscription', 'refund'].indexOf(t.type) === -1) return;
      sums[t.category] = (sums[t.category] || 0) - t.amount;
      counts[t.category] = (counts[t.category] || 0) + (t.amount < 0 ? 1 : 0);
    });
    return Object.keys(sums).filter(function (k) { return sums[k] !== 0; })
      .map(function (k) { return { category: k, amount: toSar(sums[k]), count: counts[k] }; })
      .sort(function (a, b) { return b.amount - a.amount; });
  }

  function subscriptionsOut(data) {
    return data.subscriptions.filter(function (s) { return s.status === 'active' || s.status === 'suspected'; })
      .map(function (s) {
        return {
          id: s.id, name: s.name, amount: toSar(s.amount), cycle: s.cycle, category: s.category, kind: s.kind,
          last_charged: s.last_charged, next_renewal: s.next_renewal, status: s.status, occurrences: s.occurrences,
          monthly_equivalent: toSar(monthlyEquivalent(s.amount, s.cycle))
        };
      })
      .sort(function (a, b) { return a.next_renewal < b.next_renewal ? -1 : 1; });
  }

  function transactionsOut(data, month) {
    var per = periodFn(data);
    return data.transactions.filter(function (t) { return per(t.date) === month; }).map(function (t) {
      return {
        id: t.id, date: t.date, datetime: t.datetime, amount: toSar(t.amount), description: t.description, merchant: t.merchant,
        category: t.category, type: t.type, card_last4: t.card_last4, account: t.account || null, link: !!t.link,
        original_amount: toSar(t.original_amount), original_currency: t.original_currency
      };
    });
  }

  function monthsWithData(data) {
    var seen = {}, per = periodFn(data);
    data.transactions.forEach(function (t) { seen[per(t.date)] = true; });
    return Object.keys(seen).sort();
  }

  // ======================================================================
  // Salary breakdown (same as backend/src/salary.js)
  // ======================================================================
  var MAX_ITEMS = 30, MAX_PAY = 10000000;
  function setSalaryProfile(data, items) {
    if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new Error('At most ' + MAX_ITEMS + ' lines.');
    data.salary = {
      items: items.map(function (it, i) {
        var label = String((it && it.label) || '').trim().slice(0, 60);
        if (!label) throw new Error('Every line needs a name.');
        if (['earning', 'deduction'].indexOf(it.type) === -1) throw new Error('Bad line type.');
        var amount = toHalalas(it.amount);
        if (amount < 0 || amount > MAX_PAY * 100) throw new Error('Amounts must be between 0 and ' + MAX_PAY + '.');
        return { id: i + 1, label: label, type: it.type, amount: amount };
      }),
      updated_at: new Date().toISOString()
    };
    return salaryView(data);
  }

  function salaryView(data, months) {
    months = months || 6;
    var per = periodFn(data);
    var end = per(today());
    var detected = [];
    for (var i = months - 1; i >= 0; i--) {
      var month = shiftMonth(end, -i), total = 0, n = 0;
      data.transactions.forEach(function (t) {
        if (t.category === 'salary' && t.amount > 0 && booked(t) && per(t.date) === month) { total += t.amount; n++; }
      });
      if (n) detected.push({ month: month, amount: toSar(total) });
    }
    if (!data.salary) return { profile: null, expected_net: null, gross: null, total_deductions: null, detected: detected, latest_difference: null };
    var items = data.salary.items;
    var gross = 0, ded = 0;
    items.forEach(function (it) { if (it.type === 'earning') gross += it.amount; else ded += it.amount; });
    var expected = gross - ded;
    var latest = detected[detected.length - 1];
    return {
      profile: { items: items.map(function (it) { return { id: it.id, label: it.label, type: it.type, amount: toSar(it.amount) }; }), updated_at: data.salary.updated_at },
      gross: toSar(gross), total_deductions: toSar(ded), expected_net: toSar(expected), detected: detected,
      latest_difference: latest ? toSar(toHalalas(latest.amount) - expected) : null
    };
  }

  // ======================================================================
  // SMS -> transactions (async because of SHA-256)
  // ======================================================================
  function getSubtle() {
    var c = (typeof crypto !== 'undefined' && crypto) || (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (!c || !c.subtle) throw new Error('This browser has no Web Crypto (needs HTTPS).');
    return c.subtle;
  }
  function sha256Hex(text) {
    return getSubtle().digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }
  // The same alert pasted twice gets the same id, so re-imports never duplicate.
  // Al Rajhi alerts include the date, time and balance, so two real purchases differ.
  function smsId(text) {
    return sha256Hex(normDigits(text).replace(/\s+/g, ' ').trim()).then(function (h) { return 'sms:' + h.slice(0, 24); });
  }

  /** Parse pasted / queued texts. Returns {parsed:[...], ignored:n}. */
  function parseTexts(input) {
    var msgs = splitMessages(input);
    var ignored = 0;
    var unread = [];
    return Promise.all(msgs.map(function (m) {
      var t = m.wallet ? parseWalletSms(m.text, m.wallet, { receivedAt: m.receivedAt }) : parseAlRajhiSms(m.text, { receivedAt: m.receivedAt });
      if (!t) {
        ignored++;
        if (m.wallet && WALLET_IDS[m.wallet] && !IGNORE.test(m.text)) unread.push({ wallet: m.wallet, text: m.text, at: m.receivedAt });
        return null;
      }
      return smsId(m.key || m.text).then(function (id) { t.external_id = id; return t; });
    })).then(function (list) {
      return { parsed: list.filter(Boolean), ignored: ignored, total: msgs.length, unread: unread, wallet_texts: msgs.some(function (m) { return m.wallet; }) };
    });
  }


  // ======================================================================
  // Al Rajhi account statement (PDF). The app reads the PDF's text on the phone
  // (js/statement.js); these functions turn its positioned text into transactions.
  // ======================================================================
  var STMT_DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
  var STMT_AMOUNT = /^([\d,]+\.\d{2})\s*SAR$/;

  /** items: [{page, x, y, str}] (y grows upwards, as in PDF). Returns rows {date, type, notes, debit, credit, balance}. */
  function statementRows(items) {
    var pages = {};
    items.forEach(function (it) {
      var s = String(it.str || '').trim();
      if (!s) return;
      (pages[it.page] || (pages[it.page] = [])).push({ x: Number(it.x), y: Number(it.y), s: s });
    });
    var rows = [];
    Object.keys(pages).sort(function (a, b) { return a - b; }).forEach(function (pg) {
      var list = pages[pg];
      var anchors = list.filter(function (it) { return it.x < 100 && STMT_DATE.test(it.s); })
        .sort(function (a, b) { return b.y - a.y; });
      if (!anchors.length) return;
      var pageRows = anchors.map(function (a) { return { anchor: a, details: [], amounts: [] }; });
      list.forEach(function (it) {
        if (anchors.indexOf(it) !== -1) return;
        // Belongs to the date row closest in height (rows are about 26pt apart; details sit within ±12pt).
        var best = null, dist = Infinity;
        pageRows.forEach(function (r) { var d = Math.abs(r.anchor.y - it.y); if (d < dist) { dist = d; best = r; } });
        if (!best || dist > 16) return;
        if (STMT_AMOUNT.test(it.s) && Math.abs(best.anchor.y - it.y) <= 3 && it.x > 250) best.amounts.push(it);
        else if (it.x >= 90 && it.x < 300) best.details.push(it);
      });
      pageRows.forEach(function (r) {
        if (r.amounts.length < 3) return;
        r.amounts.sort(function (a, b) { return a.x - b.x; });
        r.details.sort(function (a, b) { return b.y - a.y || a.x - b.x; });
        var m = r.anchor.s.match(STMT_DATE);
        var num = function (it) { return Number(it.s.match(STMT_AMOUNT)[1].replace(/,/g, '')); };
        rows.push({
          date: m[1] + '-' + m[2] + '-' + m[3],
          type: r.details.length ? r.details[0].s : '',
          notes: r.details.slice(1).map(function (d) { return d.s; }).join(' ').replace(/\s+/g, ' ').trim(),
          debit: num(r.amounts[0]), credit: num(r.amounts[1]), balance: num(r.amounts[2])
        });
      });
    });
    return rows;
  }

  var STMT_TYPES = [
    [/between accounts/i, 'own_transfer'],
    [/transaction charges|markup|fee|charge/i, 'fee'],
    [/installment|loan/i, 'loan_installment'],
    [/credit cards? transactions|card payment/i, 'card_payment'],
    [/refund|reversal/i, 'refund'],
    [/sadad|bill/i, 'bill_payment'],
    [/atm|cash withdrawal/i, 'atm_withdrawal'],
    [/online purchase|card on file/i, 'online_purchase'],
    [/pos purchase|purchase/i, 'pos_purchase'],
    [/inward|incoming/i, 'transfer_in'],
    [/outward|transfer/i, 'transfer_out']
  ];

  var CITY_END = /(,\s*|\s+)(riyadh|al riyadh|jeddah|makkah|mecca|madina|medina|dammam|khobar|al khobar|dhahran|abha|taif|tabuk|qassim|buraydah|hail|jazan|najran|doha|dubai|abu dhabi|manama|kuwait|cairo|amsterdam|london|paris|istanbul)$/i;
  function cleanPlace(s) {
    var out = String(s || '').replace(/,?\s*[A-Za-z .'-]{2,25},\s*SA$/i, '').replace(/\s+(SA|QA|NL|US|GB|AE|BH|KW|EG|TR|FR|DE)$/, '').replace(/[\s,]+$/, '').trim();
    for (var i = 0; i < 2; i++) out = out.replace(CITY_END, '').replace(/[\s,]+$/, '').trim();
    return out;
  }

  /** One statement row → the same shape the SMS parser makes. */
  function statementTransaction(row) {
    var amount = row.credit > 0 ? row.credit : -row.debit;
    if (!amount) return null;
    var typeText = row.type || '';
    var raw = 'other';
    for (var i = 0; i < STMT_TYPES.length; i++) if (STMT_TYPES[i][0].test(typeText)) { raw = STMT_TYPES[i][1]; break; }
    if (raw === 'transfer_out' && amount > 0) raw = 'transfer_in';
    if (/\bLOAN\b|\bINST\./i.test(row.notes) && amount < 0) raw = 'loan_installment';
    var timeM = row.notes.match(/Time:\s*(\d{2}:\d{2}:\d{2})/);
    var notes = row.notes.replace(/^.*?Notes:\s*/, '').replace(/W-\s+\//, 'W-/').trim();
    var who = null, note = null, card = null;
    var cm = notes.match(/\d{6}\*+(\d{4})/);
    if (cm) card = cm[1];
    if (/PAYROLL/i.test(notes)) {
      raw = 'salary';
      var parts = notes.split('-').map(function (s) { return s.trim(); }).filter(Boolean);
      who = parts.filter(function (s) { return EMPLOYER_RE.test(s); })[0] || null;
    } else if (/^Payment-/i.test(notes)) {
      var pp = notes.split('-').map(function (s) { return s.trim(); }).filter(Boolean);
      who = pp.filter(function (s) { return EMPLOYER_RE.test(s); })[0] || pp.filter(function (s) { return /^[A-Za-z .&]{4,}$/.test(s); })[0] || null;
    } else if (/^W-\/(FR|TO)ACCT\//.test(notes)) {
      var tm = notes.match(/^W-\/(?:FR|TO)ACCT\/\d+(?:FR|TO)([^-]*)-?(.*)$/);
      if (tm) { who = tm[1].trim() || null; note = tm[2].trim() || null; }
    } else if (raw === 'pos_purchase' || raw === 'online_purchase' || raw === 'refund' || /markup/i.test(typeText)) {
      var mm = notes.replace(/^\([^)]*\)\s*/, '').replace(/^\d{6}\*+\d{4}\s*:\s*/, '').replace(/^(Agmt\s+)?[0-9a-f]{20,}\s*,\s*/i, '')
        .replace(/^Online Purchase from\s*/i, '');
      who = cleanPlace(mm.replace(/,\s*\d{6,}$/, '')) || null;
    } else if (/\//.test(notes) && (raw === 'transfer_in' || raw === 'transfer_out' || raw === 'fee')) {
      // Drop reference numbers (e.g. 20260806SANCBK…1276/ or 9128072600446011/), keep the name.
      who = notes.replace(/[A-Z0-9]*\d{6,}[A-Z0-9]*\s*\/?/g, ' ').replace(/\//g, ' ').replace(/\s+/g, ' ').trim() || null;
    }
    if (raw === 'fee' && /charges/i.test(typeText)) who = null;
    // The type text ("POS purchase Apple pay (Domestic)") stays in raw, not in the description, so it can't sway categories.
    var description = [who, note].filter(Boolean).join(' | ') || typeText;
    return {
      date: row.date + (timeM ? 'T' + timeM[1] + '+03:00' : ''),
      amount: amount,
      currency: 'SAR',
      description: description,
      merchant: who ? who.slice(0, 120) : (raw === 'fee' ? 'Bank charges' : raw === 'bill_payment' ? 'SADAD bill' : null),
      raw_category: raw,
      channel: 'statement',
      card_last4: card,
      balance_after: row.balance,
      raw: typeText + '\n' + row.date + ' ' + notes,
      external_id: 'stmt:' + row.date + 'T' + (timeM ? timeM[1] : '') + ':' + Math.round(amount * 100) + ':' + Math.round(row.balance * 100)
    };
  }

  /** Add statement rows, skipping ones already captured from texts (same amount within a day). */
  function importStatement(data, rows) {
    var list = rows.map(statementTransaction).filter(Boolean);
    var taken = {};
    var others = data.transactions.filter(function (t) { return !/^stmt:/.test(t.external_id || ''); });
    var fresh = [], matched = 0;
    var byExt = {};
    data.transactions.forEach(function (t) { if (t.external_id) byExt[t.external_id] = true; });
    list.forEach(function (s) {
      if (byExt[s.external_id]) { fresh.push(s); return; } // counted as duplicate below
      var day = s.date.slice(0, 10), amt = toHalalas(s.amount);
      var hit = others.find(function (t) {
        if (taken[t.id] || Math.abs(daysBetween(t.date, day)) > 1 || (t.amount > 0) !== (amt > 0)) return false;
        if (t.amount === amt) return true;
        // Foreign purchases: the text's converted amount is approximate.
        return !!t.original_currency && Math.abs(t.amount - amt) <= Math.abs(amt) * 0.06;
      });
      if (hit) { taken[hit.id] = true; matched++; return; }
      fresh.push(s);
    });
    var r = importTransactions(data, fresh);
    r.matched = matched;
    r.rows = rows.length;
    if (list.length) {
      var days = list.map(function (s) { return s.date.slice(0, 10); }).sort();
      r.from = days[0]; r.to = days[days.length - 1];
    }
    return r;
  }

  function importTexts(data, input) {
    return parseTexts(input).then(function (p) {
      var r = importTransactions(data, p.parsed);
      r.ignored = p.ignored;
      r.messages = p.total;
      r.wallet_texts = p.wallet_texts;
      r.unread = keepUnread(data, p.unread);
      return r;
    });
  }

  // ======================================================================
  // Wallets and credit card (STC Pay, D360, urpay, barq, ANB credit card).
  // Their texts come from a separate iPhone automation tagged ##WALLET:<TAG>##.
  // Balances: the starting amount you type in, then each text after it. A text
  // that states the balance resets it; otherwise the amount is added or taken off.
  // ======================================================================
  var WALLET_LIST = [
    { id: 'stcpay', name: 'STC Pay', kind: 'wallet', tag: 'STCPAY' },
    { id: 'd360', name: 'D360 Bank', kind: 'wallet', tag: 'D360' },
    { id: 'urpay', name: 'urpay', kind: 'wallet', tag: 'URPAY' },
    { id: 'barq', name: 'barq', kind: 'wallet', tag: 'BARQ' },
    { id: 'anb', name: 'ANB credit card', kind: 'card', tag: 'ANB' }
  ];
  var WALLET_IDS = {};
  WALLET_LIST.forEach(function (w) { WALLET_IDS[w.id] = w; });
  function defaultWallets() { return WALLET_LIST.map(function (w) { return { id: w.id, start: null, limit: null }; }); }
  function ensureWallets(d) {
    var have = Array.isArray(d.wallets) ? d.wallets.filter(function (w) { return w && WALLET_IDS[w.id]; }) : [];
    d.wallets = WALLET_LIST.map(function (def) {
      var w = have.find(function (x) { return x.id === def.id; }) || { id: def.id, start: null, limit: null };
      if (w.start && !(Number.isSafeInteger(w.start.amount) && !isNaN(Date.parse(w.start.at)))) w.start = null;
      if (!Number.isSafeInteger(w.limit) || w.limit <= 0) w.limit = null;
      return w;
    });
    if (!Array.isArray(d.wallet_unread)) d.wallet_unread = [];
    return d;
  }

  // Which way the money went. The earliest match in the text wins; on a tie, the first rule.
  var W_RULES = [
    { re: /استرداد|استرجاع|refund|reversal|cash\s?back|كاش\s?باك/i, type: 'refund', channel: 'other', sign: +1 },
    { re: /شحن\s*(?:ال)?محفظ|(?:إضافة|اضافة)\s*(?:ال)?(?:أموال|اموال|رصيد)|add(?:ed)? money|تعبئة\s*(?:ال)?محفظ|top.?up|wallet (?:was )?(?:topped|funded|loaded)/i, type: 'wallet_topup', channel: 'transfer', sign: +1 },
    { re: /(?:حوالة|تحويل)\s*(?:مالية\s*)?(?:واردة|وارد)|استلمت|استلام|تم\s*استلام|وصلتك|وصلك|payment received|received|credited|أضيف|اضيف|إضافة|اضافة|إيداع|ايداع|deposit|incoming/i, type: 'transfer_in', channel: 'transfer', sign: +1 },
    { re: /سحب|withdraw|صراف|\batm\b/i, type: 'atm_withdrawal', channel: 'atm', sign: -1 },
    { re: /(?:حوالة|تحويل)\s*(?:مالية\s*)?(?:صادرة|صادر)|حولت|تحويل\s*(?:مبلغ\s*)?(?:إلى|الى|لـ|ل\s)|transfer(?:red)?\s*to|(?:outward|outgoing)\s*transfer|transfer\s*out\b|\bsent\b|أرسلت|ارسلت|إرسال|ارسال/i, type: 'transfer_out', channel: 'transfer', sign: -1 },
    { re: /سداد\s*(?:فاتورة|فواتير)|فاتورة|sadad|\bbill\b/i, type: 'bill_payment', channel: 'sadad', sign: -1 },
    { re: /رسوم|\bfees?\b/i, type: 'fee', channel: 'other', sign: -1 },
    { re: /شراء\s*(?:إنترنت|انترنت|عبر الإنترنت|عبر الانترنت|اونلاين)|online|e-?commerce|internet purchase/i, type: 'online_purchase', channel: 'online', sign: -1 },
    { re: /شراء|purchase|دفع|\bpaid\b|payment|خصم|debited|مدين|\bpos\b|apple pay|مدى|\bmada\b|عملية/i, type: 'pos_purchase', channel: 'pos', sign: -1 }
  ];
  // A payment toward the credit card (from Al Rajhi or anywhere) lowers what you owe.
  var CARD_PAYMENT_RE = /سداد(?!\s*(?:فاتورة|فواتير))|payment received|repayment|received your payment|تم\s*استلام\s*(?:دفعة|مبلغ|سداد)/i;
  var W_AMOUNT = new RegExp('(?:' + CUR + '\\s*' + NUM + '|' + NUM + '\\s*' + CUR + ')', 'gi');
  var W_AMOUNT_BARE = new RegExp('(?:بمبلغ|مبلغ|بقيمة|المبلغ|amount)\\s*:?\\s*' + NUM, 'i');
  var W_BAL_KW = /(?:رصيدك|الرصيد|رصيد|balance|\bbal\b)[^\d]{0,25}$/i;
  var W_AVAIL_KW = /(?:المتاح|الحد المتاح|الرصيد المتاح|available(?:\s*(?:credit|limit|balance))?)[^\d]{0,25}$/i;
  var W_OWED_KW = /(?:المستحق|المبلغ المستحق|الرصيد المستحق|outstanding|amount due|total due(?!\s*amount))[^\d]{0,25}$/i;
  var W_AMT_KW = /(?:بمبلغ|مبلغ|بقيمة|amount|شراء|purchase)[^\d]{0,25}$/i;
  // ANB: "Total amount:SAR 190.42" is the purchase plus fees and VAT; that's what leaves the card.
  var W_TOTAL_KW = /(?:total amount|total due amount|المبلغ الإجمالي|المبلغ الاجمالي|الإجمالي|الاجمالي)[^\d]{0,25}$/i;
  var W_FEE_KW = /(?:fees?(?: and vat)?|vat|رسوم|ضريبة)[^\d]{0,25}$/i;
  var W_WHO = /(?:^|[\s:،,])(لدى|عند|في|at|from|to|إلى|الى|لـ|من)(?![a-z])\s*:?\s*([^\n]+?)(?=\s*(?:بمبلغ|مبلغ|بقيمة|المبلغ|الرصيد|رصيد|المتاح|balance|available|remaining|\bbal\b|\bcard\b|\*|بتاريخ|تاريخ|بطاقة|عبر|في\s+\d|on\s+\d|\d{1,4}[\/\-.]\d|SAR|SR|ر\.?\s?س|ريال|\.(?=\s|$)|[،,;]|$))/gim;
  // No letters at all (Arabic counts as letters: plain \W would throw out an Arabic name).
  var W_NOT_WHO = /محفظت|حساب|بطاقت|بطاقة|wallet|account|\bcard\b|\byour\b|رصيد|^[^A-Za-z؀-ۿ]*$|^[\d*\s]+$/i;
  var W_DATE = /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/;

  /** Parse one wallet or credit card text. Returns a transaction-like object or null. */
  function parseWalletSms(text, walletId, meta) {
    meta = meta || {};
    var def = WALLET_IDS[walletId];
    if (!def || !text || typeof text !== 'string' || IGNORE.test(text)) return null;
    var t = normDigits(text);
    // Which way: card payments first for the card, then the earliest wording in the text.
    var rule = null, at = Infinity;
    if (def.kind === 'card' && CARD_PAYMENT_RE.test(t)) rule = { type: 'card_payment', channel: 'transfer', sign: +1 };
    else W_RULES.forEach(function (r) { var m = t.match(r.re); if (m && m.index < at) { at = m.index; rule = r; } });
    if (!rule) return null;

    var amount = null, total = null, balance = null, available = null, owed = null, m;
    W_AMOUNT.lastIndex = 0;
    while ((m = W_AMOUNT.exec(t))) {
      var before = t.slice(Math.max(0, m.index - 40), m.index);
      var a = parseAmount(m[0]);
      if (!a) continue;
      // The label closest before the number decides what it is ("شحن رصيد بمبلغ 50" is an amount).
      var labels = [[W_AVAIL_KW, 'available'], [W_OWED_KW, 'owed'], [W_BAL_KW, 'balance'], [W_TOTAL_KW, 'total'], [W_FEE_KW, 'fee'], [W_AMT_KW, 'amount']].map(function (p) {
        var mm = before.match(p[0]); return mm ? { kind: p[1], at: mm.index } : null;
      }).filter(Boolean).sort(function (x, y) { return y.at - x.at; });
      var kind = labels.length ? labels[0].kind : 'amount';
      // "Total amount:" holds the word "amount" too; the longer label wins.
      var tot = labels.find(function (l) { return l.kind === 'total'; });
      if (kind === 'amount' && tot && labels[0].at >= tot.at) kind = 'total';
      if (kind === 'available' && available === null) available = a;
      else if (kind === 'owed' && owed === null) owed = a;
      else if (kind === 'balance' && balance === null) balance = a;
      else if (kind === 'total' && total === null) total = a;
      else if (kind === 'amount' && !amount) amount = a;
    }
    if (total && total.amount > 0) amount = total;
    if (!amount && (m = t.match(W_AMOUNT_BARE))) amount = { amount: toNumber(m[1]), currency: 'SAR' };
    // On ANB card texts "Balance" is the credit still available: it goes down as you spend.
    if (def.kind === 'card' && balance && available === null) { available = balance; balance = null; }
    if (!amount || !(amount.amount > 0)) return null;

    // Who: the shop for payments, the sender for money in.
    var who = [];
    W_WHO.lastIndex = 0;
    while ((m = W_WHO.exec(t))) {
      var v = m[2].replace(/\*+\d*|\d{4,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (v && !W_NOT_WHO.test(v)) who.push({ kw: m[1].toLowerCase(), v: v });
    }
    // STC Bank names the shop after "From:" on purchases, so that comes last for money out.
    var prefer = rule.sign > 0 ? ['من', 'from'] : ['لدى', 'عند', 'at', 'لـ', 'إلى', 'الى', 'to', 'في', 'from'];
    var pick = null;
    prefer.some(function (k) { pick = who.find(function (w) { return w.kw === k; }); return !!pick; });
    var merchant = pick ? pick.v : null;

    var dt = t.match(W_DATE);
    // The text's own date and time when it has one (exact even if pasted later), else when it arrived.
    var date = dt && /\d:\d\d/.test(dt[0]) ? parseSmsDate(dt[0], meta.receivedAt) : null;
    if (!date && meta.receivedAt) date = parseSmsDate(null, meta.receivedAt);
    if (!date && dt) date = parseSmsDate(dt[0], null);
    // No date anywhere (simple setup without ##AT##): use the moment it's added, which is close enough.
    if (!date) date = toRiyadhIso(new Date());
    var card = t.match(/(?:بطاقة|البطاقة|card|via)[^\d\n]{0,12}\*?(\d{4})(?!\d)/i);
    var label = { refund: 'Refund', transfer_in: 'Money in', wallet_topup: 'Top-up', atm_withdrawal: 'Cash withdrawal', transfer_out: 'Transfer out',
      bill_payment: 'Bill payment', fee: 'Fee', online_purchase: 'Online purchase', pos_purchase: 'Payment', card_payment: 'Card payment' }[rule.type];
    var foreign = amount.currency !== 'SAR';
    return {
      date: date,
      amount: Math.round(rule.sign * amount.amount * 100) / 100,
      currency: foreign ? amount.currency : 'SAR',
      // The wallet's own name stays out of the description: "STC Pay" would make every payment look like a transfer.
      description: label + (merchant ? ' | ' + merchant : ''),
      merchant: merchant || (rule.type === 'card_payment' ? def.name : null),
      raw_category: rule.type,
      channel: rule.channel,
      card_last4: card ? card[1] : null,
      // For the card a balance is what you owe (negative); for a wallet, what's in it.
      balance_after: def.kind === 'card' ? (owed && owed.currency === 'SAR' ? -owed.amount : null) : (balance && balance.currency === 'SAR' ? balance.amount : null),
      available_after: def.kind === 'card' && available && available.currency === 'SAR' ? available.amount : null,
      account: walletId,
      raw: text
    };
  }

  /** Wallet texts the parser couldn't read, kept (encrypted with the rest) so they can be looked at. */
  function keepUnread(data, list) {
    ensureWallets(data);
    var added = 0;
    (list || []).forEach(function (u) {
      var text = String(u.text).slice(0, 1000).replace(/\d{8,}/g, function (n) { return '…' + n.slice(-3); });
      if (data.wallet_unread.some(function (x) { return x.text === text && x.wallet === u.wallet; })) return;
      data.wallet_unread.push({ wallet: u.wallet, text: text, at: u.at || new Date().toISOString() });
      added++;
    });
    if (data.wallet_unread.length > 30) data.wallet_unread = data.wallet_unread.slice(-30);
    return added;
  }

  function txTime(t) { var v = Date.parse(t.datetime || (t.date + 'T12:00:00+03:00')); return isNaN(v) ? 0 : v; }
  function sortedRules(data) { return data.rules.slice().sort(function (a, b) { return b.pattern.length - a.pattern.length; }); }

  // Money moved between Al Rajhi and a wallet or the card shows up twice (out of one, into the
  // other). Pair them by exact amount within a few days and mark both as a transfer between your
  // own accounts, so neither counts as spending, income or "sent to people".
  var LINK_WALLET = { wallet_topup: 1, transfer_in: 1, transfer_out: 1, card_payment: 1, own_transfer: 1, deposit: 1 };
  var LINK_BANK = { transfer_out: 3, transfer_in: 3, own_transfer: 3, deposit: 3, bill_payment: 3, pos_purchase: 1, online_purchase: 1 };
  function revertLink(data, t) {
    delete t.link;
    if (t.category_source === 'link') {
      var c = categorize(t, sortedRules(data));
      t.category = c.category; t.category_source = c.source; t.type = typeFor(c.category, t.amount, null);
    }
  }
  function unlink(data, id) {
    data.transactions.forEach(function (t) { if (t.link === id) revertLink(data, t); });
  }
  function linkTransfers(data) {
    var txs = data.transactions, byId = {};
    txs.forEach(function (t) { byId[t.id] = t; });
    txs.forEach(function (t) {
      if (!t.link) return;
      var p = byId[t.link];
      if (!p || p.link !== t.id || t.category_source === 'manual' || p.category_source === 'manual') revertLink(data, t);
    });
    var free = txs.filter(function (t) { return !t.link && t.category_source !== 'manual' && t.booking_status !== 'pending'; });
    free.filter(function (t) { return t.account && LINK_WALLET[t.raw_category]; })
      .sort(function (a, b) { return txTime(a) - txTime(b); })
      .forEach(function (w) {
        if (w.link) return;
        var best = null, bestGap = Infinity;
        free.forEach(function (o) {
          if (o.link || o === w || (o.account || null) === w.account || o.amount !== -w.amount) return;
          // The other side may be the ANB card paying for a wallet top-up with Apple Pay (a purchase on the card).
          var days = o.account ? (LINK_WALLET[o.raw_category] ? 3 : LINK_BANK[o.raw_category] === 1 ? 1 : 0) : (LINK_BANK[o.raw_category] || 0);
          // A purchase on the Al Rajhi card only pairs with money arriving in the wallet (Apple Pay top-up).
          if (days === 1 && w.amount < 0) days = 0;
          var gap = Math.abs(txTime(o) - txTime(w));
          if (!days || gap > days * DAY) return;
          if (gap < bestGap) { best = o; bestGap = gap; }
        });
        if (best) { w.link = best.id; best.link = w.id; }
      });
    txs.forEach(function (t) {
      if (t.link && t.category_source !== 'manual') { t.category = 'transfer'; t.category_source = 'link'; t.type = 'transfer'; }
    });
  }

  /** Balance of one wallet/card now, in halalas, plus when it was last updated. */
  function walletBalance(data, w) {
    var def = WALLET_IDS[w.id];
    var txs = data.transactions.filter(function (t) { return t.account === w.id && t.booking_status !== 'pending'; })
      .sort(function (a, b) { return txTime(a) - txTime(b) || a.id - b.id; });
    var startAt = w.start ? Date.parse(w.start.at) : -Infinity;
    var bal = w.start ? w.start.amount : 0, known = !!w.start, updated = w.start ? w.start.at : null, since = 0;
    txs.forEach(function (t) {
      if (txTime(t) <= startAt) return; // already part of the starting amount
      var told = null;
      if (t.balance_after !== null && t.balance_after !== undefined) told = t.balance_after;
      else if (def.kind === 'card' && t.available_after !== null && t.available_after !== undefined && w.limit) told = t.available_after - w.limit;
      if (told !== null) { bal = told; known = true; } else bal += t.amount;
      updated = t.datetime || t.date;
      since++;
    });
    return { balance: bal, known: known, updated: updated, since: since };
  }

  /** Everything the Wallets tab shows. Amounts in SAR; the card's balance is negative (what you owe). */
  function walletsView(data, month) {
    ensureWallets(data);
    var per = periodFn(data);
    month = month || periodOf(data, today());
    var total = 0, owed = 0, anyKnown = false;
    var list = data.wallets.map(function (w) {
      var def = WALLET_IDS[w.id], b = walletBalance(data, w), spent = 0, inn = 0;
      var mine = data.transactions.filter(function (t) { return t.account === w.id; });
      mine.forEach(function (t) {
        if (per(t.date) !== month || t.booking_status === 'pending') return;
        if (t.category === 'transfer') return;
        if (t.amount < 0) spent -= t.amount; else inn += t.amount;
      });
      if (b.known) {
        anyKnown = true;
        if (def.kind === 'card') owed += Math.max(0, -b.balance); else total += b.balance;
      }
      var recent = mine.slice().sort(function (a, b2) { return txTime(b2) - txTime(a) || b2.id - a.id; }).map(function (t) {
        return { id: t.id, date: t.date, datetime: t.datetime, amount: toSar(t.amount), merchant: t.merchant, description: t.description, category: t.category, type: t.type, link: !!t.link };
      });
      return {
        id: w.id, name: def.name, kind: def.kind, tag: def.tag,
        balance: toSar(b.balance), known: b.known, updated: b.updated, texts_since_start: b.since,
        start: w.start ? { amount: toSar(w.start.amount), at: w.start.at } : null,
        limit: toSar(w.limit), available: def.kind === 'card' && w.limit && b.known ? toSar(w.limit + b.balance) : null,
        month_spent: toSar(spent), month_in: toSar(inn), count: mine.length, recent: recent,
        unread: data.wallet_unread.filter(function (u) { return u.wallet === w.id; }).length
      };
    });
    return { month: month, wallets: list, total: toSar(total), card_owed: toSar(owed), any_known: anyKnown, unread: data.wallet_unread.slice() };
  }

  /** Set a wallet's balance as of now (or `at`). For the card pass what you owe (a positive number) and the limit. */
  function setWalletStart(data, id, amountSar, opts) {
    ensureWallets(data);
    opts = opts || {};
    var w = data.wallets.find(function (x) { return x.id === id; });
    if (!w) throw new Error('unknown wallet');
    var h = toHalalas(amountSar);
    if (WALLET_IDS[id].kind === 'card') h = -Math.abs(h); else if (h < 0) throw new Error('A wallet balance can’t be below zero.');
    w.start = { amount: h, at: opts.at || new Date().toISOString() };
    if (opts.limit !== undefined) w.limit = opts.limit === null || opts.limit === '' ? null : Math.abs(toHalalas(opts.limit)) || null;
    return w;
  }
  function clearWalletUnread(data, id) {
    ensureWallets(data);
    data.wallet_unread = data.wallet_unread.filter(function (u) { return id && u.wallet !== id; });
  }

  // ======================================================================
  // Plan: safe to spend until payday, bills still due, last month recap
  // ======================================================================
  /** Everything the Plan tab shows, for the month that contains asOf. Amounts in SAR. */
  function planView(data, asOf) {
    asOf = asOf || today();
    var key = periodOf(data, asOf), range = periodRange(data, key), per = periodFn(data);
    var payday = addDays(range.end, 1);
    var income = 0, spent = 0, sent = 0;
    data.transactions.forEach(function (t) {
      if (!booked(t) || t.date > asOf || per(t.date) !== key) return;
      if (t.category === 'transfer') {
        // Money sent to people (rent, family) is gone too; moves between own accounts and card payoffs are not.
        if (t.amount < 0 && t.raw_category === 'transfer_out' && !t.link) sent -= t.amount;
        return;
      }
      if (t.type === 'salary' || t.type === 'income') income += t.amount;
      if (t.type === 'spending' || t.type === 'subscription' || t.type === 'refund') spent -= t.amount;
    });

    // Things that come back: detected subscriptions and bills, plus regular transfers to the same person (rent).
    var items = [];
    data.subscriptions.forEach(function (s) {
      if (s.status !== 'active' && s.status !== 'suspected') return;
      if (!s.next_renewal || !s.amount) return;
      items.push({ name: s.name, amount: s.amount, cycle: s.cycle, last: s.last_charged, next: s.next_renewal, kind: s.kind });
    });
    var groups = new Map();
    data.transactions.forEach(function (t) {
      if (!booked(t) || t.amount >= 0 || t.category !== 'transfer' || t.raw_category !== 'transfer_out' || t.link) return;
      var k = merchantKey(t);
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    });
    groups.forEach(function (list) {
      list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      var info = list.length >= 3 ? analyzeGroup(list) : null;
      var last = list[list.length - 1];
      if (!info || info.cycle !== 'monthly' || daysBetween(last.date, asOf) > 45) return;
      items.push({ name: prettyName(last), amount: info.amount, cycle: 'monthly', last: last.date, next: nextAfter(last.date, 'monthly'), kind: 'transfer' });
    });

    var bills = [], left = 0;
    items.forEach(function (it) {
      if (it.last && it.last >= range.start && it.last <= asOf) bills.push({ name: it.name, amount: toSar(it.amount), date: it.last, paid: true, kind: it.kind });
      for (var d = it.next, n = 0; d < payday && n < 60; d = nextAfter(d, it.cycle), n++) {
        if (d < range.start) continue;
        bills.push({ name: it.name, amount: toSar(it.amount), date: d, paid: false, overdue: d < asOf, kind: it.kind });
        left += it.amount;
      }
    });
    bills.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : 1; });

    var safe = income - spent - sent - left;
    var daysLeft = Math.max(1, daysBetween(asOf, payday));
    var totalDays = Math.max(1, daysBetween(range.start, payday));
    var day = Math.min(totalDays, daysBetween(range.start, asOf) + 1);
    var pace;
    if (income <= 0) pace = 'no_income';
    else if (safe < 0) pace = 'over';
    else {
      // Share of the free money (after bills) used so far, against share of the month gone.
      var free = income - (left + bills.filter(function (b) { return b.paid; }).reduce(function (a, b) { return a + Math.round(b.amount * 100); }, 0));
      var used = free > 0 ? (spent + sent - bills.filter(function (b) { return b.paid; }).reduce(function (a, b) { return a + Math.round(b.amount * 100); }, 0)) / free : 1;
      pace = used <= day / totalDays + 0.1 ? 'on_track' : 'fast';
    }

    // Last month in short, compared with the month before it.
    var prev = shiftMonth(key, -1), prevRange = periodRange(data, prev);
    var ps = monthSummary(data, prev), prevSent = 0;
    data.transactions.forEach(function (t) {
      if (booked(t) && t.amount < 0 && t.category === 'transfer' && t.raw_category === 'transfer_out' && !t.link && per(t.date) === prev) prevSent -= t.amount;
    });
    var before = {};
    categoryBreakdown(data, shiftMonth(prev, -1)).forEach(function (c) { before[c.category] = c.amount; });
    var hasBefore = Object.keys(before).length > 0;
    var top = categoryBreakdown(data, prev).filter(function (c) { return c.amount > 0; }).slice(0, 5).map(function (c) {
      var change = hasBefore ? Math.round((c.amount - (before[c.category] || 0)) * 100) / 100 : 0;
      var notable = hasBefore && Math.abs(change) >= Math.max(100, (before[c.category] || 0) * 0.15);
      return { category: c.category, amount: c.amount, change: notable ? change : 0 };
    });

    return {
      month: key, start: range.start, end: range.end, payday: payday, payday_mode: range.payday,
      as_of: asOf, day: day, total_days: totalDays, days_left: daysLeft,
      income: toSar(income), spent: toSar(spent), sent: toSar(sent), bills_left: toSar(left),
      safe: toSar(safe), per_day: toSar(safe > 0 ? Math.floor(safe / daysLeft) : 0), pace: pace,
      bills: bills,
      recap: {
        month: prev, start: prevRange.start, end: prevRange.end,
        spent: ps.spending, sent: toSar(prevSent), saved: Math.round((ps.net - prevSent / 100) * 100) / 100, income: ps.income, has_data: ps.transaction_count > 0, top: top
      }
    };
  }

  return {
    statementRows: statementRows, statementTransaction: statementTransaction, importStatement: importStatement,
    // dates/money
    toDay: toDay, today: today, monthOf: monthOf, periodOf: periodOf, periodRange: periodRange, monthMode: monthMode, isMonth: isMonth, shiftMonth: shiftMonth, monthRange: monthRange,
    addDays: addDays, addMonths: addMonths, daysBetween: daysBetween, toHalalas: toHalalas, toSar: toSar,
    // parsing
    parseAlRajhiSms: parseAlRajhiSms, parseAmount: parseAmount, parseSmsDate: parseSmsDate, normDigits: normDigits,
    splitMessages: splitMessages, parseTexts: parseTexts, importTexts: importTexts, smsId: smsId,
    // data
    CATEGORIES: CATEGORIES, categorize: categorize, typeFor: typeFor, normalizeText: normalizeText,
    emptyData: emptyData, validateData: validateData, importTransactions: importTransactions,
    recategorize: recategorize, recategorizeAll: recategorizeAll, upgradeCategories: upgradeCategories, unknownShops: unknownShops, CAT_VERSION: CAT_VERSION, deleteTransaction: deleteTransaction,
    detect: detect, merchantKey: merchantKey, monthlyEquivalent: monthlyEquivalent, setSubscriptionStatus: setSubscriptionStatus,
    // views
    monthSummary: monthSummary, monthlyTrend: monthlyTrend, categoryBreakdown: categoryBreakdown,
    subscriptionsOut: subscriptionsOut, transactionsOut: transactionsOut, monthsWithData: monthsWithData,
    setSalaryProfile: setSalaryProfile, salaryView: salaryView, planView: planView,
    // wallets
    WALLETS: WALLET_LIST, parseWalletSms: parseWalletSms, walletsView: walletsView, setWalletStart: setWalletStart,
    linkTransfers: linkTransfers, ensureWallets: ensureWallets, clearWalletUnread: clearWalletUnread
  };
});
