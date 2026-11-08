// My Finances (phone-only). All rendering uses textContent / createElement,
// never innerHTML with data, so text from the bank can't inject markup.
(function () {
  'use strict';

  var Core = window.FinCore;
  var Store = window.FinStore;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- state ----------
  var session = null;      // { key, salt, iterations } while unlocked
  var data = null;         // decrypted data while unlocked
  var demo = false;
  var state = { month: currentMonth() };
  var settings = loadSettings();
  // Wrong-password count survives reloads (localStorage holds only these two numbers).
  var lockState = (function () { try { var v = JSON.parse(localStorage.getItem('finance-lock') || '{}'); return { failed: +v.failed || 0, waitUntil: +v.waitUntil || 0 }; } catch (e) { return { failed: 0, waitUntil: 0 }; } })();
  var clipRead = null; // asked once per app start, kept across wrong-password tries
  function saveLockState() { try { localStorage.setItem('finance-lock', JSON.stringify(lockState)); } catch (e) { /* ignore */ } }

  var categoryLabels = {};
  Core.CATEGORIES.forEach(function (c) { categoryLabels[c.id] = c.label; });
  function catLabel(id) { return categoryLabels[id] || 'Other'; }

  var sar = new Intl.NumberFormat('en-SA', { style: 'currency', currency: 'SAR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var sarWhole = new Intl.NumberFormat('en-SA', { style: 'currency', currency: 'SAR', maximumFractionDigits: 0 });
  var sarShort = new Intl.NumberFormat('en-SA', { style: 'currency', currency: 'SAR', notation: 'compact', maximumFractionDigits: 1 });
  var monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
  var monthShort = new Intl.DateTimeFormat('en-GB', { month: 'short' });
  var monthShort = new Intl.DateTimeFormat('en-GB', { month: 'short' });
  var dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  var dayYearFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  var stampFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // ---------- helpers ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function currentMonth() { return data ? Core.periodOf(data, Core.today()) : Core.monthOf(Core.today()); }
  function parseMonth(m) { var p = String(m).split('-'); return new Date(+p[0], +p[1] - 1, 1); }
  function parseDate(s) { var p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  // Privacy: every amount shows as stars while this is on (remembered on this phone).
  var MASK = 'SAR ••••';
  function money(v) { return settings.hideAmounts ? MASK : sar.format(num(v)); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function svg(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function daysUntil(dateStr) { return Core.daysBetween(Core.today(), String(dateStr).slice(0, 10)); }
  function cycleLabel(c) { return { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' }[c] || 'Monthly'; }
  function showError(msg) { var b = $('error-banner'); b.textContent = msg || ''; b.hidden = !msg; }
  function showFormError(id, msg) { var e = $(id); e.textContent = msg || ''; e.hidden = !msg; }
  function openDialog(id) { var d = $(id); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  function closeDialog(id) { var d = $(id); if (d.close) d.close(); else d.removeAttribute('open'); }

  function loadSettings() {
    var s = { autolock: 5, autoPaste: true, hideAmounts: false };
    try { var raw = localStorage.getItem('finance-settings'); if (raw) { var p = JSON.parse(raw); if ([1, 5, 15].indexOf(p.autolock) !== -1) s.autolock = p.autolock; if (p.autoPaste === false) s.autoPaste = false; if (p.hideAmounts === true) s.hideAmounts = true; } } catch (e) { /* defaults */ }
    return s;
  }
  function saveSettings() { try { localStorage.setItem('finance-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  function screen(name) {
    ['loading', 'setup', 'lock', 'app'].forEach(function (n) { $('screen-' + n).hidden = n !== name; });
  }

  // Save after every change. In demo mode nothing is written.
  var saving = Promise.resolve();
  function persist() {
    if (demo || !session) return Promise.resolve();
    saving = saving.then(function () { return Store.save(session, data); }).then(function () { showError(''); }, function (err) {
      console.error(err);
      showError('Could not save on this phone. Free some storage space, then try again. Make a backup soon.');
    });
    return saving;
  }

  // ---------- password checks ----------
  function passwordProblem(p, p2) {
    if (!p || p.length < 12) return 'Use at least 12 characters. A short phrase of 3–4 words is easy to remember and hard to guess.';
    if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|123456789012|password|qwerty)/i.test(p)) return 'That password is too easy to guess. Try a short phrase instead.';
    if (p.length > 200) return 'That password is too long.';
    if (p2 !== undefined && p !== p2) return "The two passwords don't match.";
    return null;
  }

  // ---------- start ----------
  function start() {
    if (!window.crypto || !window.crypto.subtle || !window.indexedDB) {
      screen('setup');
      showFormError('setup-error', 'This page needs to be opened over HTTPS in Safari (or another modern browser) to keep your data encrypted.');
      $('setup-btn').disabled = true;
      return;
    }
    Store.exists().then(function (has) {
      if (!has) { screen('setup'); setTimeout(function () { $('setup-pass').focus(); }, 50); return; }
      return Store.quickKind().then(function (kind) {
        setLockMode(kind || 'password', !!kind);
        screen('lock');
        if (lockMode !== 'passkey') setTimeout(function () { var f = $(lockMode === 'pin' ? 'lock-pin' : 'lock-pass'); if (f) f.focus(); }, 50);
      });
    }).catch(function (err) {
      console.error(err);
      screen('setup');
      showFormError('setup-error', 'This browser is blocking storage (Private Browsing?). Open it in a normal Safari tab.');
    });
  }

  function onSetup(e) {
    e.preventDefault();
    var p = $('setup-pass').value, p2 = $('setup-pass2').value;
    var bad = passwordProblem(p, p2);
    if (bad) { showFormError('setup-error', bad); return; }
    showFormError('setup-error', '');
    var btn = $('setup-btn');
    btn.disabled = true; btn.textContent = 'Creating…';
    var d = Core.emptyData();
    Store.create(p, d).then(function (s) {
      session = s; data = d;
      $('setup-pass').value = ''; $('setup-pass2').value = '';
      Store.persist();
      enterApp();
    }).catch(function (err) {
      console.error(err);
      showFormError('setup-error', err.message || 'Could not create storage.');
    }).then(function () { btn.disabled = false; btn.textContent = 'Create'; });
  }

  // How the lock screen asks: 'passkey' (Face ID), 'pin' or 'password'.
  var lockMode = 'password', hasQuick = false;
  function setLockMode(mode, quick) {
    lockMode = mode; hasQuick = quick;
    $('face-btn').hidden = mode !== 'passkey';
    $('pin-field').hidden = mode !== 'pin';
    $('pass-field').hidden = mode !== 'password';
    $('lock-btn').hidden = mode === 'passkey';
    $('lock-use-pass').hidden = mode === 'password';
    showFormError('lock-error', '');
  }

  // Pick up bank texts the iPhone automation left on the clipboard. Must start inside the Unlock tap.
  function startClipboardRead() {
    if (settings.autoPaste && !clipRead && navigator.clipboard && navigator.clipboard.readText) {
      clipRead = navigator.clipboard.readText().catch(function () { clipRead = null; return null; });
    }
    return clipRead || Promise.resolve(null);
  }

  function unlocked(r, clip) {
    session = r.session;
    data = Core.validateData(r.data);
    var resorted = Core.upgradeCategories(data);
    lockState = { failed: 0, waitUntil: 0 }; saveLockState();
    $('lock-pass').value = ''; $('lock-pin').value = '';
    showFormError('lock-error', '');
    Store.persist();
    enterApp();
    if (resorted) persist();
    clip.then(autoImport);
  }

  function lockWait() {
    var wait = Math.ceil((lockState.waitUntil - Date.now()) / 1000);
    if (wait > 0) { showFormError('lock-error', 'Too many tries. Wait ' + wait + ' seconds.'); return true; }
    return false;
  }

  function onUnlock(e) {
    e.preventDefault();
    if (lockMode === 'passkey') { onFace(); return; }
    if (lockWait()) return;
    var pin = lockMode === 'pin';
    var p = $(pin ? 'lock-pin' : 'lock-pass').value;
    if (!p) { showFormError('lock-error', pin ? 'Enter your PIN.' : 'Enter your password.'); return; }
    if (pin && !/^\d{6}$/.test(p)) { showFormError('lock-error', 'The PIN is 6 digits.'); return; }
    var btn = $('lock-btn');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    var clip = startClipboardRead();
    (pin ? Store.unlockPin(p) : Store.unlock(p)).then(function (r) { unlocked(r, clip); }).catch(function (err) {
      $('lock-pass').value = ''; $('lock-pin').value = '';
      if (err && err.code === 'WRONG_PIN') {
        showFormError('lock-error', 'Wrong PIN. ' + err.left + (err.left === 1 ? ' try' : ' tries') + ' left before you need your password.');
      } else if (err && err.code === 'PIN_OFF') {
        setLockMode('password', false);
        showFormError('lock-error', 'Too many wrong PINs, so the PIN was turned off. Use your password, then set a new PIN in Settings.');
      } else if (err && err.code === 'WRONG_PASSWORD') {
        lockState.failed++;
        if (lockState.failed >= 5) lockState.waitUntil = Date.now() + 30000 * Math.pow(2, Math.min(lockState.failed - 5, 10));
        saveLockState();
        showFormError('lock-error', 'Wrong password.' + (lockState.failed >= 5 ? ' Wait ' + Math.round((lockState.waitUntil - Date.now()) / 1000) + ' seconds before trying again.' : ''));
      } else {
        console.error(err);
        showFormError('lock-error', (err && err.message) || 'Could not open your data.');
      }
    }).then(function () { btn.disabled = false; btn.textContent = 'Unlock'; });
  }

  function onFace() {
    var btn = $('face-btn');
    btn.disabled = true;
    var clip = startClipboardRead();
    Store.unlockPasskey().then(function (r) { unlocked(r, clip); }).catch(function (err) {
      console.warn(err);
      var cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      showFormError('lock-error', cancelled ? 'Face ID was cancelled. Tap to try again, or use your password.' : (err && err.message) || 'Face ID did not work. Use your password.');
    }).then(function () { btn.disabled = false; });
  }

  // ---------- quick unlock settings ----------
  function renderQuick() {
    Store.quickKind().then(function (kind) {
      $('quick-status').textContent = kind === 'passkey' ? 'On: you unlock with Face ID.' : kind === 'pin' ? 'On: you unlock with a 6-digit PIN.' : 'Off. You unlock with your password.';
      $('quick-off').hidden = !kind;
      $('quick-face').textContent = kind === 'passkey' ? 'Set up Face ID again' : 'Use Face ID';
      $('quick-pin-btn').textContent = kind === 'pin' ? 'Change PIN' : 'Use a 6-digit PIN';
    });
  }
  function quickBusy(on) { ['quick-face', 'quick-pin-btn', 'quick-off'].forEach(function (id) { $(id).disabled = on; }); }
  function quickPassword() {
    if (demo) { showFormError('quick-error', 'Not available in demo mode.'); return null; }
    var p = $('quick-pass').value;
    if (!p) { showFormError('quick-error', 'Enter your password first.'); $('quick-pass').focus(); return null; }
    return p;
  }
  function quickFailed(err) {
    console.warn(err);
    var msg = err && err.code === 'WRONG_PASSWORD' ? 'That password is wrong.'
      : err && err.code === 'NO_PRF' ? 'This iPhone can’t use Face ID for this app (it needs iOS 18 or newer with iCloud Keychain on). Use a 6-digit PIN instead.'
      : err && (err.name === 'NotAllowedError' || err.name === 'AbortError') ? 'Face ID was cancelled.'
      : (err && err.message) || 'Could not turn it on.';
    showFormError('quick-error', msg);
  }
  function onQuickFace() {
    showFormError('quick-error', '');
    var p = quickPassword(); if (!p) return;
    quickBusy(true);
    saving.then(function () { return Store.enablePasskey(p); }).then(function () {
      $('quick-pass').value = '';
      showFormError('quick-error', '');
    }).catch(quickFailed).then(function () { quickBusy(false); renderQuick(); });
  }
  function onQuickPin() {
    showFormError('quick-error', '');
    var field = $('quick-pin-field');
    if (field.hidden) { field.hidden = false; $('quick-pin').focus(); $('quick-pin-btn').textContent = 'Save PIN'; return; }
    var pin = $('quick-pin').value;
    if (!/^\d{6}$/.test(pin)) { showFormError('quick-error', 'The PIN must be 6 digits.'); return; }
    if (/^(\d)\1{5}$/.test(pin) || '0123456789'.indexOf(pin) !== -1 || '9876543210'.indexOf(pin) !== -1) { showFormError('quick-error', 'Pick a PIN that is harder to guess than ' + pin + '.'); return; }
    var p = quickPassword(); if (!p) return;
    quickBusy(true);
    saving.then(function () { return Store.enablePin(p, pin); }).then(function () {
      $('quick-pass').value = ''; $('quick-pin').value = ''; field.hidden = true;
    }).catch(quickFailed).then(function () { quickBusy(false); renderQuick(); });
  }
  function onQuickOff() {
    Store.disableQuick().then(renderQuick);
  }

  function startDemo() {
    demo = true;
    data = Core.emptyData();
    Core.importTexts(data, window.FinDemo.demoTexts(new Date())).then(function () {
      data.salary = {
        items: [
          { id: 1, label: 'Basic salary', type: 'earning', amount: 1400000 },
          { id: 2, label: 'Housing allowance', type: 'earning', amount: 350000 },
          { id: 3, label: 'Transport allowance', type: 'earning', amount: 120000 },
          { id: 4, label: 'GOSI', type: 'deduction', amount: 170625 }
        ], updated_at: new Date().toISOString()
      };
      enterApp();
    });
  }

  // Locking drops the key and data from memory by reloading the page.
  function lock() {
    session = null; data = null;
    saving.then(function () { window.location.replace(window.location.pathname + window.location.search); });
  }

  // ---------- auto-lock ----------
  var lastActive = Date.now(), hiddenAt = null, idleTimer = null;
  function touch() { lastActive = Date.now(); }
  function startAutoLock() {
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, touch, { passive: true }); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 60000 && !demo) lock();
      hiddenAt = null;
    });
    window.addEventListener('pagehide', function () { hiddenAt = hiddenAt || Date.now(); });
    idleTimer = setInterval(function () {
      if (!demo && session && Date.now() - lastActive > settings.autolock * 60000) lock();
    }, 15000);
  }

  // ---------- app ----------
  function enterApp() {
    screen('app');
    $('demo-badge').hidden = !demo;
    $('demo-banner').hidden = !demo;
    $('lock-now').hidden = demo;
    state.month = currentMonth();
    startAutoLock();
    renderAll();
    showView();
  }

  function applyPrivacy() {
    var on = !!settings.hideAmounts, b = $('eye-btn');
    document.body.classList.toggle('privacy', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.setAttribute('aria-label', on ? 'Show amounts' : 'Hide amounts');
    b.title = on ? 'Show amounts' : 'Hide amounts';
  }
  function togglePrivacy() {
    settings.hideAmounts = !settings.hideAmounts;
    saveSettings();
    applyPrivacy();
    if (!data) return;
    renderAll();
    if (salaryState.loaded) loadSalary(true);
  }

  function renderAll() {
    applyPrivacy();
    buildMonthOptions();
    updateMonthSteps();
    renderMonth();
    renderSubscriptions();
    renderImportStatus();
    renderShopsBanner();
    renderBackupStatus();
    renderPlan();
    renderWallets();
    if (window.location.hash === '#salary') loadSalary(true);
  }

  // ---------- month picker ----------
  function buildMonthOptions() {
    var sel = $('month-select');
    clear(sel);
    var months = Core.monthsWithData(data);
    if (months.indexOf(currentMonth()) === -1) months.push(currentMonth());
    if (months.indexOf(state.month) === -1) state.month = currentMonth();
    months.sort().reverse().forEach(function (m) {
      var o = el('option', null, monthShort.format(parseMonth(m)) + ' ' + m.slice(0, 4));
      o.value = m;
      if (m === state.month) o.selected = true;
      sel.appendChild(o);
    });
  }

  function renderMonth() {
    renderSummary(Core.monthSummary(data, state.month));
    renderCategories(Core.categoryBreakdown(data, state.month));
    renderTrend();
    renderTransactions(true);
    renderPlanStrip();
  }

  // ---------- KPIs ----------
  var shortDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  function renderPeriodNote() {
    var r = Core.periodRange(data, state.month), note = $('period-note');
    note.hidden = !r.payday;
    if (r.payday) note.textContent = 'Pay month: ' + shortDay.format(new Date(r.start + 'T00:00:00Z')) + ' to ' + shortDay.format(new Date(r.end + 'T00:00:00Z')) + ' (from payday)';
  }

  function renderSummary(s) {
    renderPeriodNote();
    var income = num(s.income), spending = num(s.spending), net = num(s.net);
    $('kpi-income').textContent = money(income);
    $('kpi-salary').textContent = num(s.salary) > 0 ? 'Salary ' + money(s.salary) : 'No salary yet this month';
    $('kpi-spending').textContent = money(spending);
    $('kpi-spending-sub').textContent = income > 0 ? Math.round(spending / income * 100) + '% of income' : '';
    var netEl = $('kpi-net');
    netEl.textContent = money(net);
    netEl.className = 'kpi-value ' + (net >= 0 ? 'pos' : 'neg');
    $('kpi-net-sub').textContent = income > 0
      ? (net >= 0 ? 'Saved ' : 'Overspent by ') + Math.abs(Math.round(net / income * 100)) + '% of income'
      : 'Salary not in yet this month';
  }

  // ---------- trend chart ----------
  function renderTrend() {
    var host = $('trend-chart');
    if (!host || host.offsetParent === null) return;
    clear(host);
    var rows = Core.monthlyTrend(data, currentMonth(), 6);
    var tbody = $('trend-table').querySelector('tbody');
    clear(tbody);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', null, monthFmt.format(parseMonth(r.month))));
      tr.appendChild(el('td', null, money(r.income)));
      tr.appendChild(el('td', null, money(r.spending)));
      tbody.appendChild(tr);
    });
    if (!rows.some(function (r) { return r.income || r.spending; })) { host.appendChild(el('p', 'empty', 'No history yet. Add your bank texts to see it.')); return; }

    var W = Math.max(host.clientWidth, 280), H = host.clientHeight || 220;
    var padL = 50, padR = 8, padT = 10, padB = 26;
    var max = rows.reduce(function (m, r) { return Math.max(m, num(r.income), num(r.spending)); }, 0) || 1;
    var step = niceStep(max / 4);
    var top = Math.ceil(max / step) * step;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var groupW = plotW / rows.length;
    var barW = Math.min(24, groupW * 0.32);
    var y = function (v) { return padT + plotH - (num(v) / top) * plotH; };

    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    for (var v = 0; v <= top + 0.001; v += step) {
      s.appendChild(svg('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: 'grid-line' }));
      var t = svg('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' });
      t.textContent = settings.hideAmounts ? '••' : sarShort.format(v).replace('SAR', '').trim();
      s.appendChild(t);
    }
    var tip = el('div', 'tooltip'); tip.hidden = true;
    rows.forEach(function (r, i) {
      var cx = padL + groupW * i + groupW / 2;
      var g = svg('g', { class: 'bar-group' + (r.month === state.month ? ' is-active' : '') });
      g.appendChild(svg('rect', { x: cx - groupW / 2, y: padT, width: groupW, height: plotH, class: 'hit' }));
      g.appendChild(svg('rect', { x: cx - barW - 2, y: y(r.income), width: barW, height: Math.max(0, y(0) - y(r.income)), rx: 4, class: 'bar-income' }));
      g.appendChild(svg('rect', { x: cx + 2, y: y(r.spending), width: barW, height: Math.max(0, y(0) - y(r.spending)), rx: 4, class: 'bar-spend' }));
      var lbl = svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' });
      lbl.textContent = monthShort.format(parseMonth(r.month));
      g.appendChild(lbl);
      g.addEventListener('click', function () {
        tip.textContent = monthFmt.format(parseMonth(r.month)) + ' · In ' + money(r.income) + ' · Out ' + money(r.spending);
        tip.style.left = Math.min(Math.max(cx, 120), W - 120) + 'px';
        tip.style.top = '0px';
        tip.hidden = false;
        selectMonth(r.month);
      });
      s.appendChild(g);
    });
    host.appendChild(s);
    host.appendChild(tip);
  }
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  // ---------- categories ----------
  function renderCategories(list) {
    var ul = $('category-list');
    clear(ul);
    var rows = list.filter(function (c) { return num(c.amount) > 0 && c.category !== 'transfer'; });
    var total = rows.reduce(function (a, c) { return a + num(c.amount); }, 0);
    if (!rows.length) { ul.appendChild(el('li', 'empty', 'No spending this month.')); return; }
    var max = num(rows[0].amount);
    rows.forEach(function (c) {
      var li = el('li');
      li.appendChild(el('span', 'bar-name', catLabel(c.category)));
      var amt = el('span', 'bar-amt', money(c.amount));
      amt.appendChild(el('small', null, Math.round(num(c.amount) / total * 100) + '%'));
      li.appendChild(amt);
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = (num(c.amount) / max * 100).toFixed(1) + '%';
      track.appendChild(fill);
      li.appendChild(track);
      ul.appendChild(li);
    });
  }

  // ---------- subscriptions ----------
  function renderSubscriptions() {
    var subs = Core.subscriptionsOut(data);
    var active = subs.filter(function (s) { return s.kind === 'subscription'; });
    var monthlyTotal = active.reduce(function (a, s) { return a + num(s.monthly_equivalent); }, 0);
    var possible = active.filter(function (s) { return s.status === 'suspected'; }).length;
    $('kpi-subs').textContent = money(monthlyTotal);
    $('kpi-subs-sub').textContent = 'Per month · ' + (active.length - possible) + ' active' + (possible ? ', ' + possible + ' possible' : '');
    $('subs-total').textContent = money(monthlyTotal * 12) + ' / year';

    var ul = $('subs-list');
    clear(ul);
    if (!subs.length) { ul.appendChild(el('li', 'empty', 'No subscriptions detected yet.')); return; }
    subs.forEach(function (s) {
      var li = el('li');
      var btn = el('button', 'sub-btn');
      btn.type = 'button';
      btn.setAttribute('aria-label', s.name + ', ' + money(s.amount) + ' ' + cycleLabel(s.cycle).toLowerCase() + '. Change');
      var left = el('div');
      var name = el('div', 'sub-name', s.name);
      if (s.status === 'suspected') name.appendChild(el('span', 'pill pill-suspected', 'Possible'));
      if (s.kind === 'recurring') name.appendChild(el('span', 'pill pill-recurring', 'Bill'));
      left.appendChild(name);
      left.appendChild(el('div', 'sub-meta', catLabel(s.category) + ' · ' + cycleLabel(s.cycle)));
      var right = el('div', 'sub-right');
      right.appendChild(el('div', null, money(s.amount)));
      var d = s.next_renewal ? daysUntil(s.next_renewal) : null;
      var when = d === null ? 'Renewal unknown'
        : d === 0 ? 'Renews today'
        : d === 1 ? 'Renews tomorrow'
        : d > 0 ? 'Renews ' + dayFmt.format(parseDate(s.next_renewal)) + ' (' + d + ' days)'
        : 'Was due ' + dayYearFmt.format(parseDate(s.next_renewal));
      right.appendChild(el('div', 'sub-meta' + (d !== null && d >= 0 && d <= 7 ? ' sub-soon' : ''), when));
      btn.appendChild(left); btn.appendChild(right);
      btn.addEventListener('click', function () { openSub(s); });
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  var subOpen = null;
  function openSub(s) {
    subOpen = s;
    $('dlg-sub-title').textContent = s.name;
    $('dlg-sub-meta').textContent = money(s.amount) + ' · ' + cycleLabel(s.cycle) + ' · seen ' + s.occurrences + ' time' + (s.occurrences === 1 ? '' : 's') + ' · last ' + dayYearFmt.format(parseDate(s.last_charged));
    openDialog('dlg-sub');
  }
  function onSubStatus(status) {
    if (!subOpen) return;
    try { Core.setSubscriptionStatus(data, subOpen.id, status); } catch (e) { showError('Could not change that.'); }
    closeDialog('dlg-sub');
    persist();
    renderSubscriptions(); renderMonth();
  }

  // ---------- transactions ----------
  function buildCategoryFilter(list) {
    var sel = $('tx-category');
    var keep = sel.value;
    var cats = {};
    list.forEach(function (t) { cats[t.category] = true; });
    while (sel.options.length > 1) sel.remove(1);
    Object.keys(cats).sort(function (a, b) { return catLabel(a) < catLabel(b) ? -1 : 1; }).forEach(function (c) { var o = el('option', null, catLabel(c)); o.value = c; sel.appendChild(o); });
    sel.value = cats[keep] ? keep : '';
  }

  function renderTransactions(rebuildFilter) {
    var all = Core.transactionsOut(data, state.month);
    if (rebuildFilter) buildCategoryFilter(all);
    var body = $('tx-body');
    clear(body);
    var qText = $('tx-search').value.trim().toLowerCase();
    var type = $('tx-type').value;
    var cat = $('tx-category').value;
    var rows = all.filter(function (t) {
      if (type && t.type !== type) return false;
      if (cat && t.category !== cat) return false;
      if (qText && ((t.merchant || '') + ' ' + (t.description || '')).toLowerCase().indexOf(qText) === -1) return false;
      return true;
    }).sort(function (a, b) {
      var ka = (a.datetime || a.date), kb = (b.datetime || b.date);
      return ka < kb ? 1 : ka > kb ? -1 : b.id - a.id;
    });
    rows.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', 'tx-date', dayFmt.format(parseDate(t.date))));
      var m = el('td', 'tx-main');
      var open = el('button', 'tx-open');
      open.type = 'button';
      var mer = el('span', 'tx-merchant', t.merchant || t.description || 'Unknown');
      if (t.account) mer.insertBefore(walletBadge(t.account, 'sm'), mer.firstChild);
      open.appendChild(mer);
      var desc = [t.account ? walletNames[t.account] : null, t.link ? 'between your accounts' : (t.description !== t.merchant ? t.description : null)].filter(Boolean).join(' · ');
      if (desc) open.appendChild(el('span', 'tx-desc', desc));
      open.addEventListener('click', function () { openTx(t.id); });
      m.appendChild(open);
      tr.appendChild(m);
      var c = el('td', 'tx-cat');
      c.appendChild(categorySelect(t));
      tr.appendChild(c);
      var amt = num(t.amount);
      var label = (amt > 0 ? '+' : '') + money(amt);
      var a = el('td', 'num ' + (t.type === 'transfer' ? 'muted' : amt >= 0 ? 'pos' : ''), label);
      if (t.original_currency) a.appendChild(el('span', 'tx-desc', t.original_currency + ' ' + (settings.hideAmounts ? '••••' : num(t.original_amount).toFixed(2))));
      tr.appendChild(a);
      body.appendChild(tr);
    });
    $('tx-empty').hidden = rows.length > 0;
    $('tx-empty').textContent = all.length ? 'No transactions match.' : 'No transactions this month.';
    $('tx-count').textContent = rows.length + ' of ' + all.length + ' transactions';
  }

  function fillCategoryOptions(sel, current) {
    clear(sel);
    Core.CATEGORIES.forEach(function (c) { var o = el('option', null, c.label); o.value = c.id; if (c.id === current) o.selected = true; sel.appendChild(o); });
  }

  function categorySelect(t) {
    var sel = el('select');
    sel.setAttribute('aria-label', 'Category for ' + (t.merchant || t.description || 'transaction'));
    fillCategoryOptions(sel, t.category);
    sel.addEventListener('change', function () { changeCategory(t.id, sel.value, false); });
    return sel;
  }

  function changeCategory(id, category, remember) {
    try { Core.recategorize(data, id, category, remember); } catch (e) { showError('Could not change that category.'); return; }
    persist();
    renderMonth(); renderSubscriptions();
    if (salaryState.loaded) loadSalary(true);
  }

  var txOpen = null;
  function openTx(id) {
    var t = data.transactions.find(function (x) { return x.id === id; });
    if (!t) return;
    txOpen = t;
    $('dlg-tx-title').textContent = t.merchant || t.description || 'Transaction';
    var amt = Core.toSar(t.amount);
    $('dlg-tx-amount').textContent = (amt > 0 ? '+' : '') + money(amt);
    var meta = [dayYearFmt.format(parseDate(t.date))];
    if (t.datetime && t.datetime.length > 15) meta.push(t.datetime.slice(11, 16));
    if (t.account) meta.push(walletNames[t.account]);
    if (t.card_last4) meta.push('card ··' + t.card_last4);
    if (t.link) meta.push('Moved between your own accounts (counted once)');
    if (t.original_currency) meta.push(t.original_currency + ' ' + (settings.hideAmounts ? '••••' : Core.toSar(t.original_amount).toFixed(2)) + ' (SAR amount estimated)');
    $('dlg-tx-meta').textContent = meta.join(' · ');
    fillCategoryOptions($('dlg-tx-cat'), t.category);
    $('dlg-tx-remember').checked = false;
    $('dlg-tx-raw').textContent = t.raw || '(not kept)';
    openDialog('dlg-tx');
  }

  // ---------- adding texts ----------
  function renderImportStatus() {
    var last = data.meta && data.meta.last_import_at;
    $('last-import').textContent = last ? 'Last added ' + stampFmt.format(new Date(last)) : 'No texts added yet.';
    $('tx-total').textContent = data.transactions.length + ' transactions saved on this phone.';
  }

  // ---------- shops that need a category ----------
  function renderShopsBanner() {
    var n = Core.unknownShops(data).length, b = $('shops-btn');
    b.hidden = n === 0;
    b.textContent = n === 1 ? '1 shop needs your pick' : n + ' shops need your pick';
  }

  function openShops() {
    var shops = Core.unknownShops(data).slice(0, 30), list = $('shops-list');
    if (!shops.length) return;
    clear(list);
    shops.forEach(function (s) {
      var li = el('li');
      var name = el('div', 'shop-name', s.merchant); name.setAttribute('dir', 'auto');
      li.appendChild(name);
      li.appendChild(el('div', 'muted small', s.count + (s.count === 1 ? ' purchase' : ' purchases') + ' · ' + money(-num(-s.total)).replace('-', '') + ' · last ' + s.last_date));
      var sel = el('select');
      sel.setAttribute('aria-label', 'Category for ' + s.merchant);
      sel.dataset.tx = s.tx_id;
      var o = el('option', null, 'Choose…'); o.value = ''; sel.appendChild(o);
      Core.CATEGORIES.forEach(function (cat) {
        if (cat.kind !== 'spending' && cat.id !== 'transfer') return;
        var opt = el('option', null, cat.id === 'other' ? 'Other (don’t ask again)' : cat.label); opt.value = cat.id; sel.appendChild(opt);
      });
      li.appendChild(sel);
      list.appendChild(li);
    });
    openDialog('dlg-shops');
  }

  function saveShops() {
    var picks = Array.prototype.slice.call($('shops-list').querySelectorAll('select')).filter(function (s) { return s.value; });
    closeDialog('dlg-shops');
    if (!picks.length) return;
    try {
      picks.forEach(function (s) { Core.recategorize(data, Number(s.dataset.tx), s.value, true); });
    } catch (e) { showError('Could not save those categories.'); }
    persist();
    renderAll();
    if (salaryState.loaded) loadSalary(true);
  }

  function addTexts(text) {
    var box = $('import-result');
    if (!text || !text.trim()) { box.textContent = 'There was no text to add. Run the “Bank texts” shortcut first, or copy a text from Messages.'; box.dataset.tone = 'warn'; box.hidden = false; return Promise.resolve(null); }
    if (text.length > 2000000) { box.textContent = 'That is too much text at once. Add it in smaller parts.'; box.dataset.tone = 'warn'; box.hidden = false; return Promise.resolve(null); }
    return Core.importTexts(data, text).then(function (r) {
      var parts = [];
      parts.push(r.inserted ? 'Added ' + r.inserted + ' transaction' + (r.inserted === 1 ? '' : 's') + '.' : 'Nothing new added.');
      if (r.duplicates) parts.push(r.duplicates + ' already added.');
      if (r.ignored) parts.push(r.ignored + ' text' + (r.ignored === 1 ? " wasn't a transaction" : "s weren't transactions") + ' (codes, offers).');
      if (r.skipped) parts.push(r.skipped + ' could not be read.');
      box.textContent = parts.join(' ');
      box.dataset.tone = r.inserted ? 'good' : '';
      box.hidden = false;
      if (r.unread && !r.inserted) persist();
      if (r.inserted) {
        // Jump to the month of the newest transaction added.
        state.month = currentMonth();
        persist();
        renderAll();
      }
      return r;
    });
  }

  // Texts found on the clipboard at unlock: add them quietly, report only when something is new.
  var BANK_HINT = /##SMS##|##WALLET:|بـ|مبلغ|سحب|القسط/;
  function autoImport(text) {
    if (!text || !BANK_HINT.test(text) || text.length > 2000000) return;
    Core.importTexts(data, text).then(function (r) {
      if (r.wallet_texts) markWalletDone();
      if (r.unread) persist();
      if (!r.inserted) return;
      var box = $('import-result');
      box.textContent = 'Added ' + r.inserted + ' new transaction' + (r.inserted === 1 ? '' : 's') + ' from your bank texts.';
      box.dataset.tone = 'good'; box.hidden = false;
      persist(); renderAll();
    });
  }

  function onPaste() {
    var box = $('import-result');
    if (!navigator.clipboard || !navigator.clipboard.readText) { openType(); return; }
    navigator.clipboard.readText().then(function (text) {
      return addTexts(text).then(function (r) {
        // Don't leave bank texts sitting on the clipboard.
        if (r && r.wallet_texts) markWalletDone();
        else if (r && (r.inserted || r.duplicates) && navigator.clipboard.writeText) navigator.clipboard.writeText('').catch(function () {});
      });
    }).catch(function (err) {
      console.warn(err);
      box.textContent = "Couldn't read the clipboard. Tap Paste when your phone asks, or use Type… and paste there.";
      box.dataset.tone = 'warn';
      box.hidden = false;
    });
  }

  // ---------- statement PDF ----------
  var dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' });
  function fmtDay(d) { return dayFmt.format(new Date(d + 'T12:00:00+03:00')); }
  function onStatementFile() {
    var file = $('stmt-file').files && $('stmt-file').files[0];
    $('stmt-file').value = '';
    if (!file) return;
    var box = $('import-result');
    box.textContent = 'Reading the statement…'; box.dataset.tone = ''; box.hidden = false;
    $('stmt-btn').disabled = true;
    window.FinStatement.read(file).then(function (items) {
      var rows = Core.statementRows(items);
      if (!rows.length) {
        box.textContent = "Couldn't find transactions in that PDF. Use the account statement (كشف حساب) from the Al Rajhi app.";
        box.dataset.tone = 'warn'; return;
      }
      var r = Core.importStatement(data, rows);
      var parts = [r.inserted ? 'Added ' + r.inserted + ' transaction' + (r.inserted === 1 ? '' : 's') + ' from the statement' + (r.from ? ' (' + fmtDay(r.from) + ' to ' + fmtDay(r.to) + ').' : '.') : 'Nothing new in that statement.'];
      if (r.matched) parts.push(r.matched + ' were already added from your texts.');
      if (r.duplicates) parts.push(r.duplicates + ' already imported.');
      if (r.skipped) parts.push(r.skipped + ' could not be read.');
      if (r.inserted) parts.push('Use ‹ at the top to see earlier months.');
      box.textContent = parts.join(' ');
      box.dataset.tone = r.inserted ? 'good' : '';
      if (r.inserted) { persist(); renderAll(); }
    }).catch(function (err) {
      console.warn(err);
      box.textContent = err && err.code === 'PASSWORD' ? 'That PDF is password-protected. Save it without a password and try again.' : "Couldn't read that file. Pick the statement PDF from Files.";
      box.dataset.tone = 'warn';
    }).then(function () { $('stmt-btn').disabled = false; box.hidden = false; });
  }

  function openType() { $('type-text').value = ''; openDialog('dlg-type'); setTimeout(function () { $('type-text').focus(); }, 50); }

  // ---------- backup ----------
  var backupUrl = null, backupFile = null;
  function renderBackupStatus() {
    var last = data.meta && data.meta.last_backup_at;
    $('bk-status').textContent = demo ? 'Backups are off in demo mode.' : last ? 'Last backup ' + stampFmt.format(new Date(last)) : 'No backup yet.';
    // Quiet reminder: only when transactions were added since the last backup and it's been a few days.
    var lastTx = data.meta && data.meta.last_import_at;
    var changed = data.transactions.length > 0 && (!last || (lastTx && lastTx > last));
    var days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
    var due = !demo && changed && (!last || days >= 3);
    $('backup-banner').hidden = true;
    $('backup-pill').hidden = !due;
    $('backup-pill').textContent = !last ? 'Back up your data' : 'Back up · last one ' + days + ' days ago';
    $('backup-btn').disabled = demo;
    $('restore-btn').disabled = demo;
  }

  function onBackup() {
    if (demo) return;
    var stampNow = new Date().toISOString();
    var prev = data.meta.last_backup_at;
    data.meta.last_backup_at = stampNow;
    Store.backup(session, data).then(function (json) {
      if (backupUrl) URL.revokeObjectURL(backupUrl);
      var name = 'My Finances backup.json';
      var blob = new Blob([json], { type: 'application/json' });
      backupFile = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
      backupUrl = URL.createObjectURL(blob);
      var a = $('backup-download');
      a.href = backupUrl; a.download = name;
      var canShare = !!(backupFile && navigator.canShare && navigator.canShare({ files: [backupFile] }));
      $('backup-share').hidden = !canShare;
      a.className = canShare ? 'btn-outline' : 'btn';
      a.textContent = canShare ? 'Download instead' : 'Download backup file';
      persist();
      renderBackupStatus();
      openDialog('dlg-backup');
    }).catch(function (err) {
      data.meta.last_backup_at = prev;
      console.error(err);
      showError('Could not make a backup.');
    });
  }

  function onShareBackup() {
    if (!backupFile) return;
    navigator.share({ files: [backupFile], title: 'Finances backup' }).then(function () { closeDialog('dlg-backup'); }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      showError('Sharing failed. Use “Download instead”.');
    });
  }

  var restoreFromSetup = false;
  function openRestore(fromSetup) {
    restoreFromSetup = !!fromSetup;
    $('restore-file').value = ''; $('restore-pass').value = '';
    showFormError('restore-error', '');
    $('restore-warn').textContent = fromSetup
      ? 'The backup’s password becomes this app’s password.'
      : 'This replaces everything currently in the app with the backup.';
    openDialog('dlg-restore');
  }

  function onRestore(e) {
    e.preventDefault();
    var file = $('restore-file').files && $('restore-file').files[0];
    var pass = $('restore-pass').value;
    if (!file) { showFormError('restore-error', 'Choose the backup file.'); return; }
    if (file.size > 50 * 1024 * 1024) { showFormError('restore-error', 'That file is too big to be a backup.'); return; }
    if (!pass) { showFormError('restore-error', 'Enter the backup’s password.'); return; }
    var btn = $('restore-go');
    btn.disabled = true; btn.textContent = 'Restoring…';
    file.text().then(function (text) { return Store.readBackup(text, pass); }).then(function (restored) {
      restored = Core.validateData(restored);
      if (restoreFromSetup) {
        return Store.create(pass, restored).then(function (s) { session = s; data = restored; Store.persist(); closeDialog('dlg-restore'); enterApp(); });
      }
      data = restored;
      return persist().then(function () { closeDialog('dlg-restore'); renderAll(); showView(); });
    }).catch(function (err) {
      showFormError('restore-error', err && err.code === 'WRONG_PASSWORD' ? 'Wrong password for this backup.' : (err && err.message) || 'Could not restore.');
    }).then(function () { btn.disabled = false; btn.textContent = 'Restore'; $('restore-pass').value = ''; });
  }

  // ---------- password / wipe ----------
  function onChangePassword(e) {
    e.preventDefault();
    if (demo) { showFormError('pw-error', 'Not available in demo mode.'); return; }
    var o = $('pw-old').value, n = $('pw-new').value, n2 = $('pw-new2').value;
    var bad = !o ? 'Enter your current password.' : passwordProblem(n, n2);
    if (bad) { showFormError('pw-error', bad); return; }
    showFormError('pw-error', '');
    var btn = $('pw-btn');
    btn.disabled = true; $('pw-done').textContent = 'Changing…';
    saving.then(function () { return Store.changePassword(o, n, data); }).then(function (s) {
      session = s;
      $('pw-done').textContent = 'Password changed. Old backups still need the old password, so make a new backup. Quick unlock was turned off: turn it on again above.';
      renderQuick();
    }).catch(function (err) {
      $('pw-done').textContent = '';
      showFormError('pw-error', err && err.code === 'WRONG_PASSWORD' ? 'Current password is wrong.' : 'Could not change the password.');
    }).then(function () { btn.disabled = false; $('pw-old').value = ''; $('pw-new').value = ''; $('pw-new2').value = ''; });
  }

  function onWipe(e) {
    e.preventDefault();
    if ($('wipe-confirm').value.trim().toUpperCase() !== 'DELETE') return;
    $('wipe-go').disabled = true;
    session = null; data = null;
    Store.wipe().then(function () {
      try { sessionStorage.clear(); } catch (err) { /* ignore */ }
      window.location.replace(window.location.pathname);
    }).catch(function () { showError('Could not delete. Close the app and try again.'); });
  }

  // ---------- salary (same as the laptop version) ----------
  var GOSI_RATE = 0.0975, GOSI_WAGE_CAP = 45000, MAX_ITEMS = 30;
  var salaryState = { loaded: false, detected: [] };
  var DEFAULT_ITEMS = [
    { label: 'Basic salary', type: 'earning', amount: '' },
    { label: 'Housing allowance', type: 'earning', amount: '' },
    { label: 'Transport allowance', type: 'earning', amount: '' },
    { label: 'GOSI', type: 'deduction', amount: '' }
  ];

  function payRow(item) {
    var li = el('li');
    li.dataset.type = item.type;
    var label = el('input');
    label.type = 'text'; label.maxLength = 60; label.value = item.label || '';
    label.placeholder = item.type === 'deduction' ? 'e.g. Loan installment' : 'e.g. Other allowance';
    label.setAttribute('aria-label', item.type === 'deduction' ? 'Deduction name' : 'Earning name');
    label.className = 'pay-label';
    var amt = el('input');
    amt.type = 'number'; amt.min = '0'; amt.step = '0.01'; amt.inputMode = 'decimal';
    amt.placeholder = '0.00'; amt.className = 'pay-amount';
    amt.value = item.amount === '' || item.amount === undefined ? '' : String(item.amount);
    amt.setAttribute('aria-label', 'Amount in SAR for ' + (item.label || 'this line'));
    label.addEventListener('input', function () { amt.setAttribute('aria-label', 'Amount in SAR for ' + (label.value || 'this line')); });
    var rm = el('button', 'icon-btn', '×');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Remove ' + (item.label || 'line'));
    rm.addEventListener('click', function () { li.remove(); updatePaySummary(); });
    [label, amt].forEach(function (i) { i.addEventListener('input', function () { i.removeAttribute('aria-invalid'); updatePaySummary(); }); });
    li.appendChild(label); li.appendChild(amt); li.appendChild(rm);
    return li;
  }
  function fillPayForm(items) {
    clear($('earning-rows')); clear($('deduction-rows'));
    items.forEach(function (it) { $(it.type === 'deduction' ? 'deduction-rows' : 'earning-rows').appendChild(payRow(it)); });
  }
  function readPayItems() {
    var items = [];
    document.querySelectorAll('.pay-rows li').forEach(function (li) {
      var label = li.querySelector('.pay-label').value.trim();
      var raw = li.querySelector('.pay-amount').value.trim();
      items.push({ li: li, label: label, type: li.dataset.type, raw: raw, amount: raw === '' ? 0 : Number(raw) });
    });
    return items;
  }
  function findAmount(items, re) {
    var it = items.find(function (x) { return x.type === 'earning' && re.test(x.label); });
    return it ? num(it.amount) : 0;
  }
  function latestDetected() {
    var rows = salaryState.detected.filter(function (d) { return num(d.amount) > 0; });
    return rows.length ? rows[rows.length - 1] : null;
  }
  function updatePaySummary() {
    var items = readPayItems();
    var gross = 0, ded = 0, any = false;
    items.forEach(function (it) {
      if (!isFinite(it.amount) || it.amount < 0) return;
      if (it.raw !== '') any = true;
      if (it.type === 'deduction') ded += it.amount; else gross += it.amount;
    });
    var expected = Math.round((gross - ded) * 100) / 100;
    $('pay-gross').textContent = any ? money(gross) : '–';
    $('pay-deductions').textContent = any ? (ded ? '−' + money(ded) : money(0)) : '–';
    $('pay-expected').textContent = any ? money(expected) : '–';
    var last = latestDetected();
    $('pay-received-label').textContent = last ? 'Received in ' + monthFmt.format(parseMonth(last.month)) : 'Received from Al Rajhi';
    $('pay-received').textContent = last ? money(last.amount) : 'Not detected yet';
    var v = $('pay-verdict');
    if (!any) { v.textContent = 'Fill in your payslip to compare it with what reaches your account.'; v.dataset.tone = ''; }
    else if (!last) { v.textContent = 'No salary deposit has been detected yet. The comparison appears after your next salary text.'; v.dataset.tone = ''; }
    else {
      var diff = Math.round((num(last.amount) - expected) * 100) / 100;
      if (Math.abs(diff) < 1) { v.textContent = 'Your salary matches your payslip.'; v.dataset.tone = 'good'; }
      else if (diff < 0) { v.textContent = 'You received ' + money(-diff) + ' less than expected. Check for a new deduction or an unpaid allowance.'; v.dataset.tone = 'warn'; }
      else { v.textContent = 'You received ' + money(diff) + ' more than expected, for example a bonus or overtime.'; v.dataset.tone = 'good'; }
    }
    var body = $('pay-history');
    clear(body);
    salaryState.detected.slice().reverse().forEach(function (d) {
      var tr = el('tr');
      tr.appendChild(el('td', null, monthShort.format(parseMonth(d.month)) + ' ' + String(d.month).slice(0, 4)));
      var got = num(d.amount);
      tr.appendChild(el('td', 'num', got > 0 ? money(got) : 'None yet'));
      var diffTd = el('td', 'num');
      if (any && got > 0) {
        var df = Math.round((got - expected) * 100) / 100;
        diffTd.textContent = Math.abs(df) < 1 ? 'Matches' : (df > 0 ? '+' : '') + money(df);
        diffTd.className = 'num ' + (Math.abs(df) < 1 ? 'muted' : df > 0 ? 'pos' : 'neg');
      } else diffTd.textContent = '–';
      tr.appendChild(diffTd);
      body.appendChild(tr);
    });
  }
  function calcGosi() {
    var items = readPayItems();
    var wage = Math.min(findAmount(items, /basic/i) + findAmount(items, /housing/i), GOSI_WAGE_CAP);
    if (!wage) { showFormError('pay-error', 'Enter your basic salary (and housing allowance) first.'); return; }
    showFormError('pay-error', '');
    var gosi = items.find(function (x) { return x.type === 'deduction' && /gosi/i.test(x.label); });
    var value = (Math.round(wage * GOSI_RATE * 100) / 100).toFixed(2);
    if (gosi) gosi.li.querySelector('.pay-amount').value = value;
    else $('deduction-rows').appendChild(payRow({ label: 'GOSI', type: 'deduction', amount: value }));
    updatePaySummary();
  }
  function savePay(e) {
    e.preventDefault();
    var items = readPayItems().filter(function (it) { return it.label || it.raw; });
    var bad = null;
    items.forEach(function (it) {
      if (!it.label) { it.li.querySelector('.pay-label').setAttribute('aria-invalid', 'true'); bad = bad || 'Give every line a name.'; }
      if (!isFinite(it.amount) || it.amount < 0 || it.amount > 1000000) { it.li.querySelector('.pay-amount').setAttribute('aria-invalid', 'true'); bad = bad || 'Amounts must be between 0 and 1,000,000.'; }
    });
    if (!items.some(function (it) { return it.type === 'earning' && it.amount > 0; })) bad = bad || 'Enter at least one earning, such as your basic salary.';
    if (items.length > MAX_ITEMS) bad = bad || 'Keep it to ' + MAX_ITEMS + ' lines or fewer.';
    if (bad) { showFormError('pay-error', bad); return; }
    showFormError('pay-error', '');
    try {
      var view = Core.setSalaryProfile(data, items.map(function (it) { return { label: it.label.slice(0, 60), type: it.type, amount: Math.round(it.amount * 100) / 100 }; }));
      applySalary(view);
      persist().then(function () { $('pay-saved').textContent = 'Saved'; });
    } catch (err) { showFormError('pay-error', err.message || 'Could not save.'); }
  }
  function applySalary(res) {
    salaryState.detected = Array.isArray(res.detected) ? res.detected : [];
    var p = res.profile;
    fillPayForm(p && p.items && p.items.length ? p.items : DEFAULT_ITEMS);
    $('pay-updated').textContent = p && p.updated_at ? 'Updated ' + dayYearFmt.format(new Date(p.updated_at)) : 'Not set up yet';
    updatePaySummary();
  }
  function loadSalary(force) {
    if (salaryState.loaded && !force) return;
    salaryState.loaded = true;
    applySalary(Core.salaryView(data));
  }

  // ---------- plan ----------
  function whole(v) { return settings.hideAmounts ? MASK : sarWhole.format(Math.round(num(v))); }
  function utcDay(d) { return new Date(String(d).slice(0, 10) + 'T00:00:00Z'); }
  function planLabel(p) { return p.payday_mode ? 'until payday' : 'until month end'; }

  function renderPlanStrip() {
    var strip = $('plan-strip');
    if (!data || state.month !== currentMonth() || !data.transactions.length) { strip.hidden = true; return; }
    var p = Core.planView(data);
    strip.hidden = false;
    var amt = $('plan-strip-amount');
    if (num(p.income) <= 0) {
      $('plan-strip-label').textContent = 'Safe to spend';
      amt.textContent = 'After salary';
      amt.className = '';
      $('plan-strip-sub').textContent = '';
      return;
    }
    $('plan-strip-label').textContent = 'Safe to spend ' + planLabel(p);
    amt.textContent = p.safe < 0 ? whole(-p.safe) + ' over' : whole(p.safe);
    amt.className = p.safe < 0 ? 'neg' : '';
    $('plan-strip-sub').textContent = p.safe > 0 ? '· ' + whole(p.per_day) + '/day' : '';
  }

  function renderPlan() {
    if (!data) return;
    var p = Core.planView(data);
    var when = shortDay.format(utcDay(p.payday));
    $('plan-hero-label').textContent = 'Safe to spend ' + planLabel(p) + ' · ' + when;
    var safeEl = $('plan-safe'), perDay = $('plan-perday');
    if (num(p.income) <= 0) {
      safeEl.textContent = '–';
      perDay.textContent = 'Shows once this month’s salary is in.';
    } else if (p.safe < 0) {
      safeEl.textContent = whole(-p.safe) + ' over';
      perDay.textContent = 'Spending and bills are more than this month’s income.';
    } else {
      safeEl.textContent = whole(p.safe);
      perDay.textContent = '';
      perDay.appendChild(document.createTextNode('About '));
      perDay.appendChild(el('b', null, whole(p.per_day) + ' a day'));
      perDay.appendChild(document.createTextNode(' for the next ' + p.days_left + (p.days_left === 1 ? ' day' : ' days')));
    }
    $('plan-bar-fill').style.width = Math.min(100, p.day / p.total_days * 100).toFixed(1) + '%';
    $('plan-day').textContent = 'Day ' + p.day + ' of ' + p.total_days;
    $('plan-pace').textContent = { on_track: 'On track', fast: 'Spending faster than usual', over: 'Over', no_income: '' }[p.pace] || '';
    $('plan-income').textContent = whole(p.income);
    $('plan-spent').textContent = whole(num(p.spent) + num(p.sent));
    $('plan-left').textContent = whole(p.bills_left);
    var sent = $('plan-sent');
    sent.hidden = !(num(p.sent) > 0);
    sent.textContent = 'Spent so far includes ' + whole(p.sent) + ' sent to people by transfer.';

    var ul = $('plan-bills');
    clear(ul);
    $('plan-bills-total').textContent = num(p.bills_left) > 0 ? whole(p.bills_left) + ' left' : '';
    if (!p.bills.length) ul.appendChild(el('li', 'empty', 'Nothing regular found yet. Bills show up here after they repeat twice.'));
    p.bills.forEach(function (b) {
      var li = el('li', b.paid ? 'is-paid' : null);
      var left = el('span', 'plan-name');
      left.appendChild(el('span', 'plan-when', shortDay.format(utcDay(b.date))));
      left.appendChild(document.createTextNode(b.name));
      li.appendChild(left);
      var right = el('span', 'plan-amt', b.paid ? 'Paid' : whole(b.amount));
      if (b.paid) right.appendChild(el('span', 'plan-tick', '✓'));
      else if (b.overdue) right.appendChild(el('span', 'plan-late', 'due'));
      li.appendChild(right);
      ul.appendChild(li);
    });

    var r = p.recap;
    $('plan-recap-title').textContent = p.payday_mode ? 'Last pay month' : 'Last month';
    $('plan-recap-range').textContent = shortDay.format(utcDay(r.start)) + ' – ' + shortDay.format(utcDay(r.end));
    $('plan-recap-body').hidden = !r.has_data;
    $('plan-recap-empty').hidden = r.has_data;
    if (!r.has_data) return;
    $('plan-recap-spent').textContent = whole(r.spent);
    var saved = $('plan-recap-saved');
    saved.textContent = num(r.saved) < 0 ? whole(-r.saved) + ' over' : whole(r.saved);
    saved.className = num(r.saved) < 0 ? 'neg' : 'pos';
    var rs = $('plan-recap-sent');
    rs.hidden = !(num(r.sent) > 0);
    rs.textContent = 'Saved is after ' + whole(r.sent) + ' sent to people by transfer.';
    var cats = $('plan-recap-cats');
    clear(cats);
    var max = r.top.length ? num(r.top[0].amount) : 1;
    r.top.forEach(function (c) {
      var li = el('li');
      var name = el('span', 'bar-name', catLabel(c.category));
      if (c.change > 0) name.appendChild(el('span', 'plan-up', '▲ ' + whole(c.change).replace('SAR', '').trim()));
      if (c.change < 0) name.appendChild(el('span', 'plan-down', '▼ ' + whole(-c.change).replace('SAR', '').trim()));
      li.appendChild(name);
      li.appendChild(el('span', 'bar-amt', whole(c.amount)));
      var track = el('div', 'bar-track'), fill = el('div', 'bar-fill');
      fill.style.width = (num(c.amount) / max * 100).toFixed(1) + '%';
      track.appendChild(fill);
      li.appendChild(track);
      cats.appendChild(li);
    });
  }

  // ---------- wallets & credit card ----------
  var walletNames = {};
  Core.WALLETS.forEach(function (w) { walletNames[w.id] = w.name; });
  var whenFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Riyadh' });
  function when(iso) { var d = new Date(iso); return isNaN(d) ? '' : whenFmt.format(d); }
  function parseSarInput(v) {
    var s = Core.normDigits(String(v || '')).replace(/[,\s]|SAR|SR|ر\.?س|ريال/gi, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return Number(s);
  }

  // Simple original badges: each wallet's colour plus its initials (no official logos).
  var BADGE = {
    stcpay: { bg: '#4F008C', fg: '#FFFFFF', top: 'stc', sub: 'pay' },
    d360: { bg: '#00695C', fg: '#FFFFFF', top: 'D', sub: '360' },
    urpay: { bg: '#D81B60', fg: '#FFFFFF', top: 'ur', sub: 'pay' },
    barq: { bg: '#FFB300', fg: '#1F2937', bolt: true },
    anb: { card: true }
  };
  var badgeSeq = 0;
  function txt(x, y, size, weight, fill, s, extra) {
    var t = svg('text', Object.assign({ x: x, y: y, 'font-size': size, 'font-weight': weight, fill: fill, 'text-anchor': 'middle', 'font-family': '-apple-system, system-ui, sans-serif' }, extra || {}));
    t.textContent = s;
    return t;
  }
  /** Badge for a wallet. size 'sm' (lists), 'md' (wallet rows) or 'lg' (wallet details). */
  function walletBadge(id, size) {
    var b = BADGE[id];
    if (!b) return el('span');
    var px = { sm: 22, md: 42, lg: 64 }[size || 'md'];
    var s;
    if (b.card) {
      // ANB Visa Signature, World Cup 26 edition: deep navy card, gold chip and stripe.
      var big = size === 'lg';
      var w = big ? 168 : 100, h = big ? 106 : 64;
      var gid = 'anbg' + (++badgeSeq);
      var cw = big ? 168 : size === 'sm' ? 30 : 56;
      s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, width: cw, height: Math.round(cw * h / w), role: 'img', 'aria-label': 'ANB Visa Signature card' });
      var defs = svg('defs'), lg = svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' });
      lg.appendChild(svg('stop', { offset: '0', 'stop-color': '#13294B' }));
      lg.appendChild(svg('stop', { offset: '1', 'stop-color': '#050B18' }));
      defs.appendChild(lg); s.appendChild(defs);
      s.appendChild(svg('rect', { x: 0, y: 0, width: w, height: h, rx: h * 0.12, fill: 'url(#' + gid + ')' }));
      s.appendChild(svg('path', { d: 'M' + (w * 0.58) + ' 0 L' + (w * 0.72) + ' 0 L' + (w * 0.42) + ' ' + h + ' L' + (w * 0.28) + ' ' + h + ' Z', fill: '#C9A227', opacity: '0.28' }));
      s.appendChild(svg('rect', { x: w * 0.09, y: h * 0.34, width: w * 0.16, height: h * 0.24, rx: h * 0.04, fill: '#D4AF37' }));
      s.appendChild(txt(w * 0.82, h * (big ? 0.5 : 0.3), h * 0.2, 800, '#E8C766', 'ANB'));
      if (big) {
        s.appendChild(txt(w * 0.09, h * 0.2, 8, 600, '#FFFFFF', 'WORLD CUP 26 EDITION', { 'text-anchor': 'start', opacity: '0.8', 'letter-spacing': '0.6' }));
        s.appendChild(txt(w * 0.09, h * 0.86, 9.5, 700, '#E8C766', 'VISA SIGNATURE', { 'text-anchor': 'start', 'letter-spacing': '1' }));
      } else {
        s.appendChild(txt(w * 0.88, h * 0.86, h * 0.17, 800, '#E8C766', 'VISA', { 'text-anchor': 'end', 'font-style': 'italic' }));
      }
    } else {
      s = svg('svg', { viewBox: '0 0 48 48', width: px, height: px, role: 'img', 'aria-label': (walletNames[id] || id) + ' badge' });
      s.appendChild(svg('rect', { x: 0, y: 0, width: 48, height: 48, rx: 12, fill: b.bg }));
      if (b.bolt) {
        s.appendChild(svg('path', { d: 'M27 6 L13 27 H23 L19 42 L35 19 H25 Z', fill: b.fg }));
      } else {
        s.appendChild(txt(24, b.top.length > 2 ? 26 : 28, b.top.length > 2 ? 17 : 22, 800, b.fg, b.top, { 'letter-spacing': '-0.5' }));
        s.appendChild(txt(24, 40, 10, 600, b.fg, b.sub, { opacity: '0.85', 'letter-spacing': '0.5' }));
      }
    }
    var wrap = el('span', 'wal-badge wal-badge-' + (size || 'md'));
    wrap.setAttribute('aria-hidden', 'true');
    wrap.appendChild(s);
    return wrap;
  }

  // The wallet automation empties wallet-texts.txt when it finds this on the clipboard, so texts the
  // app already has don't stay in a readable file. Clipboard writes need a tap, so this waits for one.
  var WALLET_DONE = '##WALLET-DONE##';
  var donePending = false;
  function writeDone() {
    if (!donePending || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(WALLET_DONE).then(function () { donePending = false; }, function () { /* try again on the next tap */ });
  }
  function markWalletDone() {
    if (demo) return;
    donePending = true;
    writeDone();
  }
  document.addEventListener('click', writeDone, true);

  function renderWallets() {
    if (!data) return;
    var v = Core.walletsView(data, currentMonth());
    var card = v.wallets.find(function (w) { return w.kind === 'card'; });
    var wallets = v.wallets.filter(function (w) { return w.kind === 'wallet'; });
    $('wal-total').textContent = wallets.some(function (w) { return w.known; }) ? money(v.total) : '–';
    $('wal-owed').textContent = card && card.known ? money(-card.balance) : '–';
    $('wal-hint').hidden = v.wallets.every(function (w) { return w.known; });
    var ul = $('wal-list');
    clear(ul);
    v.wallets.forEach(function (w) {
      var li = el('li');
      var b = el('button', 'wal-row wal-c-' + w.id);
      b.type = 'button';
      b.appendChild(walletBadge(w.id, 'md'));
      var left = el('span', 'wal-name');
      left.appendChild(el('b', null, w.name));
      if (w.kind === 'card') left.appendChild(el('small', 'wal-edition', 'Visa Signature · World Cup 26'));
      // The list shows only the name and balance; details are one tap away.
      if (!w.known) left.appendChild(el('small', 'muted', 'Tap to enter the balance once'));
      b.appendChild(left);
      var right = el('span', 'wal-amt' + (w.kind === 'card' ? ' wal-owe' : ''));
      if (!w.known) right.textContent = 'Set ›';
      else if (w.kind === 'card') {
        right.textContent = money(-w.balance);
      } else right.textContent = money(w.balance);
      b.appendChild(right);
      b.addEventListener('click', function () { openWallet(w.id); });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  var walletOpen = null;
  function openWallet(id) {
    var w = Core.walletsView(data, currentMonth()).wallets.find(function (x) { return x.id === id; });
    if (!w) return;
    walletOpen = id;
    var isCard = w.kind === 'card';
    $('dlg-wallet-title').textContent = w.name;
    var art = $('dlg-wallet-badge');
    clear(art);
    art.appendChild(walletBadge(id, 'lg'));
    art.className = 'wal-art wal-c-' + id;
    $('dlg-wallet-balance').textContent = w.known ? (isCard ? money(-w.balance) + ' owed' : money(w.balance)) : 'No balance yet';
    var meta = [];
    if (isCard && w.available !== null) meta.push(money(w.available) + ' available of ' + money(w.limit));
    if (w.known && w.updated) meta.push('Updated ' + when(w.updated));
    if (num(w.month_spent) > 0) meta.push(money(w.month_spent) + ' spent this month');
    if (num(w.month_in) > 0) meta.push(money(w.month_in) + ' received this month');
    // Entering the balance is a one-time step; afterwards it sits folded away for corrections.
    var edit = $('dlg-wallet-edit');
    edit.open = !w.known;
    $('dlg-wallet-save').hidden = !edit.open;
    $('dlg-wallet-meta').textContent = meta.join(' · ');
    $('dlg-wallet-amount-label').textContent = isCard ? 'Amount you owe now (SAR)' : 'Balance now (SAR)';
    $('dlg-wallet-amount').value = w.known ? String(isCard ? -w.balance : w.balance) : '';
    $('dlg-wallet-limit-field').hidden = !isCard;
    $('dlg-wallet-limit').value = w.limit ? String(w.limit) : '';
    showFormError('dlg-wallet-error', '');
    var ul = $('dlg-wallet-recent');
    clear(ul);
    if (!w.recent.length) ul.appendChild(el('li', 'empty', 'No texts from ' + w.name + ' yet.'));
    w.recent.forEach(function (t) {
      var li = el('li');
      var name = el('span', 'wal-name');
      name.appendChild(el('span', null, t.merchant || t.description || 'Transaction'));
      name.appendChild(el('small', 'muted', when(t.datetime || t.date) + ' · ' + (t.link ? 'Between your accounts' : catLabel(t.category))));
      li.appendChild(name);
      li.appendChild(el('span', 'wal-amt' + (t.amount > 0 ? ' pos' : ''), (t.amount > 0 ? '+' : '') + money(t.amount)));
      ul.appendChild(li);
    });
    var unread = data.wallet_unread.filter(function (u) { return u.wallet === id; });
    $('dlg-wallet-unread-box').hidden = !unread.length;
    $('dlg-wallet-unread-title').textContent = unread.length + ' text' + (unread.length === 1 ? '' : 's') + ' the app couldn’t read';
    $('dlg-wallet-unread').textContent = unread.map(function (u) { return u.text; }).join('\n\n———\n\n');
    $('dlg-wallet-text').value = '';
    openDialog('dlg-wallet');
  }

  function saveWallet(e) {
    e.preventDefault();
    if (!walletOpen) return;
    var isCard = walletOpen === 'anb';
    var amt = parseSarInput($('dlg-wallet-amount').value);
    if (amt === null) { showFormError('dlg-wallet-error', 'Enter the amount in SAR, for example 250 or 250.50.'); return; }
    var limit;
    if (isCard) {
      var lv = $('dlg-wallet-limit').value.trim();
      limit = lv ? parseSarInput(lv) : null;
      if (lv && limit === null) { showFormError('dlg-wallet-error', 'Enter the limit in SAR, or leave it empty.'); return; }
    }
    try { Core.setWalletStart(data, walletOpen, amt, isCard ? { limit: limit } : {}); } catch (err) { showFormError('dlg-wallet-error', err.message); return; }
    closeDialog('dlg-wallet');
    persist(); renderWallets();
  }

  function walletReport(r) {
    var box = $('wal-result');
    var parts = [r.inserted ? 'Added ' + r.inserted + ' transaction' + (r.inserted === 1 ? '' : 's') + '.' : 'Nothing new added.'];
    if (r.duplicates) parts.push(r.duplicates + ' already added.');
    if (r.unread) parts.push(r.unread + ' text' + (r.unread === 1 ? '' : 's') + ' couldn’t be read (open the wallet to see).');
    box.textContent = parts.join(' ');
    box.dataset.tone = r.inserted ? 'good' : '';
    box.hidden = false;
  }

  function addWalletText() {
    var text = $('dlg-wallet-text').value.trim();
    if (!text || !walletOpen) return;
    var tag = Core.WALLETS.find(function (w) { return w.id === walletOpen; }).tag;
    // A hand-pasted text gets the time now, like the automation would give it.
    var input = /##WALLET:/.test(text) ? text : '##WALLET:' + tag + '##\n' + text + '\n##AT## ' + new Date().toISOString();
    Core.importTexts(data, input).then(function (r) {
      closeDialog('dlg-wallet');
      walletReport(r);
      if (r.inserted || r.unread) { persist(); renderAll(); }
    });
  }

  function onWalletPaste() {
    if (!navigator.clipboard || !navigator.clipboard.readText) { showError('This browser can’t read the clipboard. Open a wallet and use “Add a text by hand”.'); return; }
    navigator.clipboard.readText().then(function (text) {
      if (!text || text.indexOf('##WALLET:') === -1) {
        var box = $('wal-result');
        box.textContent = 'No wallet texts on the clipboard. They are copied when a wallet text arrives; for an older one, open the wallet and use “Add a text by hand”.';
        box.dataset.tone = 'warn'; box.hidden = false;
        return;
      }
      return Core.importTexts(data, text).then(function (r) {
        walletReport(r);
        markWalletDone();
        if (r.inserted || r.unread) { persist(); renderAll(); }
      });
    }).catch(function () {
      var box = $('wal-result');
      box.textContent = 'Couldn’t read the clipboard. Tap Paste when your phone asks.';
      box.dataset.tone = 'warn'; box.hidden = false;
    });
  }

  // ---------- app version & updates ----------
  var APP_VERSION = '29'; // keep in step with VERSION in sw.js
  function showVersion() { $('app-version').textContent = APP_VERSION; $('footer-version').textContent = APP_VERSION; }
  // Fetch the newest app files: ask for a new offline worker, drop the old cached files, reload.
  // Reloading locks the app, so the data is saved first.
  function checkUpdate() {
    var btn = $('update-btn');
    btn.disabled = true;
    $('update-status').textContent = 'Checking…';
    var sw = navigator.serviceWorker && navigator.serviceWorker.getRegistration
      ? navigator.serviceWorker.getRegistration().then(function (r) { return r && r.update(); }).catch(function () {})
      : Promise.resolve();
    saving.then(function () { return sw; }).then(function () {
      return window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : null;
    }).catch(function () {}).then(function () {
      window.location.replace(window.location.pathname + '?u=' + Date.now() + '#settings');
    });
  }

  // ---------- views ----------
  function showView() {
    var h = window.location.hash;
    var view = h === '#salary' ? 'salary' : h === '#settings' ? 'settings' : h === '#plan' ? 'plan' : h === '#wallets' ? 'wallets' : 'overview';
    ['overview', 'plan', 'wallets', 'salary', 'settings'].forEach(function (v) {
      $('view-' + v).hidden = v !== view;
      if (v === view) $('tab-' + v).setAttribute('aria-current', 'page'); else $('tab-' + v).removeAttribute('aria-current');
    });
    $('month-select').closest('.month-picker').hidden = view !== 'overview';
    if (!data) return;
    if (view === 'salary') loadSalary();
    if (view === 'overview') renderTrend();
    if (view === 'plan') { renderPlan(); window.scrollTo(0, 0); }
    if (view === 'wallets') renderWallets();
    if (view === 'settings') {
      renderQuick();
      $('autolock').value = String(settings.autolock);
      $('autopaste').checked = settings.autoPaste;
      $('month-mode').value = Core.monthMode(data);
      Store.persisted().then(function (p) {
        $('persist-status').textContent = p
          ? 'This browser has agreed to keep the data (it won’t clear it to free space).'
          : 'Tip: add this page to your Home Screen. Safari can clear website data that isn’t opened for a while, and Home Screen apps are kept. Keep backups either way.';
      });
    }
    window.scrollTo(0, 0);
  }

  function selectMonth(m) {
    state.month = m;
    $('month-select').value = m;
    renderMonth();
    updateMonthSteps();
  }
  // ‹ › step through the months that have data (the list is newest first).
  function stepMonth(dir) {
    var opts = Array.prototype.map.call($('month-select').options, function (o) { return o.value; });
    var i = opts.indexOf(state.month) - dir;
    if (i >= 0 && i < opts.length) selectMonth(opts[i]);
  }
  function updateMonthSteps() {
    var opts = Array.prototype.map.call($('month-select').options, function (o) { return o.value; });
    var i = opts.indexOf(state.month);
    $('month-prev').disabled = i === -1 || i >= opts.length - 1;
    $('month-next').disabled = i <= 0;
  }

  // ---------- wiring ----------
  function init() {
    $('setup-form').addEventListener('submit', onSetup);
    $('lock-form').addEventListener('submit', onUnlock);
    $('setup-demo').addEventListener('click', startDemo);
    $('setup-restore').addEventListener('click', function () { openRestore(true); });
    $('lock-forgot').addEventListener('click', function () { $('wipe-confirm').value = ''; $('wipe-go').disabled = true; openDialog('dlg-wipe'); });
    $('lock-now').addEventListener('click', lock);
    $('update-btn').addEventListener('click', checkUpdate);
    showVersion();
    $('demo-exit').addEventListener('click', function () { window.location.replace(window.location.pathname); });

    $('paste-btn').addEventListener('click', onPaste);
    $('type-btn').addEventListener('click', openType);
    $('type-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = $('type-text').value;
      closeDialog('dlg-type');
      addTexts(text);
      $('type-text').value = '';
    });

    $('shops-btn').addEventListener('click', openShops);
    $('eye-btn').addEventListener('click', togglePrivacy);
    $('dlg-wallet-edit').addEventListener('toggle', function () { $('dlg-wallet-save').hidden = !$('dlg-wallet-edit').open; });
    $('wallet-form').addEventListener('submit', saveWallet);
    $('dlg-wallet-add').addEventListener('click', addWalletText);
    $('dlg-wallet-unread-clear').addEventListener('click', function () {
      if (!walletOpen) return;
      Core.clearWalletUnread(data, walletOpen);
      closeDialog('dlg-wallet'); persist(); renderWallets();
    });
    $('stmt-btn').addEventListener('click', function () { if (demo) return; $('stmt-file').click(); });
    $('stmt-file').addEventListener('change', onStatementFile);
    $('face-btn').addEventListener('click', onFace);
    $('lock-use-pass').addEventListener('click', function () { setLockMode('password', hasQuick); $('lock-pass').focus(); });
    $('quick-face').addEventListener('click', onQuickFace);
    $('quick-pin-btn').addEventListener('click', onQuickPin);
    $('quick-off').addEventListener('click', onQuickOff);
    $('shops-save').addEventListener('click', saveShops);
    $('dlg-tx-save').addEventListener('click', function () {
      if (!txOpen) return;
      var cat = $('dlg-tx-cat').value, remember = $('dlg-tx-remember').checked;
      closeDialog('dlg-tx');
      if (cat !== txOpen.category || remember) changeCategory(txOpen.id, cat, remember);
    });
    $('dlg-tx-delete').addEventListener('click', function () {
      if (!txOpen) return;
      if (!window.confirm('Delete this transaction? If you paste the same text again it will come back.')) return;
      Core.deleteTransaction(data, txOpen.id);
      closeDialog('dlg-tx');
      persist(); renderAll();
    });
    document.querySelectorAll('#dlg-sub [data-status]').forEach(function (b) {
      b.addEventListener('click', function () { onSubStatus(b.getAttribute('data-status')); });
    });
    document.querySelectorAll('dialog [data-close]').forEach(function (b) {
      b.addEventListener('click', function () { var d = b.closest('dialog'); if (d.close) d.close(); else d.removeAttribute('open'); });
    });

    $('backup-btn').addEventListener('click', onBackup);
    $('backup-banner-btn').addEventListener('click', onBackup);
    $('backup-pill').addEventListener('click', onBackup);
    $('backup-share').addEventListener('click', onShareBackup);
    $('restore-btn').addEventListener('click', function () { openRestore(false); });
    $('restore-form').addEventListener('submit', onRestore);
    $('pw-form').addEventListener('submit', onChangePassword);
    $('wipe-btn').addEventListener('click', function () { $('wipe-confirm').value = ''; $('wipe-go').disabled = true; openDialog('dlg-wipe'); });
    $('wipe-confirm').addEventListener('input', function () { $('wipe-go').disabled = $('wipe-confirm').value.trim().toUpperCase() !== 'DELETE'; });
    $('wipe-form').addEventListener('submit', onWipe);
    $('month-mode').addEventListener('change', function () {
      if (!data) return;
      data.meta.month_mode = $('month-mode').value;
      state.month = currentMonth();
      persist(); renderAll();
    });
    $('autopaste').addEventListener('change', function () { settings.autoPaste = $('autopaste').checked; saveSettings(); });
    $('autolock').addEventListener('change', function () { settings.autolock = Number($('autolock').value) || 5; saveSettings(); });

    $('add-earning').addEventListener('click', function () { $('earning-rows').appendChild(payRow({ label: '', type: 'earning', amount: '' })); });
    $('add-deduction').addEventListener('click', function () { $('deduction-rows').appendChild(payRow({ label: '', type: 'deduction', amount: '' })); });
    $('calc-gosi').addEventListener('click', calcGosi);
    $('pay-form').addEventListener('submit', savePay);

    $('month-select').addEventListener('change', function (e) { selectMonth(e.target.value); });
    $('month-prev').addEventListener('click', function () { stepMonth(-1); });
    $('month-next').addEventListener('click', function () { stepMonth(1); });
    $('tx-search').addEventListener('input', function () { renderTransactions(false); });
    $('tx-type').addEventListener('change', function () { renderTransactions(false); });
    $('tx-category').addEventListener('change', function () { renderTransactions(false); });
    window.addEventListener('hashchange', showView);
    var rt;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (data) renderTrend(); }, 150); });

    if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('Offline mode unavailable', err); });
    }
    start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
