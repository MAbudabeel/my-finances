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
    { re: /راتب|salary|payroll/i, type: 'salary', channel: 'transfer', sign: +1 },
    { re: /استرداد|استرجاع|refund|reversal/i, type: 'refund', channel: 'other', sign: +1 },
    { re: /(حوالة|تحويل)\s*(واردة|وارد)|incoming (transfer|remittance)|transfer received/i, type: 'transfer_in', channel: 'transfer', sign: +1 },
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
      else if ((m = v.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/))) { d = m[1]; mo = m[2]; y = m[3].length === 2 ? '20' + m[3] : m[3]; }
      if (y && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
        var t = v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        var date = y + '-' + pad(mo) + '-' + pad(d);
        return t ? date + 'T' + pad(t[1]) + ':' + t[2] + ':' + (t[3] || '00') + '+03:00' : date;
      }
    }
    if (fallback) { var f = new Date(fallback); if (!isNaN(f)) return toRiyadhIso(f); }
    return null;
  }
  var AMOUNT_RE = new RegExp('(?:^|\\s)(?:بـ|ب\\s|بمبلغ|مبلغ\\s*:|المبلغ\\s*:|amount\\s*:|amt\\s*:)\\s*(' + CUR + '?\\s*' + NUM + '\\s*' + CUR + '?)', 'i');
  var MERCHANT_RE = /^(?:لـ|لدى\s*:?|at\s*:|merchant\s*:)\s*(.+)$/i;
  var TO_RE = /^(?:إلى|الى|to)\s*:\s*(.+)$/i;
  var FROM_RE = /^(?:من|from)\s*:\s*(.+)$/i;
  var CARD_RE = /^(?:عبر|بطاقة|البطاقة|card)\s*:?\s*\*?(\d{4})\s*(?:;\s*(.+))?$/i;
  var BALANCE_RE = /^(?:رصيد|الرصيد|الرصيد المتاح|balance|bal|available balance)\s*:?\s*(.+)$/i;
  var DATE_LINE_RE = /^(?:(?:في|التاريخ|تاريخ|date|on)\s*:?\s*)?\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/i;
  function last4(s) { if (!s) return null; var m = normDigits(s).match(/(\d{4})(?!.*\d)/); return m ? m[1] : null; }

  /** Parse one Al Rajhi alert. Returns a transaction-like object or null (OTP, marketing, unknown). */
  function parseAlRajhiSms(text, meta) {
    meta = meta || {};
    if (!text || typeof text !== 'string') return null;
    if (IGNORE.test(text)) return null;
    var lines = normDigits(text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
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
      if (!merchant && (m = line.match(MERCHANT_RE))) { merchant = m[1].trim(); return; }
      if (!to && (m = line.match(TO_RE))) { to = m[1].trim(); return; }
      if (!from && (m = line.match(FROM_RE))) { from = m[1].trim(); return; }
    });
    if (!amount) return null;

    var counterparty = merchant || (rule.sign > 0 ? from : to) || null;
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
  var MARKER_RE = /^##SMS##[ \t]*(.*)$/;
  // First line of an alert (purchase, card payoff, deposit, transfer, ATM, bill, refund, fee).
  var HEADER_START = /^(شراء|بطاقة[^:\d]*:\s*سداد|إيداع|ايداع|حوالة|تحويل|سحب|سداد|استرداد|استرجاع|رسوم|online purchase|pos purchase|purchase|atm withdrawal|incoming transfer|outgoing transfer|salary|refund)/i;
  function splitMessages(input) {
    var text = String(input || '').replace(/\r\n?/g, '\n');
    var out = [];
    if (/^##SMS##/m.test(text)) {
      var cur = null;
      text.split('\n').forEach(function (line) {
        var m = line.match(MARKER_RE);
        if (m) { if (cur) out.push(cur); cur = { receivedAt: m[1].trim() || null, lines: [] }; }
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
      return { text: m.lines.join('\n').trim(), receivedAt: m.receivedAt || null };
    }).filter(function (m) { return m.text && !/^-+$/.test(m.text); });
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
    { id: 'transport', label: 'Transport & fuel', kind: 'spending' },
    { id: 'bills', label: 'Bills & utilities', kind: 'spending' },
    { id: 'subscriptions', label: 'Subscriptions', kind: 'spending' },
    { id: 'shopping', label: 'Shopping', kind: 'spending' },
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

  var BUILTIN = [
    ['salary', ['salary', 'payroll', 'راتب', 'رواتب', 'مسير', 'wps ']],
    ['refund', ['refund', 'reversal', 'استرداد', 'استرجاع', 'cashback']],
    ['financing', ['tabby', 'تابي', 'tamara', 'تمارا', 'installment', 'قسط', 'تمويل', 'finance repayment', 'loan', 'mortgage', 'عقاري']],
    ['housing', ['rent', 'إيجار', 'ايجار', 'ejar', 'real estate', 'عقار']],
    ['charity', ['zakat', 'زكاة', 'ehsan', 'إحسان', 'charity', 'صدقة', 'donation', 'تبرع', 'jood']],
    ['transfer', ['transfer', 'تحويل', 'حوالة', 'sarie', 'سريع', 'stc pay', 'stcpay', 'urpay', 'own account', 'internal transfer', 'credit card payment', 'سداد بطاقة']],
    ['subscriptions', ['netflix', 'shahid', 'شاهد', 'spotify', 'anghami', 'أنغامي', 'osn', 'starzplay', 'starz play', 'disney', 'youtube premium', 'youtube', 'apple.com/bill', 'apple.com', 'itunes', 'icloud', 'google one', 'google storage', 'google *', 'amazon prime', 'primevideo', 'prime video', 'openai', 'chatgpt', 'anthropic', 'claude.ai', 'microsoft', 'xbox', 'playstation', 'psn', 'adobe', 'canva', 'dropbox', 'linkedin', 'fitness time', 'fitnesstime', 'وقت اللياقة', "gold's gym", 'golds gym', 'nuvola', 'tod tv', 'beinsports', 'bein', 'audible', 'kindle unl']],
    ['bills', ['saudi electricity', 'الكهرباء', 'sec bill', 'national water', 'المياه', 'nwc', 'stc', 'mobily', 'موبايلي', 'zain', 'زين', 'virgin mobile', 'lebara', 'salam mobile', 'sawa', 'jawwy', 'سداد فاتورة', 'bill payment', 'sadad bill']],
    ['government', ['absher', 'أبشر', 'moi', 'وزارة الداخلية', 'muqeem', 'مقيم', 'traffic', 'مخالفة', 'المرور', 'passport', 'الجوازات', 'iqama', 'إقامة', 'balady', 'بلدي', 'najiz', 'ناجز', 'zatca', 'gosi', 'sadad moi', 'government']],
    ['cash', ['atm', 'cash withdrawal', 'سحب نقدي', 'سحب']],
    ['bank_fees', ['fee', 'رسوم', 'commission', 'عمولة', 'vat on fee', 'annual fee']],
    ['groceries', ['panda', 'بنده', 'danube', 'الدانوب', 'tamimi', 'التميمي', 'othaim', 'العثيم', 'carrefour', 'كارفور', 'lulu', 'لولو', 'nesto', 'bindawood', 'بن داود', 'farm superstores', 'المزرعة', 'manuel', 'hyper', 'هايبر', 'supermarket', 'سوبرماركت', 'grocery', 'ninja', 'نينجا', 'nana', 'نعناع', 'baqala', 'بقالة', 'tamimi markets']],
    ['coffee', ['starbucks', 'ستاربكس', 'dunkin', 'tim hortons', 'barns', 'بارنز', 'half million', 'كوفي', 'coffee', 'cafe', 'café', 'dr.cafe', 'dr cafe', 'costa', 'caribou', 'brew92', 'overdose']],
    ['dining', ['albaik', 'al baik', 'البيك', 'kudu', 'كودو', 'herfy', 'هرفي', 'mcdonald', 'ماكدونالدز', 'burger king', 'kfc', 'pizza', 'بيتزا', 'shawarma', 'شاورما', 'restaurant', 'مطعم', 'hungerstation', 'هنقرستيشن', 'jahez', 'جاهز', 'mrsool', 'مرسول', 'toyou', 'to you', 'keeta', 'كيتا', 'the chefz', 'chefz', 'careem food', 'talabat', 'shake shack', 'five guys', 'maestro', 'domino', 'subway', 'hardee', 'texas chicken', 'romansiah', 'الرومانسية']],
    ['transport', ['uber', 'careem', 'كريم', 'bolt', 'jeeny', 'جيني', 'aldrees', 'الدريس', 'sasco', 'ساسكو', 'petromin', 'بترومين', 'naft', 'نفط', 'fuel', 'petrol', 'بنزين', 'محطة', 'station', 'parking', 'مواقف', 'saptco', 'سابتكو', 'riyadh metro', 'darb', 'najm', 'نجم', 'car wash', 'tasjeel', 'yelo', 'theeb', 'budget rent', 'lumi', 'salik']],
    ['travel', ['saudia', 'السعودية للطيران', 'flynas', 'طيران ناس', 'flyadeal', 'طيران أديل', 'emirates', 'qatar airways', 'booking.com', 'agoda', 'airbnb', 'almosafer', 'المسافر', 'flyin', 'hotel', 'فندق', 'marriott', 'hilton', 'sar railway', 'haramain', 'قطار']],
    ['health', ['nahdi', 'النهدي', 'dawaa', 'الدواء', 'pharmacy', 'صيدلية', 'hospital', 'مستشفى', 'clinic', 'عيادة', 'medical', 'طبي', 'dental', 'أسنان', 'sulaiman al habib', 'الحبيب', 'dallah', 'مستوصف', 'tawuniya', 'bupa', 'بوبا', 'medgulf']],
    ['education', ['school', 'مدرسة', 'university', 'جامعة', 'academy', 'أكاديمية', 'course', 'udemy', 'coursera', 'tuition']],
    ['entertainment', ['cinema', 'vox', 'muvi', 'amc', 'سينما', 'webook', 'boulevard', 'بوليفارد', 'riyadh season', 'موسم', 'steam', 'game']],
    ['shopping', ['amazon', 'أمازون', 'noon', 'نون', 'namshi', 'نمشي', 'jarir', 'جرير', 'extra', 'اكسترا', 'ikea', 'ايكيا', 'shein', 'شي ان', 'centrepoint', 'centerpoint', 'h&m', 'zara', 'max fashion', 'redtag', 'red tag', 'sephora', 'nice one', 'نايس ون', 'golden scent', 'aliexpress', 'temu', 'apple store', 'virgin megastore', 'saco', 'ساكو', 'home centre', 'homecentre', 'mall', 'مول']]
  ];
  var HINTS = { transfer_in: 'transfer', transfer_out: 'transfer', card_payment: 'transfer', fee: 'bank_fees', bill_payment: 'bills' };

  function normalizeText(s) {
    return String(s || '').toLowerCase().normalize('NFKC')
      .replace(/[ً-ٰٟ]/g, '')
      .replace(/[إأآ]/g, 'ا')
      .replace(/\s+/g, ' ').trim();
  }
  var COMPILED = BUILTIN.map(function (g) { return [g[0], g[1].map(normalizeText)]; });
  function matches(hay, needle) {
    if (needle.length <= 4 && /^[a-z0-9.]+$/.test(needle)) {
      return new RegExp('(^|[^a-z0-9])' + needle.replace(/\./g, '\\.') + '([^a-z0-9]|$)').test(hay);
    }
    return hay.indexOf(needle) !== -1;
  }

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
    if (hint === 'atm_withdrawal' && !isCredit) return { category: 'cash', source: 'auto' };
    if (hint === 'card_payment') return { category: 'transfer', source: 'auto' };
    for (var j = 0; j < COMPILED.length; j++) {
      var cat = COMPILED[j][0], words = COMPILED[j][1];
      if (!words.some(function (w) { return matches(text, w); })) continue;
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
      meta: { created_at: new Date().toISOString(), last_import_at: null, last_backup_at: null }
    };
  }

  /** Check a decrypted object looks like our data (for backups). Throws on garbage. */
  function validateData(d) {
    if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.transactions) || !Array.isArray(d.subscriptions)) {
      throw new Error('This file is not a finance backup.');
    }
    d.rules = Array.isArray(d.rules) ? d.rules : [];
    d.meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
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
          raw: typeof t.raw === 'string' ? t.raw.slice(0, 2000) : null,
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

  function deleteTransaction(data, id) {
    var i = data.transactions.findIndex(function (x) { return x.id === id; });
    if (i === -1) throw new Error('not found');
    data.transactions.splice(i, 1);
    detect(data);
  }

  // ======================================================================
  // Subscriptions & salary detection (same rules as backend/src/subscriptions.js)
  // ======================================================================
  var SUBSCRIPTION_KINDS = { subscriptions: 1, bills: 1, entertainment: 1, education: 1 };
  var NOT_RECURRING = { groceries: 1, dining: 1, coffee: 1, transport: 1, cash: 1, transfer: 1, shopping: 1, refund: 1, travel: 1, health: 1 };
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
    creditGroups.forEach(function (credits) {
      var auto = credits.filter(function (c) { return c.category_source === 'auto' && c.category === 'income'; });
      if (auto.length < 2 || credits.some(function (c) { return c.category === 'transfer'; })) return;
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
  function inMonth(t, month) { return t.date.slice(0, 7) === month; }
  function booked(t) { return t.booking_status !== 'pending'; }

  function monthSummary(data, month) {
    var income = 0, spending = 0, refunds = 0, salary = 0, subs = 0, count = 0, tin = 0, tout = 0;
    data.transactions.forEach(function (t) {
      if (!booked(t) || !inMonth(t, month)) return;
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
    data.transactions.forEach(function (t) {
      if (!booked(t) || !inMonth(t, month) || t.category === 'transfer') return;
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
    return data.transactions.filter(function (t) { return inMonth(t, month); }).map(function (t) {
      return {
        id: t.id, date: t.date, datetime: t.datetime, amount: toSar(t.amount), description: t.description, merchant: t.merchant,
        category: t.category, type: t.type, card_last4: t.card_last4,
        original_amount: toSar(t.original_amount), original_currency: t.original_currency
      };
    });
  }

  function monthsWithData(data) {
    var seen = {};
    data.transactions.forEach(function (t) { seen[t.date.slice(0, 7)] = true; });
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
    var end = monthOf(today());
    var detected = [];
    for (var i = months - 1; i >= 0; i--) {
      var month = shiftMonth(end, -i), total = 0, n = 0;
      data.transactions.forEach(function (t) {
        if (t.category === 'salary' && t.amount > 0 && booked(t) && inMonth(t, month)) { total += t.amount; n++; }
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
    return Promise.all(msgs.map(function (m) {
      var t = parseAlRajhiSms(m.text, { receivedAt: m.receivedAt });
      if (!t) { ignored++; return null; }
      return smsId(m.text).then(function (id) { t.external_id = id; return t; });
    })).then(function (list) {
      return { parsed: list.filter(Boolean), ignored: ignored, total: msgs.length };
    });
  }

  function importTexts(data, input) {
    return parseTexts(input).then(function (p) {
      var r = importTransactions(data, p.parsed);
      r.ignored = p.ignored;
      r.messages = p.total;
      return r;
    });
  }

  return {
    // dates/money
    toDay: toDay, today: today, monthOf: monthOf, isMonth: isMonth, shiftMonth: shiftMonth, monthRange: monthRange,
    addDays: addDays, addMonths: addMonths, daysBetween: daysBetween, toHalalas: toHalalas, toSar: toSar,
    // parsing
    parseAlRajhiSms: parseAlRajhiSms, parseAmount: parseAmount, parseSmsDate: parseSmsDate, normDigits: normDigits,
    splitMessages: splitMessages, parseTexts: parseTexts, importTexts: importTexts, smsId: smsId,
    // data
    CATEGORIES: CATEGORIES, categorize: categorize, typeFor: typeFor, normalizeText: normalizeText,
    emptyData: emptyData, validateData: validateData, importTransactions: importTransactions,
    recategorize: recategorize, recategorizeAll: recategorizeAll, deleteTransaction: deleteTransaction,
    detect: detect, merchantKey: merchantKey, monthlyEquivalent: monthlyEquivalent, setSubscriptionStatus: setSubscriptionStatus,
    // views
    monthSummary: monthSummary, monthlyTrend: monthlyTrend, categoryBreakdown: categoryBreakdown,
    subscriptionsOut: subscriptionsOut, transactionsOut: transactionsOut, monthsWithData: monthsWithData,
    setSalaryProfile: setSalaryProfile, salaryView: salaryView
  };
});
