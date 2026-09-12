/**
 * documentStorageService: persists the library in IndexedDB.
 *   documents  – metadata + chapters + page map (small, listed on the dashboard)
 *   texts      – extracted text, loaded only when a document is opened
 *   files      – the original PDF blob, so it can be re-opened or re-processed
 *   progress   – the reading position, written often and kept separate so
 *                saving progress never rewrites the whole document
 * Creating and deleting a document each use one transaction across all four
 * stores, so the library can never hold half a document. Progress is also
 * mirrored to localStorage synchronously, because a write issued while the
 * tab is closing may not reach IndexedDB in time; a progress write for a
 * document that no longer exists is discarded and its mirror removed.
 */
window.DocumentStorageService = (function () {
  let DB_NAME = 'readerLibrary';
  const DB_VERSION = 1;
  const STORES = ['documents', 'texts', 'files', 'progress'];
  let MIRROR_PREFIX = 'reader.progress.';
  let dbPromise = null;

  /** Test hook: point the service at a different database and mirror namespace. */
  function configure(opts) {
    if (opts && opts.dbName) { DB_NAME = opts.dbName; MIRROR_PREFIX = 'reader.progress.' + opts.dbName + '.'; }
    closeConnection();
  }
  function closeConnection() {
    const p = dbPromise; dbPromise = null;
    if (p) p.then(db => { try { db.close(); } catch (e) { /* ignore */ } }, () => {});
  }

  function open() {
    if (dbPromise) return dbPromise;
    const p = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is not available in this browser.'));
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      req.onblocked = () => reject(new Error('The library database is open in another tab that needs to be reloaded.'));
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgraded or deleted the database: drop this connection and reopen lazily
        db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } if (dbPromise === chained) dbPromise = null; };
        db.onclose = () => { if (dbPromise === chained) dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('Could not open the library database.'));
    });
    // A failed open must not be cached forever; the next call retries
    const chained = p.catch(err => { if (dbPromise === chained) dbPromise = null; throw err; });
    dbPromise = chained;
    return chained;
  }

  /**
   * Run fn(stores) inside one transaction. fn receives an object of stores by
   * name and may return a value or a promise resolved before commit.
   */
  function tx(storeNames, mode, fn) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return open().then(db => new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(names, mode); } catch (e) { return reject(e); }
      const stores = {};
      for (const n of names) stores[n] = t.objectStore(n);
      let result;
      let failed = null;
      t.oncomplete = () => failed ? reject(failed) : resolve(result);
      t.onerror = () => reject(failed || t.error || new Error('Transaction failed'));
      t.onabort = () => reject(failed || t.error || new Error('Transaction aborted'));
      try {
        Promise.resolve(fn(stores)).then(r => { result = r; }, err => { failed = err; try { t.abort(); } catch (e) { /* already done */ } });
      } catch (err) {
        failed = err; try { t.abort(); } catch (e) { /* ignore */ }
      }
    }));
  }
  const reqp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const get = (store, id) => tx(store, 'readonly', s => reqp(s[store].get(id)));
  const all = (store) => tx(store, 'readonly', s => reqp(s[store].getAll()));

  function newId() {
    return 'doc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function readMirror(id) {
    try { return JSON.parse(localStorage.getItem(MIRROR_PREFIX + id) || 'null'); } catch (e) { return null; }
  }
  function writeMirror(id, record) {
    try { localStorage.setItem(MIRROR_PREFIX + id, JSON.stringify(record)); } catch (e) { /* full or blocked */ }
  }
  function removeMirror(id) {
    try { localStorage.removeItem(MIRROR_PREFIX + id); } catch (e) { /* ignore */ }
  }
  function newer(a, b) {
    if (!a) return b; if (!b) return a;
    return (b.savedAt || 0) > (a.savedAt || 0) ? b : a;
  }

  /**
   * Create and store a new document from a processed extraction, atomically.
   * @returns {Promise<Document>} the stored metadata record
   */
  async function createDocument({ extraction, chapters, chapterMethod, file, title }) {
    if (!extraction || typeof extraction.fullText !== 'string' || !extraction.fullText.trim()) {
      throw new Error('There is no text to save.');
    }
    const id = newId();
    const now = new Date().toISOString();
    const doc = {
      id,
      title: title || extraction.title || extraction.filename || 'Untitled',
      filename: extraction.filename || '',
      hasFile: !!file,
      totalPages: extraction.numPages,
      textLength: extraction.fullText.length,
      uploadedAt: now,
      lastOpenedAt: now,
      pages: extraction.pages.map(p => ({ pageNumber: p.pageNumber, startCharIndex: p.startCharIndex, endCharIndex: p.endCharIndex })),
      chapters: chapters || [],
      chapterMethod: chapterMethod || 'none'
    };
    const progress = { id, pageNumber: 1, characterIndex: 0, sentenceIndex: 0, chapterId: doc.chapters[0] ? doc.chapters[0].id : null, percentage: 0, completed: false, savedAt: Date.now() };
    await tx(STORES, 'readwrite', s => {
      s.documents.put(doc);
      s.texts.put({ id, text: extraction.fullText });
      if (file) s.files.put({ id, blob: file, type: file.type || 'application/pdf' });
      s.progress.put(progress);
    });
    writeMirror(id, progress);
    return doc;
  }

  async function getProgress(id) {
    const stored = await get('progress', id).catch(() => null);
    return newer(stored, readMirror(id)) || null;
  }

  /**
   * Save the reading position. The mirror is written first so it survives a
   * closing tab; the database write then checks the document still exists and
   * otherwise discards the record and clears the mirror.
   * @returns {Promise<boolean>} true when stored, false when the document is gone
   */
  function saveProgress(id, progress) {
    const record = Object.assign({}, progress, { id, savedAt: Date.now() });
    writeMirror(id, record);
    return tx(['documents', 'progress'], 'readwrite', async s => {
      const doc = await reqp(s.documents.get(id));
      if (!doc) return false;
      s.progress.put(record);
      return true;
    }).then(stored => {
      if (!stored) removeMirror(id);
      return stored;
    }, err => { removeMirror(id); throw err; });
  }

  function touchLastOpened(id) {
    return tx('documents', 'readwrite', async s => {
      const doc = await reqp(s.documents.get(id));
      if (!doc) return false;
      doc.lastOpenedAt = new Date().toISOString();
      s.documents.put(doc);
      return true;
    });
  }

  function updateDocument(id, patch) {
    return tx('documents', 'readwrite', async s => {
      const doc = await reqp(s.documents.get(id));
      if (!doc) return null;
      Object.assign(doc, patch);
      s.documents.put(doc);
      return doc;
    });
  }

  /** Library listing: every document with its progress, most recently opened first. */
  async function list() {
    const { docs, progress } = await tx(['documents', 'progress'], 'readonly', async s => ({
      docs: await reqp(s.documents.getAll()),
      progress: await reqp(s.progress.getAll())
    }));
    const byId = new Map(progress.map(p => [p.id, p]));
    for (const d of docs) d.progress = newer(byId.get(d.id), readMirror(d.id)) || null;
    docs.sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
    return docs;
  }

  function getDocument(id) { return get('documents', id); }
  async function getText(id) { const r = await get('texts', id); return r ? r.text : ''; }
  async function getFile(id) { const r = await get('files', id); return r ? r.blob : null; }

  /** Remove a document and everything attached to it in one transaction. */
  async function removeDocument(id) {
    await tx(STORES, 'readwrite', s => {
      s.documents.delete(id);
      s.texts.delete(id);
      s.files.delete(id);
      s.progress.delete(id);
    });
    removeMirror(id);
  }

  /** Cheap connectivity check used at start-up to surface persistent storage failures. */
  function check() { return open().then(() => true); }

  return { configure, check, createDocument, list, getDocument, getText, getFile, getProgress, saveProgress, touchLastOpened, updateDocument, removeDocument };
})();
