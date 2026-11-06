// Demo data: six months of made-up Al Rajhi texts, in the real alert format,
// run through the same parser as real texts. Card numbers and amounts are fake.
(function (root) {
  'use strict';

  function pad(n) { return String(n).padStart(2, '0'); }
  function smsDate(y, m, d, hh, mm) { return d + '/' + m + '/' + String(y).slice(2) + ' ' + pad(hh) + ':' + pad(mm); }

  function pos(amount, merchant, date) { return 'شراء PoS\n\nعبر:1111;مدى-ابل باي\n\nبـSAR ' + amount + '\n\nلـ' + merchant + '\n\n' + date; }
  function online(amount, merchant, date, bal) { return 'شراء إنترنت بـSR ' + amount + ' \n\nعبر2222;فيزا\n\nلـ' + merchant + '\n\nرصيد:' + bal + ' SR\n\n' + date; }

  /** Returns the demo texts joined the way the iPhone Shortcut queues them. */
  function demoTexts(now) {
    now = now || new Date();
    var out = [];
    var bal = 2400;
    for (var back = 5; back >= 0; back--) {
      var dt = new Date(now.getFullYear(), now.getMonth() - back, 1);
      var y = dt.getFullYear(), m = dt.getMonth() + 1;
      var lastDay = new Date(y, m, 0).getDate();
      var isCurrent = back === 0;
      var maxDay = isCurrent ? now.getDate() : lastDay;
      function add(day, text) { if (day <= maxDay) out.push(text); }

      // Salary on the 27th; rent on the 1st (transfer out).
      add(27, 'إيداع راتب بـSR 18,000.00\n\nإلى:5678\n\n' + smsDate(y, m, 27, 6, 5));
      add(1, 'حوالة صادرة بـSR 4500\n\nلـLANDLORD\n\n' + smsDate(y, m, 1, 9, 0));
      // Subscriptions
      add(3, online('56.00', 'NETFLIX.COM', smsDate(y, m, 3, 3, 10), (bal -= 56).toFixed(2)));
      var shahid = back >= 2 ? '39.99' : '44.99'; // price change two months ago
      add(12, online(shahid, 'Shahid', smsDate(y, m, 12, 4, 0), (bal -= 40).toFixed(2)));
      if (back >= 3) add(20, online('21.99', 'SPOTIFY', smsDate(y, m, 20, 2, 30), (bal -= 22).toFixed(2))); // cancelled
      add(15, 'سداد فاتورة بـSR 230\n\nلـSTC\n\n' + smsDate(y, m, 15, 10, 10));
      // Groceries weekly
      [4, 11, 18, 25].forEach(function (d, i) { add(d, pos((180 + i * 23.5).toFixed(2), i % 2 ? 'TAMIMI MARKETS' : 'PANDA', smsDate(y, m, d, 19, 40))); });
      // Coffee, dining, fuel
      [2, 6, 9, 13, 17, 22, 26].forEach(function (d, i) { add(d, pos((14 + (i % 3) * 4).toFixed(2), i % 2 ? 'DR.CAFE' : 'STARBUCKS', smsDate(y, m, d, 8, 15))); });
      [5, 14, 21, 28].forEach(function (d, i) { if (d <= lastDay) add(d, online((48 + i * 9).toFixed(2), i % 2 ? 'Jahez' : 'HungerStation', smsDate(y, m, d, 21, 5), (bal -= 50).toFixed(2))); });
      [7, 19].forEach(function (d) { add(d, pos('95.00', 'ALDREES', smsDate(y, m, d, 17, 20))); });
      add(10, pos('64.50', 'NAHDI PHARMACY', smsDate(y, m, 10, 20, 0)));
      // Shopping + one refund
      if (back === 2) {
        add(8, online('300.00', 'noon', smsDate(y, m, 8, 22, 0), (bal -= 300).toFixed(2)));
        add(16, 'استرداد بـSR 300\n\nلـnoon\n\n' + smsDate(y, m, 16, 12, 0));
      }
      if (back === 1) add(23, online('129.00', 'Amazon sa', smsDate(y, m, 23, 11, 53), (bal -= 129).toFixed(2)));
      // Credit card payoff (internal transfer, not spending)
      add(28, 'بطاقة فيزا:سداد بـSR 600 \n\nعبر2222;فيزا\n\nرصيد:1000.00 SR \n\n' + smsDate(y, m, Math.min(28, lastDay), 11, 53));
      // A one-time password text, which must be ignored
      add(9, 'رمز التحقق: 482913 لا تشاركه مع أحد');
    }
    return out.map(function (t) { return '##SMS##\n' + t; }).join('\n');
  }

  root.FinDemo = { demoTexts: demoTexts };
})(self);
