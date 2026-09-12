/**
 * readingProgressService: converts between "where the reader is" and the
 * stored progress record, and throttles saves while playback is running.
 *
 * The stored position is a character index into the extracted text plus
 * helpers (page, sentence, chapter) that make it cheap to display and
 * robust to restore: if the exact character index cannot be matched, the
 * nearest sentence boundary is used.
 */
window.ReadingProgressService = (function () {
  function pageFor(doc, charIndex) {
    const pages = doc.pages || [];
    let result = 1;
    for (const p of pages) {
      if (p.startCharIndex >= p.endCharIndex) continue; // blank page: no text to own
      if (p.startCharIndex <= charIndex) result = p.pageNumber; else break;
    }
    return result;
  }

  function chapterFor(doc, charIndex) {
    const chapters = doc.chapters || [];
    let result = null;
    for (const c of chapters) {
      if (c.startCharacterIndex <= charIndex) result = c; else break;
    }
    return result;
  }

  function chapterIndex(doc, chapterId) {
    return (doc.chapters || []).findIndex(c => c.id === chapterId);
  }

  /** Build a progress record for the sentence currently being read. */
  function build(doc, sentences, sentenceIndex, extra) {
    const s = sentences[sentenceIndex];
    const charIndex = s ? s.start : 0;
    const total = Math.max(1, doc.textLength || (sentences.length ? sentences[sentences.length - 1].end : 1));
    const chapter = chapterFor(doc, charIndex);
    return Object.assign({
      pageNumber: pageFor(doc, charIndex),
      characterIndex: charIndex,
      sentenceIndex,
      chapterId: chapter ? chapter.id : null,
      percentage: Math.min(100, Math.round((charIndex / total) * 1000) / 10),
      completed: false
    }, extra || {});
  }

  /** The record for a book read to the end. Position stays at the last sentence; reopening starts over. */
  function completed(doc, sentences) {
    const last = build(doc, sentences, Math.max(0, sentences.length - 1));
    return Object.assign(last, { percentage: 100, completed: true });
  }

  /** Find the sentence to resume from. Exact match on the stored index when it still lines up, else nearest boundary. */
  function resolveSentenceIndex(progress, sentences) {
    if (!progress || !sentences.length) return 0;
    if (progress.completed) return 0;
    const ci = progress.characterIndex || 0;
    const si = progress.sentenceIndex;
    if (Number.isInteger(si) && sentences[si] && Math.abs(sentences[si].start - ci) <= 40) return si;
    const idx = window.TextService.sentenceAt(sentences, ci);
    return Math.min(Math.max(0, idx), sentences.length - 1);
  }

  /**
   * Throttled saver: while reading, writes at most once per interval, but
   * flush() always writes the latest position immediately (pause, stop, leave).
   * dispose() drops anything pending and refuses later writes; idle() resolves
   * once every write already handed to saveFn has settled.
   */
  function createAutosaver(saveFn, intervalMs) {
    let pending = null, timer = null, lastSaved = 0, disposed = false;
    const inflight = new Set();
    const interval = intervalMs || 2500;
    function write() {
      if (disposed || !pending) return Promise.resolve();
      const p = pending; pending = null; lastSaved = Date.now();
      clearTimeout(timer); timer = null;
      const pr = Promise.resolve().then(() => saveFn(p)).catch(err => { console.warn('Progress save failed', err); });
      inflight.add(pr);
      pr.finally(() => inflight.delete(pr));
      return pr;
    }
    return {
      touch(progress) {
        if (disposed) return;
        pending = progress;
        const due = interval - (Date.now() - lastSaved);
        if (due <= 0) write();
        else if (!timer) timer = setTimeout(write, due);
      },
      flush(progress) {
        if (disposed) return Promise.resolve();
        if (progress) pending = progress;
        return write();
      },
      cancel() { pending = null; clearTimeout(timer); timer = null; },
      dispose() { disposed = true; pending = null; clearTimeout(timer); timer = null; },
      idle() { return Promise.all([...inflight]).then(() => undefined); },
      isDisposed() { return disposed; }
    };
  }

  return { pageFor, chapterFor, chapterIndex, build, completed, resolveSentenceIndex, createAutosaver };
})();
