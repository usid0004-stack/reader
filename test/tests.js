/* Focused regression tests for the reader services. Open test/index.html in a browser.
   Storage tests use a separate database (readerLibraryTest) and never touch the real library. */
(async function () {
  const results = [];
  const el = document.getElementById('results');
  const summary = document.getElementById('summary');
  function assert(cond, message) { if (!cond) throw new Error(message || 'assertion failed'); }
  function eq(a, b, message) { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) throw new Error(`${message || 'not equal'}: ${sa} !== ${sb}`); }
  async function test(name, fn) {
    const row = document.createElement('div');
    try { await fn(); results.push({ name, ok: true }); row.className = 'pass'; row.textContent = '✓ ' + name; }
    catch (err) { results.push({ name, ok: false, error: err.message }); row.className = 'fail'; row.textContent = '✗ ' + name; const pre = document.createElement('pre'); pre.textContent = err.stack || err.message; row.appendChild(pre); }
    el.appendChild(row);
  }
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const T = window.TextService, P = window.ReadingProgressService, C = window.ChapterDetectionService, S = window.DocumentStorageService, PDF = window.PdfService;

  // ------------------------------------------------------------ textService
  await test('segmentSentences keeps character offsets', () => {
    const text = 'One two. Three four!  Five\n\nSix seven';
    const s = T.segmentSentences(text);
    eq(s.map(x => x.text), ['One two.', 'Three four!', 'Five', 'Six seven']);
    for (const x of s) assert(text.slice(x.start, x.end) === x.text, 'offset mismatch for ' + x.text);
  });
  await test('sentenceAt finds the sentence containing or following a character index', () => {
    const s = T.segmentSentences('Aaa. Bbb. Ccc.');
    eq(T.sentenceAt(s, 0), 0); eq(T.sentenceAt(s, 6), 1); eq(T.sentenceAt(s, 4), 1); eq(T.sentenceAt(s, 99), 2);
  });
  await test('splitForSpeech bounds chunk length and preserves words', () => {
    const words = []; for (let i = 0; i < 120; i++) words.push('word' + i);
    const long = words.join(' ');
    const chunks = T.splitForSpeech(long, 100);
    assert(chunks.length > 1, 'should split');
    for (const c of chunks) assert(c.length <= 100, 'chunk too long: ' + c.length);
    eq(chunks.join(' '), long, 'chunks must reassemble to the original');
    eq(T.splitForSpeech('short', 100), ['short']);
  });
  await test('splitForSpeech prefers clause breaks', () => {
    const t = 'alpha beta gamma delta, epsilon zeta eta theta iota kappa';
    const chunks = T.splitForSpeech(t, 40);
    assert(chunks[0].endsWith(','), 'first chunk should end at the comma: ' + chunks[0]);
  });

  // ------------------------------------------------------------ readingProgressService
  const doc = {
    textLength: 1000,
    pages: [{ pageNumber: 1, startCharIndex: 0, endCharIndex: 300 }, { pageNumber: 2, startCharIndex: 300, endCharIndex: 300 }, { pageNumber: 3, startCharIndex: 302, endCharIndex: 1000 }],
    chapters: [{ id: 'a', startCharacterIndex: 0 }, { id: 'b', startCharacterIndex: 500 }]
  };
  await test('pageFor skips blank pages', () => { eq(P.pageFor(doc, 301), 1); eq(P.pageFor(doc, 302), 3); eq(P.pageFor(doc, 10), 1); });
  await test('chapterFor and build produce a consistent record', () => {
    const sentences = [{ start: 0, end: 10 }, { start: 600, end: 700 }];
    const r = P.build(doc, sentences, 1);
    eq(r.characterIndex, 600); eq(r.chapterId, 'b'); eq(r.pageNumber, 3); eq(r.percentage, 60); eq(r.completed, false);
  });
  await test('completed record and resolve semantics', () => {
    const sentences = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }];
    const c = P.completed(doc, sentences);
    eq(c.completed, true); eq(c.percentage, 100);
    eq(P.resolveSentenceIndex(c, sentences), 0, 'completed reopens at the start');
    eq(P.resolveSentenceIndex({ characterIndex: 20, sentenceIndex: 1 }, sentences), 1);
    eq(P.resolveSentenceIndex({ characterIndex: 22, sentenceIndex: 5 }, sentences), 1, 'stale sentence index falls back to nearest boundary');
    eq(P.resolveSentenceIndex({ characterIndex: 35 }, sentences), 2, 'gap resolves to the next sentence');
    eq(P.resolveSentenceIndex({ characterIndex: 9999 }, sentences), 2, 'beyond the end clamps');
  });
  await test('autosaver throttles, flushes, disposes and drains', async () => {
    const saved = [];
    const a = P.createAutosaver(async (p) => { await wait(20); saved.push(p); }, 100);
    a.touch(1); a.touch(2); a.touch(3);
    await wait(40);
    eq(saved, [1], 'first touch writes immediately');
    await wait(150);
    eq(saved, [1, 3], 'latest pending value written after the interval');
    await a.flush(4);
    eq(saved, [1, 3, 4]);
    a.touch(5); a.dispose();
    await a.idle();
    await wait(150);
    eq(saved, [1, 3, 4], 'nothing written after dispose');
    await a.flush(6);
    eq(saved, [1, 3, 4], 'flush after dispose is ignored');
    assert(a.isDisposed());
  });

  // ------------------------------------------------------------ chapterDetectionService
  function mkExtraction(pages, outline) {
    // pages: [{ lines: [{ text, size, bold, top }] }]
    const built = pages.map(p => p.lines.map(l => ({ text: l.text, fontSize: l.size || 11, bold: !!l.bold, topFraction: l.top == null ? 0.5 : l.top, y: 0, x: 0 })));
    const { pages: out, fullText } = PDF._internal.assemble(built);
    return { numPages: out.length, pages: out, fullText, outline: outline || [], title: 't', filename: 't.pdf' };
  }
  const bodyLines = (n, seed) => Array.from({ length: n }, (_, i) => ({ text: `Body line ${seed}-${i} with enough ordinary words to look like prose.` }));

  await test('outline is preferred over headings and maps to text positions', () => {
    const ex = mkExtraction([
      { lines: [{ text: 'Intro', size: 20, bold: true, top: 0.1 }, ...bodyLines(5, 'a')] },
      { lines: bodyLines(5, 'b') },
      { lines: [{ text: 'Chapter One', size: 20, bold: true, top: 0.1 }, ...bodyLines(5, 'c')] }
    ], [{ title: 'Intro', pageNumber: 1, level: 0 }, { title: 'Chapter One', pageNumber: 3, level: 0 }]);
    const r = C.detect(ex);
    eq(r.method, 'outline');
    eq(r.chapters.map(c => [c.title, c.startPage, c.endPage]), [['Intro', 1, 2], ['Chapter One', 3, 3]]);
    assert(ex.fullText.slice(r.chapters[1].startCharacterIndex).startsWith('Chapter One'), 'chapter start points at its heading');
    eq(r.chapters[0].endCharacterIndex, r.chapters[1].startCharacterIndex - 1);
  });
  await test('outline entries on a blank page or with duplicate titles stay valid and unique', () => {
    const ex = mkExtraction([
      { lines: [{ text: 'Exercise', size: 20, bold: true, top: 0.1 }, ...bodyLines(4, 'a')] },
      { lines: [] },                                                   // blank page 2
      { lines: [{ text: 'Exercise', size: 20, bold: true, top: 0.1 }, ...bodyLines(4, 'b')] }
    ], [{ title: 'Exercise', pageNumber: 1, level: 0 }, { title: 'Opener', pageNumber: 2, level: 0 }, { title: 'Exercise', pageNumber: 3, level: 0 }]);
    const r = C.detect(ex);
    eq(r.method, 'outline');
    const ids = r.chapters.map(c => c.id);
    eq(new Set(ids).size, ids.length, 'ids unique');
    for (let i = 1; i < r.chapters.length; i++) assert(r.chapters[i].startCharacterIndex > r.chapters[i - 1].startCharacterIndex, 'ascending starts');
    for (const c of r.chapters) assert(c.startCharacterIndex < ex.fullText.length, 'start within text');
    assert(r.chapters.some(c => c.startPage === 3), 'second Exercise present');
    assert(ex.fullText.slice(r.chapters[r.chapters.length - 1].startCharacterIndex).startsWith('Exercise'), 'last chapter starts at its heading');
  });
  await test('table of contents resolves the printed page offset', () => {
    const toc = [{ text: 'Contents', size: 18, bold: true, top: 0.1 }, { text: 'Alpha Section .......... 1' }, { text: 'Beta Section ........... 3' }, { text: 'Gamma Section .......... 5' }, { text: 'Delta Section .......... 7' }];
    const pages = [{ lines: [{ text: 'Title Page', size: 30 }] }, { lines: toc }];
    for (let printed = 1; printed <= 8; printed++) {
      const head = { 1: 'Alpha Section', 3: 'Beta Section', 5: 'Gamma Section', 7: 'Delta Section' }[printed];
      pages.push({ lines: [...(head ? [{ text: head, size: 16, bold: true, top: 0.1 }] : []), ...bodyLines(4, 'p' + printed)] });
    }
    const r = C.detect(mkExtraction(pages, []));
    eq(r.method, 'toc');
    eq(r.chapters.map(c => [c.title, c.startPage]), [['Alpha Section', 3], ['Beta Section', 5], ['Gamma Section', 7], ['Delta Section', 9]]);
  });
  await test('heading detection ignores running headers and joins chapter number with its title', () => {
    const pages = [];
    for (let i = 0; i < 6; i++) {
      const lines = [{ text: 'My Running Header', size: 9, top: 0.04 }];
      if (i % 3 === 0) lines.push({ text: `Chapter ${i / 3 + 1}`, size: 22, bold: true, top: 0.1 }, { text: 'A Fine Title ' + i, size: 16, bold: true, top: 0.14 });
      lines.push(...bodyLines(6, 'h' + i));
      lines.push({ text: String(i + 1), size: 9, top: 0.96 });
      pages.push({ lines });
    }
    const r = C.detect(mkExtraction(pages, []));
    eq(r.method, 'headings');
    eq(r.chapters.map(c => c.title), ['Chapter 1 – A Fine Title 0', 'Chapter 2 – A Fine Title 3']);
    assert(!r.chapters.some(c => /running header/i.test(c.title)), 'running header must not be a chapter');
  });
  await test('falls back to page groups when nothing looks like a chapter', () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ lines: bodyLines(8, 'z' + i) }));
    const r = C.detect(mkExtraction(pages, []));
    eq(r.method, 'pages');
    eq(r.chapters.length, 3);
    eq(r.chapters[0].startPage, 1); eq(r.chapters[2].endPage, 12);
  });

  // ------------------------------------------------------------ pdfService internals
  await test('findRepeated only removes recurring lines at the page edges', () => {
    const mk = (top) => [{ text: 'Journal Header', topFraction: top }, { text: 'Remember: habits compound.', topFraction: 0.5 }, { text: 'unique ' + Math.random(), topFraction: 0.4 }];
    const pages = [mk(0.04), mk(0.05), mk(0.04), mk(0.06)];
    const rep = PDF._internal.findRepeated(pages);
    assert(rep.has('journal header'), 'edge header detected');
    assert(!rep.has('remember habits compound'), 'body phrase must survive');
  });
  await test('linesToText drops page numbers only at the edges and keeps body numbers', () => {
    const lines = [
      { text: 'Chapter', fontSize: 20, bold: true, topFraction: 0.1 },
      { text: 'In 2024 the total was', fontSize: 11, bold: false, topFraction: 0.3 },
      { text: '2024', fontSize: 11, bold: false, topFraction: 0.4 },
      { text: 'and that is the end.', fontSize: 11, bold: false, topFraction: 0.5 },
      { text: '17', fontSize: 9, bold: false, topFraction: 0.96 }
    ];
    const t = PDF._internal.linesToText(lines, new Set());
    assert(t.includes('2024'), 'body number kept');
    assert(!/\b17\b/.test(t), 'edge page number dropped');
    assert(t.startsWith('Chapter\n\n'), 'heading becomes its own paragraph');
  });
  function item(str, x, y, w, size) { return { str, transform: [size, 0, 0, size, x, y], width: w, height: size, fontName: 'f1' }; }
  await test('buildLines reads two columns column by column and keeps full-width headings in sequence', () => {
    const items = [item('Big Heading Across The Page', 72, 740, 420, 18)];
    for (let i = 0; i < 12; i++) { items.push(item('L' + i, 72, 700 - i * 14, 200, 10)); items.push(item('R' + i, 320, 700 - i * 14, 200, 10)); }
    const lines = PDF._internal.buildLines({ items, styles: {} }, { width: 612, height: 792 });
    const texts = lines.map(l => l.text);
    eq(texts[0], 'Big Heading Across The Page');
    eq(texts.slice(1, 13), Array.from({ length: 12 }, (_, i) => 'L' + i), 'left column first');
    eq(texts.slice(13), Array.from({ length: 12 }, (_, i) => 'R' + i), 'then right column');
  });
  await test('buildLines keeps single-column pages in top-to-bottom order and merges runs on a line', () => {
    const items = [item('Hello', 72, 700, 40, 11), item('world', 115, 700, 40, 11), item('Second line', 72, 686, 100, 11), item('Third', 72, 672, 40, 11)];
    const lines = PDF._internal.buildLines({ items, styles: {} }, { width: 612, height: 792 });
    eq(lines.map(l => l.text), ['Hello world', 'Second line', 'Third']);
  });
  await test('extract uses a fallback name for a Blob without a name and cleans up on failure', async () => {
    const bad = new Blob(['not a pdf'], { type: 'application/pdf' });
    let threw = false;
    try { await PDF.extract(bad); } catch (e) { threw = true; }
    assert(threw, 'invalid data must reject');
    const res = await fetch('../test-fixtures/book_outline.pdf?t=' + Date.now(), { cache: 'no-store' });
    const blob = await res.blob();
    const ex = await PDF.extract(blob);
    eq(ex.filename, 'document.pdf');
    eq(ex.numPages, 12);
    assert(ex.fullText.length > 1000);
  });
  await test('columns fixture: header/footer removed, recurring body line and body number kept, columns not interleaved', async () => {
    const blob = await (await fetch('../test-fixtures/book_columns.pdf?t=' + Date.now(), { cache: 'no-store' })).blob();
    const ex = await PDF.extract(blob);
    const t = ex.fullText;
    assert(!t.includes('Journal of Testing'), 'running header removed');
    assert((t.match(/Remember: habits compound\./g) || []).length === 6, 'recurring body line kept on every page');
    assert((t.match(/\b2024\b/g) || []).length === 6, 'numeric body line kept');
    const p1 = ex.pages[0].text;
    const pos = (m) => p1.indexOf(m);
    assert(pos('LEFT-START-MARKER') >= 0 && pos('RIGHT-START-MARKER') >= 0, 'markers present');
    assert(pos('LEFT-START-MARKER') < pos('LEFT-END-MARKER') && pos('LEFT-END-MARKER') < pos('RIGHT-START-MARKER') && pos('RIGHT-START-MARKER') < pos('RIGHT-END-MARKER'),
      'columns must not interleave: ' + p1.slice(0, 200));
    assert(pos('Two Column Article') < pos('LEFT-START-MARKER'), 'full-width heading comes first');
  });
  await test('blank-page fixture: outline chapters valid, blank page owns no text, long paragraph chunked for speech', async () => {
    const blob = await (await fetch('../test-fixtures/book_blank.pdf?t=' + Date.now(), { cache: 'no-store' })).blob();
    const ex = await PDF.extract(blob);
    const blank = ex.pages[2];
    eq(blank.text, ''); eq(blank.startCharIndex, blank.endCharIndex);
    const r = C.detect(ex);
    eq(r.method, 'outline');
    for (const c of r.chapters) assert(c.startCharacterIndex < ex.fullText.length && c.startCharacterIndex >= 0);
    const ids = r.chapters.map(c => c.id); eq(new Set(ids).size, ids.length);
    const sentences = T.segmentSentences(ex.fullText);
    const longest = sentences.reduce((a, b) => b.text.length > a.text.length ? b : a);
    assert(longest.text.length > 400, 'fixture has a long unpunctuated paragraph');
    const chunks = T.splitForSpeech(longest.text, 220);
    assert(chunks.length >= 3 && chunks.every(c => c.length <= 220));
  });
  await test('scanned fixture yields no text', async () => {
    const blob = await (await fetch('../test-fixtures/book_scanned.pdf?t=' + Date.now(), { cache: 'no-store' })).blob();
    const ex = await PDF.extract(blob);
    eq(ex.fullText.trim(), '');
    eq(ex.numPages, 2);
  });

  // ------------------------------------------------------------ documentStorageService (isolated DB)
  const TEST_DB = 'readerLibraryTest';
  await new Promise((res) => { const r = indexedDB.deleteDatabase(TEST_DB); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  S.configure({ dbName: TEST_DB });
  const mkEx = (text, title) => PDF.fromPlainText(text, title);
  const stores = ['documents', 'texts', 'files', 'progress'];
  async function rawCounts() {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(TEST_DB, 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const out = {};
    for (const s of stores) out[s] = await new Promise((res, rej) => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    db.close();
    return out;
  }
  let docA, docB;
  await test('createDocument writes all stores atomically and the mirror', async () => {
    docA = await S.createDocument({ extraction: mkEx('Book A sentence one. Sentence two. Sentence three.', 'A'), chapters: [], chapterMethod: 'none', file: new Blob(['pdf'], { type: 'application/pdf' }) });
    docB = await S.createDocument({ extraction: mkEx('Book B first. Book B second.', 'B'), chapters: [], chapterMethod: 'none', file: null });
    const c = await rawCounts();
    eq(c, { documents: 2, texts: 2, files: 1, progress: 2 });
    assert(localStorage.getItem('reader.progress.' + TEST_DB + '.' + docA.id), 'mirror written');
  });
  await test('createDocument with nothing to save leaves no partial records', async () => {
    let threw = false;
    try { await S.createDocument({ extraction: { fullText: '   ', pages: [], numPages: 0 }, chapters: [] }); } catch (e) { threw = true; }
    assert(threw);
    eq(await rawCounts(), { documents: 2, texts: 2, files: 1, progress: 2 });
  });
  await test('a failing write inside the create transaction rolls everything back', async () => {
    // A File object cannot be structured-cloned when its blob is detached? Use an uncloneable value instead: a function on the extraction
    const badEx = mkEx('Some text here.', 'Bad');
    let threw = false;
    try { await S.createDocument({ extraction: badEx, chapters: [{ id: 'x', fn: () => 1 }], chapterMethod: 'none', file: null }); } catch (e) { threw = true; }
    assert(threw, 'uncloneable chapter must fail');
    eq(await rawCounts(), { documents: 2, texts: 2, files: 1, progress: 2 }, 'no partial records');
  });
  await test('progress round-trips and list merges it', async () => {
    const ok = await S.saveProgress(docA.id, { pageNumber: 1, characterIndex: 21, sentenceIndex: 1, chapterId: null, percentage: 42, completed: false });
    eq(ok, true);
    const p = await S.getProgress(docA.id);
    eq(p.characterIndex, 21);
    const list = await S.list();
    eq(list.find(d => d.id === docA.id).progress.percentage, 42);
  });
  await test('removeDocument deletes every store and the mirror, leaving other documents intact', async () => {
    await S.removeDocument(docA.id);
    eq(await rawCounts(), { documents: 1, texts: 1, files: 0, progress: 1 });
    eq(localStorage.getItem('reader.progress.' + TEST_DB + '.' + docA.id), null, 'mirror removed');
    const list = await S.list();
    eq(list.map(d => d.id), [docB.id]);
    eq(await S.getText(docB.id), 'Book B first. Book B second.');
  });
  await test('saveProgress after deletion is discarded and leaves no orphan', async () => {
    const ok = await S.saveProgress(docA.id, { pageNumber: 1, characterIndex: 5, sentenceIndex: 0, percentage: 1, completed: false });
    eq(ok, false);
    eq((await rawCounts()).progress, 1);
    eq(localStorage.getItem('reader.progress.' + TEST_DB + '.' + docA.id), null, 'no orphan mirror');
    eq(await S.getProgress(docA.id), null);
  });
  await test('removeDocument of a missing id is harmless', async () => {
    await S.removeDocument('doc_missing');
    eq((await rawCounts()).documents, 1);
  });
  await test('connection recovers after the database is deleted underneath it', async () => {
    await S.list(); // ensure open
    await new Promise((res, rej) => { const r = indexedDB.deleteDatabase(TEST_DB); r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => { /* versionchange handler closes our connection */ }; });
    const list = await S.list();
    eq(list, [], 'reopened fresh database');
    const d = await S.createDocument({ extraction: mkEx('After recovery.', 'R'), chapters: [], chapterMethod: 'none', file: null });
    assert(d.id);
  });
  await test('a failed open is not cached forever', async () => {
    const realOpen = indexedDB.open;
    let calls = 0;
    indexedDB.open = function () { calls++; throw new Error('simulated open failure'); };
    S.configure({ dbName: TEST_DB });
    let threw = false;
    try { await S.check(); } catch (e) { threw = true; }
    assert(threw, 'first open fails');
    indexedDB.open = realOpen;
    await S.check(); // must succeed now
    assert(calls === 1);
  });

  // ------------------------------------------------------------ cloud voices (mocked endpoint)
  await test('cloud voice requests carry the access code and surface auth errors', async () => {
    const Tts = window.TtsService;
    window.READER_CONFIG = { cloudTts: true, cloudTtsEndpoint: '/api/tts' };
    assert(Tts.cloudAvailable(), 'cloud voices offered when configured');
    assert(Tts.getCloudVoices().some(v => v.key === 'cloud:onyx'));
    const calls = [];
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => { calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return { status: 401, ok: false, json: async () => ({ error: 'Access code required.' }) }; };
    Tts.setCredentialsProvider(async () => ({ accessCode: 'secret', bearer: '' }));
    Tts.setVoiceKey('cloud:onyx');
    const errors = [];
    Tts.speakFrom([{ text: 'Hello there.' }], 0, { onError: (e) => errors.push(e) });
    await wait(200);
    window.fetch = realFetch;
    Tts.stop();
    eq(calls.length, 1); eq(calls[0].url, '/api/tts'); eq(calls[0].headers['x-access-code'], 'secret'); eq(calls[0].body, { text: 'Hello there.', voice: 'onyx' });
    eq(errors, ['cloud-auth']);
    assert(!Tts.isPlaying());
  });
  await test('cloud voice service errors are reported with their message and other statuses do not loop', async () => {
    const Tts = window.TtsService;
    const realFetch = window.fetch;
    let n = 0;
    window.fetch = async () => { n++; return { status: 503, ok: false, json: async () => ({ error: 'Cloud voices are not configured on this deployment.' }) }; };
    const errors = [];
    Tts.speakFrom([{ text: 'One.' }, { text: 'Two.' }], 0, { onError: (e) => errors.push(e) });
    await wait(200);
    window.fetch = realFetch; Tts.stop();
    eq(errors, ['cloud:Cloud voices are not configured on this deployment.']);
    assert(n <= 2, 'at most the current sentence and one prefetch');
    delete window.READER_CONFIG;
  });

  // ------------------------------------------------------------ ttsService guards
  await test('tts entry points are guarded when speech is unavailable', () => {
    const Tts = window.TtsService;
    // These must not throw whatever the environment
    Tts.pause(); Tts.resume(); Tts.stop();
    assert(typeof Tts.available === 'boolean');
  });

  const failed = results.filter(r => !r.ok);
  summary.textContent = `${results.length - failed.length} passed, ${failed.length} failed`;
  summary.className = failed.length ? 'fail' : 'pass';
  window.__results = results;
  window.__done = true;
})();
