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
  // Quick unlock (Face ID passkey or PIN): the vault key, wrapped by a second key. Never in backups.
  var QUICK = 'quick';
  function readQuick() { return idb('readonly', function (s) { return s.get(QUICK); }); }
  function writeQuick(rec) { return idb('readwrite', function (s) { return s.put(rec, QUICK); }); }
  function deleteQuick() { return idb('readwrite', function (s) { return s.delete(QUICK); }); }

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

  function deriveRaw(password, salt, iterations) {
    if (!subtle) return Promise.reject(new Error('This page must be opened over HTTPS for encryption to work.'));
    return subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']).then(function (base) {
      return subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, base, 256);
    });
  }
  function aesKey(raw) { return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  // Same key as before (PBKDF2 bits used directly as the AES key), so existing vaults and backups still open.
  function deriveKey(password, salt, iterations) { return deriveRaw(password, salt, iterations).then(aesKey); }

  function wrongPassword() { var e = new Error('Wrong password.'); e.code = 'WRONG_PASSWORD'; return e; }

  /** Check the password against the saved vault and return the raw vault key (only used to set up quick unlock). */
  function rawKeyFor(password) {
    return readRecord().then(function (rec) {
      if (!rec) throw new Error('Nothing saved on this device yet.');
      var salt = unb64(rec.salt);
      return deriveRaw(password, salt, Number(rec.iterations)).then(function (raw) {
        return aesKey(raw).then(function (key) {
          return subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct)).then(function () { return new Uint8Array(raw); }, function () { throw wrongPassword(); });
        });
      });
    });
  }
  function wrapRaw(kek, raw) {
    var iv = rand(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, kek, raw).then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }
  /** Unwrap the vault key and open the vault with it. */
  function openWithWrapped(kek, q) {
    return subtle.decrypt({ name: 'AES-GCM', iv: unb64(q.iv) }, kek, unb64(q.ct)).then(function (raw) {
      return readRecord().then(function (rec) {
        if (!rec) throw new Error('Nothing saved on this device yet.');
        return aesKey(raw).then(function (key) {
          return subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct)).then(function (pt) {
            return { session: { key: key, salt: unb64(rec.salt), iterations: Number(rec.iterations) }, data: JSON.parse(dec.decode(pt)) };
          });
        });
      });
    });
  }
  // Key from a passkey's PRF output (only available after Face ID / passcode on this iPhone).
  function prfKey(prfOutput) {
    return subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']).then(function (base) {
      return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('my-finances quick unlock') }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  var PIN_ITERATIONS = 600000, PIN_TRIES = 5;
  function pinKey(pin, salt) { return deriveRaw('pin:' + pin, salt, PIN_ITERATIONS).then(aesKey); }

  function prfFirst(cred) {
    var ext = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    var r = ext && ext.prf && ext.prf.results && ext.prf.results.first;
    return r ? new Uint8Array(r) : null;
  }
  function passkeyGet(credId, prfSalt) {
    return root.navigator.credentials.get({ publicKey: {
      challenge: rand(32), allowCredentials: [{ type: 'public-key', id: credId }], userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } }
    } });
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
      }, function () { throw wrongPassword(); });
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
        return deleteQuick().then(function () { return session; });
      }).then(function (session) {
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
        return seal(session, data).then(writeRecord).then(deleteQuick).then(function () { return session; });
      });
    },

    // ---------- quick unlock ----------
    /** 'passkey', 'pin' or null. */
    quickKind: function () {
      return readQuick().then(function (q) { return q && q.kind || null; }, function () { return null; });
    },
    /** Can this browser make a Face ID / Touch ID passkey? (PRF support is only known after trying.) */
    passkeyPossible: function () {
      var P = root.PublicKeyCredential;
      if (!P || !root.navigator.credentials || !P.isUserVerifyingPlatformAuthenticatorAvailable) return Promise.resolve(false);
      return P.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; });
    },
    /** Set up Face ID: needs the password once. Rejects with code NO_PRF if this iPhone can't do it. */
    enablePasskey: function (password) {
      var prfSalt = rand(32), raw;
      return rawKeyFor(password).then(function (r) {
        raw = r;
        return root.navigator.credentials.create({ publicKey: {
          rp: { name: 'My Finances' },
          user: { id: rand(16), name: 'My Finances', displayName: 'My Finances' },
          challenge: rand(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
          timeout: 60000,
          extensions: { prf: { eval: { first: prfSalt } } }
        } });
      }).then(function (cred) {
        var out = prfFirst(cred);
        var ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
        if (out) return { id: new Uint8Array(cred.rawId), out: out };
        if (!(ext.prf && ext.prf.enabled)) { var e = new Error('This iPhone can\'t use Face ID for this app.'); e.code = 'NO_PRF'; throw e; }
        // Some versions only give the secret when signing in: ask once more.
        var id = new Uint8Array(cred.rawId);
        return passkeyGet(id, prfSalt).then(function (a) {
          var o = prfFirst(a);
          if (!o) { var e2 = new Error('This iPhone can\'t use Face ID for this app.'); e2.code = 'NO_PRF'; throw e2; }
          return { id: id, out: o };
        });
      }).then(function (r) {
        return prfKey(r.out).then(function (kek) { return wrapRaw(kek, raw); }).then(function (w) {
          return writeQuick({ kind: 'passkey', v: 1, cred: b64(r.id), prf_salt: b64(prfSalt), iv: w.iv, ct: w.ct });
        });
      });
    },
    unlockPasskey: function () {
      return readQuick().then(function (q) {
        if (!q || q.kind !== 'passkey') throw new Error('Face ID is not set up.');
        return passkeyGet(unb64(q.cred), unb64(q.prf_salt)).then(function (a) {
          var out = prfFirst(a);
          if (!out) throw new Error('Face ID did not unlock the data. Use your password.');
          return prfKey(out).then(function (kek) { return openWithWrapped(kek, q); });
        });
      });
    },
    /** Set up a 6-digit PIN: needs the password once. */
    enablePin: function (password, pin) {
      var salt = rand(16);
      return rawKeyFor(password).then(function (raw) {
        return pinKey(pin, salt).then(function (kek) { return wrapRaw(kek, raw); });
      }).then(function (w) {
        return writeQuick({ kind: 'pin', v: 1, salt: b64(salt), iv: w.iv, ct: w.ct, tries: 0 });
      });
    },
    /** Rejects with code WRONG_PIN (and .left tries) or PIN_OFF after too many tries. */
    unlockPin: function (pin) {
      return readQuick().then(function (q) {
        if (!q || q.kind !== 'pin') { var e0 = new Error('PIN is off. Use your password.'); e0.code = 'PIN_OFF'; throw e0; }
        return pinKey(pin, unb64(q.salt)).then(function (kek) {
          return openWithWrapped(kek, q).then(function (r) {
            if (!q.tries) return r;
            q.tries = 0; return writeQuick(q).then(function () { return r; });
          }, function () {
            q.tries = (q.tries || 0) + 1;
            var left = PIN_TRIES - q.tries;
            var e = new Error('Wrong PIN.'); e.code = left > 0 ? 'WRONG_PIN' : 'PIN_OFF'; e.left = left;
            return (left > 0 ? writeQuick(q) : deleteQuick()).then(function () { throw e; });
          });
        });
      });
    },
    disableQuick: function () { return deleteQuick(); },

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
