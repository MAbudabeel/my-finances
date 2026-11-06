// Encrypted on-device storage.
// - All data is one JSON object, encrypted with AES-256-GCM.
// - The key comes from your password via PBKDF2-SHA256 (600,000 rounds) and
//   is never stored. Without the password the saved data can't be read.
// - Saved in this browser's IndexedDB for this website only.
// - A backup file is the same encrypted record, so it needs the same password.
(function (root) {
  'use strict';

  var DB_NAME = 'finance-phone';
  var STORE = 'vault';
  var KEY = 'main';
  var ITERATIONS = 600000;
  var FORMAT = 'finance-phone-vault';

  var subtle = (root.crypto && root.crypto.subtle) || null;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('This browser has no IndexedDB.')); return; }
      var req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Could not open storage.')); };
      req.onblocked = function () { reject(new Error('Storage is busy in another tab. Close other tabs of this app.')); };
    });
  }
  function idb(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var out;
        tx.oncomplete = function () { db.close(); resolve(out); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error || new Error('Storage error.')); };
        var r = fn(tx.objectStore(STORE));
        if (r) r.onsuccess = function () { out = r.result; };
      });
    });
  }
  function readRecord() { return idb('readonly', function (s) { return s.get(KEY); }); }
  function writeRecord(rec) { return idb('readwrite', function (s) { return s.put(rec, KEY); }); }

  function b64(bytes) {
    var s = '';
    var a = new Uint8Array(bytes);
    for (var i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(String(str));
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function rand(n) { return root.crypto.getRandomValues(new Uint8Array(n)); }

  function deriveKey(password, salt, iterations) {
    if (!subtle) return Promise.reject(new Error('This page must be opened over HTTPS for encryption to work.'));
    return subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }

  function seal(session, data) {
    var iv = rand(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, session.key, enc.encode(JSON.stringify(data))).then(function (ct) {
      return { format: FORMAT, v: 1, kdf: 'PBKDF2-SHA256', iterations: session.iterations, salt: b64(session.salt), iv: b64(iv), ct: b64(ct) };
    });
  }

  function open(rec, password) {
    if (!rec || rec.format !== FORMAT || rec.v !== 1) return Promise.reject(new Error('Not a finance backup file.'));
    var salt = unb64(rec.salt);
    var iterations = Number(rec.iterations);
    if (!(iterations >= 100000 && iterations <= 10000000)) return Promise.reject(new Error('Damaged file.'));
    return deriveKey(password, salt, iterations).then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct)).then(function (pt) {
        return { session: { key: key, salt: salt, iterations: iterations }, data: JSON.parse(dec.decode(pt)) };
      }, function () { var e = new Error('Wrong password.'); e.code = 'WRONG_PASSWORD'; throw e; });
    });
  }

  function newSession(password) {
    var salt = rand(16);
    return deriveKey(password, salt, ITERATIONS).then(function (key) { return { key: key, salt: salt, iterations: ITERATIONS }; });
  }

  var Store = {
    /** true if a vault exists on this device. */
    exists: function () {
      // Avoid creating an empty database just by checking.
      var list = root.indexedDB && root.indexedDB.databases ? root.indexedDB.databases().catch(function () { return null; }) : Promise.resolve(null);
      return list.then(function (dbs) {
        if (dbs && !dbs.some(function (d) { return d.name === DB_NAME; })) return false;
        return readRecord().then(function (r) { return !!r; });
      });
    },

    /** First run: create the vault. Returns a session. */
    create: function (password, data) {
      return newSession(password).then(function (session) {
        return seal(session, data).then(writeRecord).then(function () { return session; });
      });
    },

    /** Returns {session, data}; rejects with code WRONG_PASSWORD. */
    unlock: function (password) {
      return readRecord().then(function (rec) {
        if (!rec) throw new Error('Nothing saved on this device yet.');
        return open(rec, password);
      });
    },

    save: function (session, data) { return seal(session, data).then(writeRecord); },

    changePassword: function (oldPassword, newPassword, data) {
      return Store.unlock(oldPassword).then(function () { return newSession(newPassword); }).then(function (session) {
        return seal(session, data).then(writeRecord).then(function () { return session; });
      });
    },

    /** An encrypted backup as a JSON string (needs the current password to open). */
    backup: function (session, data) {
      return seal(session, data).then(function (rec) {
        rec.exported_at = new Date().toISOString();
        return JSON.stringify(rec);
      });
    },

    /** Decrypt a backup file's text with the password it was made with. Returns data. */
    readBackup: function (text, password) {
      var rec;
      try { rec = JSON.parse(text); } catch (e) { return Promise.reject(new Error('Not a finance backup file.')); }
      return open(rec, password).then(function (r) { return r.data; });
    },

    /** Delete everything this app saved in this browser. */
    wipe: function () {
      return new Promise(function (resolve, reject) {
        var req = root.indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error || new Error('Could not delete.')); };
        req.onblocked = function () { resolve(); };
      }).then(function () {
        try { root.localStorage.clear(); } catch (e) { /* not used for data */ }
      });
    },

    /** Ask the browser not to evict our data. */
    persist: function () {
      if (root.navigator.storage && root.navigator.storage.persist) {
        return root.navigator.storage.persist().catch(function () { return false; });
      }
      return Promise.resolve(false);
    },
    persisted: function () {
      if (root.navigator.storage && root.navigator.storage.persisted) {
        return root.navigator.storage.persisted().catch(function () { return false; });
      }
      return Promise.resolve(false);
    }
  };

  root.FinStore = Store;
})(self);
