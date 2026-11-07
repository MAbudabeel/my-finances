// Reads the text of an Al Rajhi statement PDF on this phone (pdf.js, loaded only when needed).
// Nothing is uploaded: the file is read in memory and only its text positions are passed on.
(function (root) {
  'use strict';
  var lib = null;
  function load() {
    if (!lib) {
      var base = new URL('vendor/pdfjs/', document.baseURI).href;
      lib = import(base + 'pdf.min.mjs').then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
        return pdfjs;
      });
    }
    return lib;
  }
  /** Returns [{page, x, y, str}] for every piece of text. Rejects with code PASSWORD for locked PDFs. */
  function read(file) {
    return Promise.all([load(), file.arrayBuffer()]).then(function (r) {
      var pdfjs = r[0];
      var task = pdfjs.getDocument({ data: new Uint8Array(r[1]), isEvalSupported: false, disableFontFace: true, enableXfa: false, verbosity: 0 });
      return task.promise.then(function (doc) {
        var items = [], n = Math.min(doc.numPages, 200), chain = Promise.resolve();
        for (var p = 1; p <= n; p++) {
          (function (p) {
            chain = chain.then(function () { return doc.getPage(p); }).then(function (page) { return page.getTextContent(); }).then(function (tc) {
              tc.items.forEach(function (it) { if (it.str) items.push({ page: p, x: it.transform[4], y: it.transform[5], str: it.str }); });
            });
          })(p);
        }
        return chain.then(function () { doc.destroy(); return items; });
      }, function (err) {
        if (err && err.name === 'PasswordException') { var e = new Error('This PDF is password-protected.'); e.code = 'PASSWORD'; throw e; }
        throw err;
      });
    });
  }
  root.FinStatement = { read: read };
})(self);
