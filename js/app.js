/**
 * app.js: wires the services to the UI.
 *   Library view  – every stored document with its own progress
 *   Reader view   – one document, chapter navigation, TTS playback
 * The reader keeps a single position (state.index → a sentence, which maps
 * to a character index). Chapters, pages and progress all derive from it.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  // Cloud mode (Supabase, synced across devices) when config.js provides credentials; otherwise per-browser IndexedDB
  const Auth = window.AuthService;
  const cloudMode = !!(Auth && Auth.configured());
  const LocalStorageService = window.DocumentStorageService;
  const Storage = cloudMode ? window.CloudStorageService : LocalStorageService;
  const IMPORTED_KEY = 'reader.importedToCloud.v1';
  const Progress = window.ReadingProgressService;
  const Tts = window.TtsService;
  const Text = window.TextService;
  const SETTINGS_KEY = 'reader.settings.v1';

  const state = {
    view: 'library',
    doc: null,
    text: '',
    sentences: [],
    spans: [],
    index: 0,
    activeSpan: null,
    autosaver: null,
    completed: false,     // the open book was read to the end and the position has not moved since
    busy: false,          // an import is running
    deleting: null,       // id of the document being deleted
    openToken: 0,         // bumps on every openDocument call; stale opens bail out
    deletedIds: new Set(),
    storageOk: true
  };

  // ---------------------------------------------------------------- helpers
  const msg = (err) => (err && err.message) || String(err);
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    const days = Math.floor((now - d) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  }
  function chapterLabel(doc, chapterId) {
    const i = Progress.chapterIndex(doc, chapterId);
    return i >= 0 ? doc.chapters[i].title : null;
  }
  function chapterMethodLabel(m) {
    return ({ outline: 'Chapters from the PDF outline', toc: 'Chapters from the table of contents', headings: 'Chapters detected from headings', pages: 'No chapters found, split by pages', none: 'No chapters' })[m] || '';
  }
  function setLibStatus(text) { $('libStatus').textContent = text || ''; }
  function setStatus(text) { $('status').textContent = text || ''; }
  function loadSettings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } }
  function saveSettings(patch) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign(loadSettings(), patch))); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- dialogs
  /** In-app confirmation. Resolves true only when Delete is chosen; Escape and Cancel resolve false. Focus returns to the opener. */
  function confirmDelete(title) {
    const dlg = $('confirmDialog');
    if (dlg.open) return Promise.resolve(false); // already asking
    return new Promise((resolve) => {
      const opener = document.activeElement;
      $('confirmMessage').textContent = `Remove "${title}" from your library? Its saved reading position will be deleted too.`;
      dlg.returnValue = '';
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
        resolve(dlg.returnValue === 'delete');
      };
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      $('confirmCancel').focus();
    });
  }

  // ---------------------------------------------------------------- library
  async function renderLibrary() {
    const docs = await Storage.list();
    const grid = $('library');
    grid.innerHTML = '';
    $('emptyState').hidden = docs.length > 0;
    for (const doc of docs) {
      const p = doc.progress || { percentage: 0, pageNumber: 1, sentenceIndex: 0 };
      const chapter = chapterLabel(doc, p.chapterId);
      const pct = p.completed ? 100 : Math.round(p.percentage || 0);
      const started = pct > 0 || (p.characterIndex || 0) > 0;
      const card = document.createElement('article');
      card.className = 'book';
      card.dataset.id = doc.id;
      card.innerHTML = `
        <div class="book-body">
          <h3 class="book-title"></h3>
          <div class="book-chapter"></div>
          <div class="book-progress"></div>
          <div class="book-position"></div>
          <div class="bar"><div></div></div>
          <div class="book-meta"></div>
        </div>
        <div class="book-actions">
          <button type="button" class="primary continue"></button>
          <button type="button" class="ghost danger delete">Delete</button>
        </div>`;
      card.querySelector('.book-title').textContent = doc.title;
      card.querySelector('.book-chapter').textContent = chapter || (doc.chapters.length ? doc.chapters[0].title : 'No chapters');
      card.querySelector('.book-progress').textContent = p.completed ? 'Finished' : `${pct}% complete`;
      card.querySelector('.book-position').textContent = started && !p.completed
        ? `Page ${p.pageNumber || 1} of ${doc.totalPages} · sentence ${(p.sentenceIndex || 0) + 1}`
        : `${doc.totalPages} page${doc.totalPages === 1 ? '' : 's'}`;
      card.querySelector('.bar > div').style.width = pct + '%';
      card.querySelector('.book-meta').textContent = `Opened ${fmtDate(doc.lastOpenedAt)} · added ${fmtDate(doc.uploadedAt)}`;
      const btn = card.querySelector('.continue');
      btn.textContent = p.completed ? 'Read again' : (started ? 'Continue Reading' : 'Start Reading');
      btn.setAttribute('aria-label', `${btn.textContent}: ${doc.title}`);
      btn.addEventListener('click', () => openDocument(doc.id));
      card.querySelector('.book-title').addEventListener('click', () => openDocument(doc.id));
      const del = card.querySelector('.delete');
      del.setAttribute('aria-label', `Delete ${doc.title}`);
      del.disabled = !!state.deleting;
      del.addEventListener('click', () => deleteDocument(doc.id, doc.title));
      grid.appendChild(card);
    }
  }

  async function refreshLibrary() {
    try { await renderLibrary(); }
    catch (err) { console.error(err); setLibStatus('Could not load your library: ' + msg(err)); }
  }

  // ---------------------------------------------------------------- deletion
  function setDeleteBusy(busy) {
    document.querySelectorAll('.book .delete').forEach(b => { b.disabled = busy; });
    $('deleteBtn').disabled = busy;
    $('deleteBtn').setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /**
   * Delete a document after confirmation. If it is the open book, speech is
   * stopped and pending progress writes are drained first so nothing can be
   * written for it afterwards. Returns true when the document was removed.
   */
  async function deleteDocument(id, title) {
    if (state.deleting || !state.storageOk) return false;
    const ok = await confirmDelete(title);
    if (!ok) return false;
    if (state.deleting) return false;
    state.deleting = id;
    setDeleteBusy(true);
    const isOpen = !!(state.doc && state.doc.id === id);
    const oldSaver = isOpen ? state.autosaver : null;
    try {
      if (isOpen) {
        Tts.stop();
        updateButtons();
        oldSaver.dispose();
        // Drain writes already handed to storage, but never let a stuck write block deletion
        await Promise.race([oldSaver.idle(), new Promise(r => setTimeout(r, 3000))]);
        setStatus('Deleting…');
      }
      state.deletedIds.add(id);
      await Storage.removeDocument(id);
      if (isOpen) { clearReaderState(); setStatus('Ready'); showView('library'); }
      setLibStatus(`Deleted "${title}".`);
      await refreshLibrary();
      return true;
    } catch (err) {
      console.error(err);
      state.deletedIds.delete(id);
      if (isOpen && state.doc && state.doc.id === id) {
        state.autosaver = Progress.createAutosaver((p) => Storage.saveProgress(id, p), 2500);
        setStatus(`Could not delete "${title}": ${msg(err)}`);
      } else {
        setLibStatus(`Could not delete "${title}": ${msg(err)}`);
      }
      return false;
    } finally {
      state.deleting = null;
      setDeleteBusy(false);
    }
  }

  // ---------------------------------------------------------------- imports
  function setImportBusy(busy) {
    ['uploadBtn', 'pasteBtn', 'pasteSubmit'].forEach(id => { $(id).disabled = busy; });
    $('libStatus').setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /** One import at a time; controls are restored whatever happens. */
  async function runImport(work) {
    if (state.busy) { setLibStatus('Please wait for the current import to finish.'); return null; }
    if (!state.storageOk) { setLibStatus('Your library is unavailable, so nothing can be added right now.'); return null; }
    state.busy = true;
    setImportBusy(true);
    try { return await work(); }
    finally { state.busy = false; setImportBusy(false); }
  }

  function importPdf(file) {
    return runImport(async () => {
      let extraction;
      try {
        extraction = await window.PdfService.extract(file, setLibStatus);
      } catch (err) {
        console.error(err);
        setLibStatus('Could not read that PDF: ' + msg(err));
        return null;
      }
      if (!extraction.fullText.trim()) {
        setLibStatus('That PDF has no readable text. If it is a scanned image it would need OCR first.');
        return null;
      }
      const { chapters, method } = window.ChapterDetectionService.detect(extraction);
      let doc;
      try {
        doc = await Storage.createDocument({ extraction, chapters, chapterMethod: method, file });
      } catch (err) {
        console.error(err);
        setLibStatus('Read the PDF but could not save it to your library: ' + msg(err));
        return null;
      }
      setLibStatus(`Added "${doc.title}" with ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}.`);
      await refreshLibrary();
      await openDocument(doc.id);
      return doc;
    });
  }

  /** Store plain text as a document. Throws on blank text or storage failure. */
  async function importText(text, title, progressHint) {
    const clean = (text || '').trim();
    if (!clean) throw new Error('The text is empty.');
    const extraction = window.PdfService.fromPlainText(clean, title);
    const { chapters, method } = window.ChapterDetectionService.detect(extraction);
    const doc = await Storage.createDocument({ extraction, chapters, chapterMethod: method, file: null, title });
    if (progressHint) await Storage.saveProgress(doc.id, progressHint);
    return doc;
  }

  function importTextFile(file) {
    return runImport(async () => {
      let text;
      try { text = await file.text(); }
      catch (err) { setLibStatus('Could not read that file: ' + msg(err)); return null; }
      if (!text.trim()) { setLibStatus('That file is empty.'); return null; }
      let doc;
      try { doc = await importText(text, file.name.replace(/\.(txt|md)$/i, '')); }
      catch (err) { console.error(err); setLibStatus('Could not save that file to your library: ' + msg(err)); return null; }
      setLibStatus(`Added "${doc.title}".`);
      await refreshLibrary();
      await openDocument(doc.id);
      return doc;
    });
  }

  function handleFiles(files) {
    const file = files && files[0];
    if (!file) return;
    const name = file.name || '';
    if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) importPdf(file);
    else if ((file.type || '').startsWith('text/') || /\.(txt|md)$/i.test(name)) importTextFile(file);
    else setLibStatus('Please choose a PDF or a text file.');
  }

  function showPasteError(text) {
    const el = $('pasteError');
    el.textContent = text || '';
    el.hidden = !text;
  }

  async function submitPaste() {
    const text = $('pasteText').value;
    if (!text.trim()) { showPasteError('Paste some text first.'); $('pasteText').focus(); return; }
    if (state.busy) { showPasteError('Please wait for the current import to finish.'); return; }
    const title = $('pasteTitle').value.trim() || text.trim().slice(0, 40).replace(/\s+\S*$/, '') + '…';
    showPasteError('');
    const doc = await runImport(async () => {
      try { return await importText(text, title); }
      catch (err) { console.error(err); showPasteError('Could not save: ' + msg(err)); return null; }
    });
    if (!doc) return; // dialog stays open with the text intact
    $('pasteDialog').close();
    $('pasteText').value = ''; $('pasteTitle').value = '';
    setLibStatus(`Added "${doc.title}".`);
    await refreshLibrary();
    await openDocument(doc.id);
  }

  // One-time import of the position saved by the earlier single-document version
  async function migrateLegacyState() {
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem('reader.state.v1') || 'null'); } catch (e) { legacy = null; }
    if (!legacy || !legacy.text || !legacy.text.trim()) return;
    try {
      const sentences = Text.segmentSentences(legacy.text.trim());
      const si = Math.min(legacy.index || 0, Math.max(0, sentences.length - 1));
      const hint = sentences.length ? { pageNumber: 1, characterIndex: sentences[si].start, sentenceIndex: si, chapterId: null, percentage: Math.round((sentences[si].start / legacy.text.length) * 1000) / 10, completed: false } : null;
      await importText(legacy.text, legacy.title || 'Pasted text', hint);
      localStorage.removeItem('reader.state.v1');
    } catch (e) { console.warn('Legacy import failed', e); }
  }

  // ---------------------------------------------------------------- reader
  function showView(name) {
    state.view = name;
    $('authView').hidden = name !== 'auth';
    $('libraryView').hidden = name !== 'library';
    $('readerView').hidden = name !== 'reader';
    $('player').hidden = name !== 'reader';
    document.body.classList.toggle('in-reader', name === 'reader');
    fitPlayer();
    window.scrollTo(0, 0);
  }

  /** Keep the page's bottom padding equal to the fixed player's real height so the end of a book is never hidden. */
  function fitPlayer() {
    const player = $('player');
    const next = player.hidden ? '' : (player.offsetHeight + 24) + 'px';
    if (document.body.style.paddingBottom !== next) document.body.style.paddingBottom = next; // no observer feedback loop
  }

  function clearReaderState() {
    state.doc = null; state.text = ''; state.sentences = []; state.spans = [];
    state.activeSpan = null; state.autosaver = null; state.completed = false; state.index = 0;
    $('reader').innerHTML = '';
  }

  async function openDocument(id) {
    const token = ++state.openToken;
    const stale = () => token !== state.openToken || state.deletedIds.has(id);
    try {
      if (state.doc) await leaveReader(false);
      if (stale()) return;
      const [doc, text, progress] = await Promise.all([Storage.getDocument(id), Storage.getText(id), Storage.getProgress(id)]);
      if (stale()) return;
      if (!doc) { setLibStatus('That book is no longer in your library.'); await refreshLibrary(); return; }

      state.doc = doc;
      state.text = text;
      state.sentences = Text.segmentSentences(text);
      state.index = Progress.resolveSentenceIndex(progress, state.sentences);
      state.completed = !!(progress && progress.completed);
      state.autosaver = Progress.createAutosaver((p) => Storage.saveProgress(doc.id, p), 2500);
      Storage.touchLastOpened(id).catch(err => console.warn('Could not update last-opened time', err));

      $('readerTitle').textContent = doc.title;
      $('readerSub').textContent = `${doc.totalPages} page${doc.totalPages === 1 ? '' : 's'} · ${state.sentences.length.toLocaleString()} sentences · ${chapterMethodLabel(doc.chapterMethod)}`;
      buildChapterNav();
      renderText();
      showView('reader');
      requestAnimationFrame(() => { if (state.doc === doc) setActive(state.index, true); });
      updateButtons();
      const cur = state.sentences[state.index];
      const ch = Progress.chapterFor(doc, cur ? cur.start : 0);
      if (state.completed) setStatus('You finished this one. Press Play to read it again.');
      else if (progress && (progress.characterIndex || 0) > 0 && cur) setStatus(`Resuming at sentence ${state.index + 1} · page ${Progress.pageFor(doc, cur.start)}${ch ? ' · ' + ch.title : ''}. Press Play.`);
      else setStatus(Tts.available ? 'Press Play to start reading.' : 'Speech is not available in this browser.');
    } catch (err) {
      console.error(err);
      if (token !== state.openToken) return;
      setLibStatus('Could not open that book: ' + msg(err));
      if (state.view !== 'library') showView('library');
    }
  }

  /** The record that describes the current position, honouring a finished book that has not been touched since. */
  function currentProgressRecord() {
    return state.completed ? Progress.completed(state.doc, state.sentences) : Progress.build(state.doc, state.sentences, state.index);
  }

  async function leaveReader(goToLibrary = true) {
    const doc = state.doc;
    if (doc) {
      Tts.stop();
      const saver = state.autosaver;
      const record = currentProgressRecord();
      clearReaderState();                // synchronous, so an overlapping open sees no document
      await saver.flush(record);
    }
    if (goToLibrary) { showView('library'); await refreshLibrary(); }
  }

  function renderText() {
    const reader = $('reader');
    reader.innerHTML = '';
    const frag = document.createDocumentFragment();
    const doc = state.doc;
    const pages = doc.pages || [];
    const chapters = doc.chapters || [];
    let pi = 0, ci = 0;
    const text = state.text || '';
    const norm = Text.normalize;
    state.spans = state.sentences.map((s, i) => {
      const prev = state.sentences[i - 1];
      const gap = prev ? text.slice(prev.end, s.start) : '';
      if (i > 0) frag.appendChild(document.createTextNode(gap.includes('\n') ? '\n\n' : ' '));
      while (pi < pages.length && pages[pi].startCharIndex <= s.start) {
        if (pages.length > 1 && pages[pi].pageNumber > 1 && pages[pi].startCharIndex < pages[pi].endCharIndex) {
          const m = document.createElement('div');
          m.className = 'page-marker'; m.textContent = `Page ${pages[pi].pageNumber}`;
          frag.appendChild(m);
        }
        pi++;
      }
      while (ci < chapters.length && chapters[ci].startCharacterIndex <= s.start) {
        const c = chapters[ci];
        const opening = norm(text.slice(c.startCharacterIndex, c.startCharacterIndex + 160));
        const titleKey = norm(c.title).replace(/^(chapter|part|section)\s+\S+\s*/, '');
        if (!opening.includes(norm(c.title)) && !(titleKey.length > 3 && opening.includes(titleKey))) {
          const m = document.createElement('div');
          m.className = 'chapter-marker'; m.id = 'chapter-' + c.id; m.textContent = c.title;
          frag.appendChild(m);
        }
        ci++;
      }
      const span = document.createElement('span');
      span.className = 'sentence';
      span.textContent = s.text;
      span.dataset.i = i;
      frag.appendChild(span);
      return span;
    });
    reader.appendChild(frag);
  }

  function setActive(i, scroll) {
    const spans = state.spans;
    if (!spans.length) return;
    const prev = state.activeSpan;
    const sequential = prev && Number(prev.dataset.i) === i - 1;
    if (prev) { prev.classList.remove('active'); if (sequential) prev.classList.add('done'); }
    if (!sequential) spans.forEach((s, j) => s.classList.toggle('done', j < i));
    const span = spans[i];
    if (span) {
      span.classList.add('active');
      state.activeSpan = span;
      if (scroll && i === 0) window.scrollTo(0, 0);
      else if (scroll) span.scrollIntoView({ block: 'center', behavior: sequential ? 'smooth' : 'auto' });
      else {
        const r = span.getBoundingClientRect();
        const bottomLimit = window.innerHeight - $('player').offsetHeight - 20;
        if (r.top < 80 || r.bottom > bottomLimit) span.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    updateProgressUi();
  }

  function currentCharIndex() {
    const s = state.sentences[state.index];
    return s ? s.start : 0;
  }

  function updateProgressUi() {
    const doc = state.doc; if (!doc) return;
    const pct = state.completed ? 100 : (state.sentences.length ? (currentCharIndex() / Math.max(1, doc.textLength)) * 100 : 0);
    $('progressBar').style.width = pct.toFixed(1) + '%';
    const prog = $('progress');
    prog.setAttribute('aria-valuenow', String(Math.round(pct)));
    prog.setAttribute('aria-valuetext', `Sentence ${state.index + 1} of ${state.sentences.length}, ${Math.round(pct)}%`);
    updateChapterNav();
  }

  // ---------------------------------------------------------------- chapters
  function buildChapterNav() {
    const doc = state.doc;
    const nav = $('chapterNav');
    const sel = $('chapterSelect');
    sel.innerHTML = '';
    nav.hidden = !doc.chapters.length;
    doc.chapters.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = c.title;
      sel.appendChild(o);
    });
    updateChapterNav();
  }

  function updateChapterNav() {
    const doc = state.doc; if (!doc || !doc.chapters.length) return;
    const ch = Progress.chapterFor(doc, currentCharIndex());
    const i = ch ? doc.chapters.indexOf(ch) : 0;
    $('chapterSelect').value = i;
    $('chapterCount').textContent = `Chapter ${i + 1} of ${doc.chapters.length}`;
    $('prevChapter').disabled = i <= 0;
    $('nextChapter').disabled = i >= doc.chapters.length - 1;
  }

  /** Stop speech, move the reading position to the chapter start, highlight it, save. Playback waits for Play. */
  function goToChapter(chapterIndex) {
    const doc = state.doc; if (!doc) return;
    const ch = doc.chapters[chapterIndex]; if (!ch) return;
    Tts.stop();
    state.completed = false;
    state.index = Progress.resolveSentenceIndex({ characterIndex: ch.startCharacterIndex }, state.sentences);
    setActive(state.index, true);
    updateButtons();
    saveNow();
    setStatus(`${ch.title} · page ${ch.startPage}. Press Play to read from here.`);
  }

  // ---------------------------------------------------------------- playback
  const handlers = {
    onSentenceStart(i) {
      if (!state.doc) return;
      state.index = i;
      state.completed = false;
      setActive(i, false);
      const doc = state.doc;
      const ch = Progress.chapterFor(doc, currentCharIndex());
      setStatus(`Sentence ${i + 1} of ${state.sentences.length} · page ${Progress.pageFor(doc, currentCharIndex())}${ch ? ' · ' + ch.title : ''}`);
      state.autosaver.touch(Progress.build(doc, state.sentences, i));
      updateMediaSession();
    },
    onFinish() {
      if (!state.doc) return;
      state.completed = true;
      state.autosaver.flush(Progress.completed(state.doc, state.sentences));
      state.index = 0;
      if (state.activeSpan) state.activeSpan.classList.remove('active');
      state.spans.forEach(s => s.classList.remove('done'));
      state.activeSpan = null;
      updateProgressUi();
      setStatus('Finished. Press Play to read it again.');
      updateButtons();
    },
    onError(err) {
      saveNow();
      updateButtons();
      if (err === 'cloud-auth') { askForAccessCode(); return; }
      if (typeof err === 'string' && err.indexOf('cloud:') === 0) { setStatus(err.slice(6)); return; }
      setStatus(err === 'unavailable' ? 'Speech is not available in this browser.' : 'Speech error: ' + err);
    }
  };

  function play() {
    if (!Tts.available || !state.doc || !state.sentences.length) return;
    if (Tts.isPaused()) { Tts.resume(); updateButtons(); return; }
    if (Tts.isPlaying()) return;
    state.completed = false;
    Tts.speakFrom(state.sentences, state.index, handlers);
    updateButtons();
  }
  function pauseToggle() {
    if (!Tts.isPlaying()) return;
    if (Tts.isPaused()) { Tts.resume(); setStatus(`Sentence ${state.index + 1} of ${state.sentences.length}`); }
    else { Tts.pause(); setStatus('Paused'); saveNow(); }
    updateButtons();
  }
  function stop() {
    if (!Tts.isPlaying()) return;
    Tts.stop();
    saveNow();
    setStatus(`Stopped at sentence ${state.index + 1}. Play resumes from here.`);
    updateButtons();
  }
  function jumpTo(i) {
    if (!state.doc) return;
    const wasPlaying = Tts.isPlaying() && !Tts.isPaused();
    Tts.stop();
    state.completed = false;
    state.index = Math.max(0, Math.min(i, state.sentences.length - 1));
    setActive(state.index, true);
    saveNow();
    if (wasPlaying) Tts.speakFrom(state.sentences, state.index, handlers);
    else setStatus(`Moved to sentence ${state.index + 1}. Press Play.`);
    updateButtons();
  }

  function saveNow() {
    if (!state.doc || !state.autosaver) return Promise.resolve();
    return state.autosaver.flush(currentProgressRecord());
  }

  function previewVoice() {
    if (!Tts.available) return;
    const wasReading = Tts.isPlaying();
    if (wasReading) saveNow();
    Promise.resolve(Tts.preview()).catch(err => { const m = msg(err); if (m === 'cloud-auth') askForAccessCode(); else setStatus(m.indexOf('cloud:') === 0 ? m.slice(6) : 'Preview failed: ' + m); });
    updateButtons();
    if (wasReading && state.doc) setStatus('Reading stopped for the voice preview. Press Play to continue.');
  }

  function updateButtons() {
    const playing = Tts.isPlaying(), paused = Tts.isPaused();
    const canSpeak = Tts.available && !!state.doc && state.sentences.length > 0;
    $('play').disabled = !canSpeak || (playing && !paused);
    $('play').querySelector('span').textContent = paused ? 'Resume' : (state.index > 0 ? 'Resume' : 'Play');
    $('pause').disabled = !playing;
    $('pause').querySelector('span').textContent = paused ? 'Resume' : 'Pause';
    $('stop').disabled = !playing;
    $('startOver').hidden = !(state.sentences.length && state.index > 0);
    updateMediaSession();
    syncWakeLock();
    updateBackgroundHint();
  }

  // ---------------------------------------------------------------- background playback helpers
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /** Lock-screen / headphone controls and "now playing" info, where the browser supports them. */
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      if (state.doc) {
        const ch = Progress.chapterFor(state.doc, currentCharIndex());
        ms.metadata = new MediaMetadata({ title: state.doc.title, artist: ch ? ch.title : `Sentence ${state.index + 1} of ${state.sentences.length}`, album: 'Reader' });
      }
      ms.playbackState = Tts.isPlaying() ? (Tts.isPaused() ? 'paused' : 'playing') : 'none';
    } catch (e) { /* ignore */ }
  }
  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* unsupported action */ } };
    set('play', () => play());
    set('pause', () => { if (Tts.isPlaying() && !Tts.isPaused()) pauseToggle(); });
    set('stop', () => stop());
    set('previoustrack', () => jumpTo(state.index - 1));
    set('nexttrack', () => jumpTo(state.index + 1));
    set('seekbackward', () => jumpTo(state.index - 1));
    set('seekforward', () => jumpTo(state.index + 1));
  }

  /** Screen Wake Lock: stops the phone auto-locking while a device voice reads, since iOS silences it on lock. */
  let wakeLock = null;
  function wakeLockWanted() { return !!navigator.wakeLock && $('keepAwake').checked && Tts.isPlaying() && !Tts.isPaused(); }
  async function syncWakeLock() {
    if (wakeLockWanted()) {
      if (wakeLock || document.visibilityState !== 'visible') return;
      try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      catch (e) { wakeLock = null; }
    } else if (wakeLock) {
      try { await wakeLock.release(); } catch (e) { /* ignore */ }
      wakeLock = null;
    }
  }
  function updateBackgroundHint() {
    const el = $('bgHint');
    if (!state.doc || !Tts.available) { el.hidden = true; return; }
    const cloud = Tts.isUsingCloud();
    if (IS_IOS && !cloud) {
      el.textContent = Tts.cloudAvailable()
        ? 'Device voices stop when the screen locks. Pick a cloud voice to keep listening with the screen off.'
        : 'Device voices stop when the screen locks. Keep screen on prevents auto-lock while reading.';
      el.hidden = false;
    } else if (cloud) {
      el.textContent = 'Cloud voices keep playing with the screen off. Use the lock-screen controls to pause or skip.';
      el.hidden = false;
    } else el.hidden = true;
  }

  // ---------------------------------------------------------------- cloud voices
  const ACCESS_KEY = 'reader.ttsAccessCode';
  function getAccessCode() { try { return localStorage.getItem(ACCESS_KEY) || ''; } catch (e) { return ''; } }
  function askForAccessCode() {
    const dlg = $('accessDialog');
    if (dlg.open) return;
    $('accessError').textContent = getAccessCode() ? 'That code was not accepted. Try again.' : '';
    $('accessError').hidden = !$('accessError').textContent;
    $('accessCode').value = '';
    setStatus('Cloud voices need the access code.');
    dlg.showModal();
    $('accessCode').focus();
  }
  function bindCloudVoices() {
    Tts.setCredentialsProvider(async () => {
      let bearer = '';
      if (cloudMode) { try { const s = await Auth.getSession(); bearer = s ? s.access_token : ''; } catch (e) { bearer = ''; } }
      return { accessCode: getAccessCode(), bearer };
    });
    $('accessCancel').addEventListener('click', () => $('accessDialog').close());
    $('accessForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = $('accessCode').value.trim();
      if (!code) { $('accessError').textContent = 'Enter the access code.'; $('accessError').hidden = false; return; }
      try { localStorage.setItem(ACCESS_KEY, code); } catch (err) { /* ignore */ }
      $('accessDialog').close();
      if (state.doc && state.view === 'reader') play();
    });
  }

  // ---------------------------------------------------------------- voices
  function renderVoices() {
    const sel = $('voice');
    const voices = Tts.getVoices();
    sel.innerHTML = '';
    const groups = {};
    if (Tts.cloudAvailable()) {
      const g = document.createElement('optgroup');
      g.label = 'Cloud voices (same on every device)';
      for (const v of Tts.getCloudVoices()) {
        const o = document.createElement('option');
        o.value = v.key; o.textContent = `${v.name}  ·  ${v.desc}`;
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
    for (const v of voices) {
      const g = Tts.groupName(v);
      if (!groups[g]) { groups[g] = document.createElement('optgroup'); groups[g].label = g; sel.appendChild(groups[g]); }
      const o = document.createElement('option');
      o.value = Tts.voiceKey(v);
      const tags = [];
      if (Tts.isJarvis(v)) tags.push('Jarvis-style');
      if (Tts.quality(v) >= 2) tags.push('HQ');
      o.textContent = `${v.name} (${v.lang})${tags.length ? '  ·  ' + tags.join(', ') : ''}`;
      groups[g].appendChild(o);
    }
    sel.value = Tts.getVoiceKey() || '';
    $('voiceTip').hidden = !Tts.available || !voices.length || Tts.hasHighQualityEnglish() || Tts.cloudAvailable();
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $('uploadBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', () => { handleFiles($('fileInput').files); $('fileInput').value = ''; });
    const dz = $('dropzone');
    ['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, (e) => { if (state.view === 'library') { e.preventDefault(); dz.classList.add('over'); } }));
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dz.classList.remove('over'); });
    document.addEventListener('drop', (e) => { if (state.view !== 'library') return; e.preventDefault(); dz.classList.remove('over'); handleFiles(e.dataTransfer.files); });

    $('pasteBtn').addEventListener('click', () => { showPasteError(''); $('pasteDialog').showModal(); $('pasteText').focus(); });
    $('pasteCancel').addEventListener('click', () => $('pasteDialog').close());
    $('pasteForm').addEventListener('submit', (e) => { e.preventDefault(); submitPaste(); });
    $('confirmCancel').addEventListener('click', () => $('confirmDialog').close(''));
    // Close with an explicit value rather than relying on the submitter's value being copied to returnValue
    $('confirmDialog').querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); $('confirmDialog').close('delete'); });

    $('backBtn').addEventListener('click', () => leaveReader(true));
    $('deleteBtn').addEventListener('click', () => { if (state.doc) deleteDocument(state.doc.id, state.doc.title); });
    $('play').addEventListener('click', play);
    $('pause').addEventListener('click', pauseToggle);
    $('stop').addEventListener('click', stop);
    $('startOver').addEventListener('click', () => jumpTo(0));
    $('previewVoice').addEventListener('click', previewVoice);
    $('reader').addEventListener('click', (e) => {
      const span = e.target.closest('.sentence');
      if (span) jumpTo(Number(span.dataset.i));
    });
    const progress = $('progress');
    progress.addEventListener('click', (e) => {
      if (!state.sentences.length) return;
      const r = progress.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      jumpTo(Text.sentenceAt(state.sentences, Math.floor(frac * Math.max(1, state.doc.textLength))));
    });
    progress.addEventListener('keydown', (e) => {
      if (!state.sentences.length) return;
      const n = state.sentences.length;
      const step = e.shiftKey ? 10 : 1;
      let target = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') target = state.index + step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') target = state.index - step;
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = n - 1;
      else if (e.key === 'PageUp') target = state.index - Math.max(1, Math.round(n / 10));
      else if (e.key === 'PageDown') target = state.index + Math.max(1, Math.round(n / 10));
      if (target === null) return;
      e.preventDefault();
      jumpTo(target);
    });

    $('chapterSelect').addEventListener('change', (e) => goToChapter(Number(e.target.value)));
    $('prevChapter').addEventListener('click', () => goToChapter(Number($('chapterSelect').value) - 1));
    $('nextChapter').addEventListener('click', () => goToChapter(Number($('chapterSelect').value) + 1));

    const rateInput = $('rate');
    rateInput.addEventListener('input', () => { $('rateValue').textContent = parseFloat(rateInput.value).toFixed(1) + 'x'; });
    rateInput.addEventListener('change', () => {
      Tts.setRate(rateInput.value); saveSettings({ rate: rateInput.value });
      if (Tts.isPaused()) setStatus('Paused. The new speed applies when you resume.');
    });
    $('voice').addEventListener('change', (e) => {
      Tts.setVoiceKey(e.target.value); saveSettings({ voice: e.target.value });
      if (Tts.isPaused()) setStatus('Paused. The new voice applies when you resume.');
      updateBackgroundHint();
    });

    document.addEventListener('keydown', (e) => {
      if (state.view !== 'reader') return;
      if (e.target.closest('button, input, textarea, select, a, dialog, [role="slider"], [contenteditable]')) return;
      if (e.code === 'Space') { e.preventDefault(); Tts.isPlaying() ? pauseToggle() : play(); }
      if (e.key === 'ArrowRight' && e.altKey) $('nextChapter').click();
      if (e.key === 'ArrowLeft' && e.altKey) $('prevChapter').click();
    });

    if (navigator.wakeLock) {
      $('keepAwakeLabel').hidden = false;
      $('keepAwake').checked = loadSettings().keepAwake !== false;
      $('keepAwake').addEventListener('change', () => { saveSettings({ keepAwake: $('keepAwake').checked }); syncWakeLock(); });
    }
    bindMediaSession();

    // Save when the reader is hidden or the page is closing; the mirror write is synchronous
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); else syncWakeLock(); });
    window.addEventListener('pagehide', () => { saveNow(); });
    window.addEventListener('beforeunload', () => { saveNow(); Tts.stop(); });

    if (window.ResizeObserver) new ResizeObserver(fitPlayer).observe($('player'));
    window.addEventListener('resize', fitPlayer);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitPlayer);
    // iOS Safari often reports no voices until the first user gesture and never fires voiceschanged
    const lazyVoices = () => { if (Tts.available && !Tts.getVoices().length) { Tts.loadVoices(); renderVoices(); } };
    ['pointerdown', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, lazyVoices, { passive: true }));
  }


  // ---------------------------------------------------------------- account (cloud mode)
  function setAuthError(text) { const el = $('authError'); el.textContent = text || ''; el.hidden = !text; }
  function setAuthInfo(text) { const el = $('authInfo'); el.textContent = text || ''; el.hidden = !text; }
  function setAuthBusy(busy) { ['signInBtn', 'signUpBtn', 'googleBtn', 'forgotBtn'].forEach(id => { $(id).disabled = busy; }); }

  async function authAction(work) {
    setAuthError(''); setAuthInfo(''); setAuthBusy(true);
    try { await work(); }
    catch (err) {
      console.error(err);
      const m = msg(err);
      setAuthError(/failed to fetch|networkerror|load failed/i.test(m) ? 'Could not reach the sign-in service. Check your internet connection and the Supabase URL.' : m);
    }
    finally { setAuthBusy(false); }
  }

  function bindAuth() {
    const email = () => $('authEmail').value.trim();
    const password = () => $('authPassword').value;
    $('authForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!email() || !password()) { setAuthError('Enter your email and password.'); return; }
      authAction(async () => { await Auth.signIn(email(), password()); });
    });
    $('signUpBtn').addEventListener('click', () => {
      if (!email() || password().length < 6) { setAuthError('Enter your email and a password of at least 6 characters.'); return; }
      authAction(async () => {
        const res = await Auth.signUp(email(), password());
        if (!res.session) setAuthInfo('Account created. Check your email for a confirmation link, then sign in.');
      });
    });
    $('googleBtn').addEventListener('click', () => authAction(() => Auth.signInWithGoogle()));
    $('forgotBtn').addEventListener('click', () => {
      if (!email()) { setAuthError('Enter your email first.'); return; }
      authAction(async () => { await Auth.resetPassword(email()); setAuthInfo('Password reset email sent.'); });
    });
    $('signOutBtn').addEventListener('click', async () => {
      try { await leaveReader(false); await Auth.signOut(); }
      catch (err) { setLibStatus('Could not sign out: ' + msg(err)); }
    });
  }

  async function enterLibrary(session) {
    $('userEmail').textContent = session.user.email || '';
    $('libSubtitle').textContent = 'Your library, synced to every device you sign in on.';
    showView('library');
    setLibStatus('');
    await refreshLibrary();
    await offerLocalImport();
  }

  function handleAuthChange(event, session) {
    if (event === 'SIGNED_OUT' || (!session && event !== 'INITIAL_SESSION')) {
      leaveReader(false).finally(() => { $('userEmail').textContent = ''; $('authPassword').value = ''; setAuthInfo('You are signed out.'); showView('auth'); });
    } else if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && state.view === 'auth') {
      enterLibrary(session).catch(err => { console.error(err); setLibStatus('Could not load your library: ' + msg(err)); });
    }
  }

  /** Books stored in this browser before cloud sync existed can be copied into the account once. */
  function importedIds() { try { return new Set(JSON.parse(localStorage.getItem(IMPORTED_KEY) || '[]')); } catch (e) { return new Set(); } }
  async function localLeftovers() {
    if (!cloudMode) return [];
    try { const done = importedIds(); return (await LocalStorageService.list()).filter(d => !done.has(d.id)); }
    catch (e) { return []; }
  }
  async function offerLocalImport() {
    const left = await localLeftovers();
    const btn = $('importLocal');
    btn.hidden = !left.length;
    if (left.length) btn.textContent = `Copy ${left.length} book${left.length === 1 ? '' : 's'} from this browser into your account`;
  }
  function importLocalLibrary() {
    return runImport(async () => {
      const left = await localLeftovers();
      const done = importedIds();
      let ok = 0;
      for (const d of left) {
        setLibStatus(`Copying "${d.title}" (${ok + 1} of ${left.length})…`);
        try {
          const [text, file] = await Promise.all([LocalStorageService.getText(d.id), LocalStorageService.getFile(d.id)]);
          if (!text.trim()) { done.add(d.id); continue; }
          const extraction = { fullText: text, numPages: d.totalPages, pages: d.pages || [], title: d.title, filename: d.filename || '' };
          const created = await Storage.createDocument({ extraction, chapters: d.chapters || [], chapterMethod: d.chapterMethod, file: file || null, title: d.title });
          const p = d.progress;
          if (p && (p.characterIndex > 0 || p.completed)) {
            await Storage.saveProgress(created.id, { pageNumber: p.pageNumber, characterIndex: p.characterIndex, sentenceIndex: p.sentenceIndex, chapterId: p.chapterId, percentage: p.percentage, completed: !!p.completed });
          }
          done.add(d.id); ok++;
          try { localStorage.setItem(IMPORTED_KEY, JSON.stringify([...done])); } catch (e) { /* ignore */ }
        } catch (err) {
          console.error(err);
          setLibStatus(`Could not copy "${d.title}": ${msg(err)}`);
          await refreshLibrary(); await offerLocalImport();
          return null;
        }
      }
      setLibStatus(ok ? `Copied ${ok} book${ok === 1 ? '' : 's'} into your account. The originals stay in this browser.` : 'Nothing to copy.');
      await refreshLibrary(); await offerLocalImport();
      return ok;
    });
  }

  // ---------------------------------------------------------------- start
  async function init() {
    const settings = loadSettings();
    if (settings.rate) { $('rate').value = settings.rate; $('rateValue').textContent = parseFloat(settings.rate).toFixed(1) + 'x'; Tts.setRate(settings.rate); }
    if (settings.voice) Tts.setVoiceKey(settings.voice);
    bind();
    if (window.speechSynthesis) {
      Tts.onVoicesChanged(renderVoices);
      Tts.loadVoices();
    }
    if (!Tts.available) {
      ['play', 'pause', 'stop', 'previewVoice', 'voice', 'rate'].forEach(id => { $(id).disabled = true; });
      setStatus('Speech is not available in this browser.');
      setLibStatus('Speech synthesis is not supported in this browser, so books can be stored but not read aloud.');
    }
    renderVoices();
    bindCloudVoices();
    $('importLocal').addEventListener('click', importLocalLibrary);
    if (cloudMode) {
      $('accountBar').hidden = false;
      bindAuth();
      let session = null;
      try { session = await Auth.getSession(); }
      catch (err) { console.error(err); setAuthError('Could not reach the sign-in service: ' + msg(err)); }
      Auth.onChange(handleAuthChange);
      if (!session) { showView('auth'); return; }
      try { await enterLibrary(session); }
      catch (err) { console.error(err); setLibStatus('Could not load your library: ' + msg(err)); }
      return;
    }
    $('libSubtitle').textContent = 'Your library, stored in this browser only.';
    showView('library');
    try {
      await Storage.check();
    } catch (err) {
      console.error(err);
      state.storageOk = false;
      setImportBusy(true);
      setLibStatus('Your library cannot be opened: ' + msg(err) + ' Reload the page to try again.');
      return;
    }
    await migrateLegacyState();
    await refreshLibrary();
  }

  // Small surface for tests and debugging; not used by the page itself
  window.ReaderApp = {
    getState: () => ({ view: state.view, docId: state.doc && state.doc.id, index: state.index, completed: state.completed, busy: state.busy, deleting: state.deleting, cloudMode }),
    openDocument, deleteDocument, leaveReader, importText, refreshLibrary, play, pauseToggle, stop, jumpTo, saveNow, previewVoice
  };
  init();
})();
