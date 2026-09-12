/**
 * chapterDetectionService: finds the chapters of a document in priority order:
 *   1. PDF outline (bookmarks) written by the author
 *   2. A printed table of contents near the front
 *   3. Heading detection from font size, boldness, position and wording
 * Falls back to page groups so navigation still has something to offer.
 */
window.ChapterDetectionService = (function () {
  const norm = (s) => window.TextService.normalize(s);

  const CHAPTER_WORD = /^(chapter|part|book|section|unit|lesson|act)\s+(\d{1,3}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|thirty)\b/i;
  const NUMBERED = /^\d{1,2}\.?\s+[A-Z][^.]{2,80}$/;
  const MATTER = /^(introduction|prologue|preface|foreword|epilogue|conclusion|afterword|appendix( [a-z0-9])?|acknowledg(e)?ments|glossary|bibliography|index|references|notes|summary|abstract)$/i;
  const JUNK = /^(page\s*)?\d{1,4}$|^[ivxlc]{1,7}$|^\d+\s*(of|\/)\s*\d+$/i;

  function slug(s) { return norm(s).replace(/\s+/g, '-').slice(0, 40) || 'chapter'; }

  /** Where a heading actually sits inside the page text, if we can find it. */
  function locate(page, title) {
    if (!page) return 0;
    if (!page.text) return page.startCharIndex; // blank page: the next page's text starts right after
    const hay = page.text.toLowerCase();
    const needle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    let idx = hay.indexOf(needle);
    if (idx < 0 && needle.length > 12) idx = hay.indexOf(needle.slice(0, 12));
    return page.startCharIndex + (idx >= 0 ? idx : 0);
  }

  function finalize(entries, extraction, method) {
    const pagesByNo = new Map(extraction.pages.map(p => [p.pageNumber, p]));
    const total = extraction.fullText.length;
    let list = entries
      .filter(e => e.title && e.pageNumber >= 1 && e.pageNumber <= extraction.numPages)
      .map(e => ({
        title: e.title.replace(/\s+/g, ' ').trim(),
        startPage: e.pageNumber,
        startCharacterIndex: e.charIndex != null ? e.charIndex : locate(pagesByNo.get(e.pageNumber), e.title)
      }))
      .filter(e => e.startCharacterIndex < total)
      .sort((a, b) => a.startCharacterIndex - b.startCharacterIndex || a.startPage - b.startPage);
    // Drop duplicates that resolve to the same spot (e.g. two outline entries on one blank page)
    list = list.filter((e, i) => i === 0 || e.startCharacterIndex > list[i - 1].startCharacterIndex);
    if (!list.length) return { chapters: [], method: 'none' };
    // Material before the first detected chapter still needs a home
    if (list[0].startCharacterIndex > 1500) {
      list.unshift({ title: 'Beginning', startPage: 1, startCharacterIndex: 0 });
    }
    const chapters = list.map((e, i) => {
      const next = list[i + 1];
      const nextPage = next ? pagesByNo.get(next.startPage) : null;
      const nextStartsAtPageTop = nextPage && next.startCharacterIndex <= nextPage.startCharIndex;
      return {
        id: `${i + 1}-${slug(e.title)}`,
        title: e.title,
        startPage: e.startPage,
        endPage: next ? Math.max(e.startPage, next.startPage - (nextStartsAtPageTop ? 1 : 0)) : extraction.numPages,
        startCharacterIndex: e.startCharacterIndex,
        endCharacterIndex: next ? next.startCharacterIndex - 1 : Math.max(0, total - 1)
      };
    });
    return { chapters, method };
  }

  // ---------- Method 1: outline ----------
  function fromOutline(extraction) {
    const items = (extraction.outline || []).filter(o => o.pageNumber);
    if (!items.length) return null;
    let picked = items.filter(o => o.level === 0);
    if (picked.length < 2) picked = items.filter(o => o.level <= 1);
    if (picked.length < 1) return null;
    return finalize(picked.map(o => ({ title: o.title, pageNumber: o.pageNumber })), extraction, 'outline');
  }

  // ---------- Method 2: printed table of contents ----------
  const TOC_LINE = /^(.{2,90}?)(?:[\s.·•_…\-]{2,}|\s{2,}|\s)(\d{1,4})$/;
  const CONTENTS = /^(table of )?contents$/i;

  function parseTocLines(lines) {
    const entries = [];
    for (const ln of lines) {
      const t = ln.text.trim();
      if (CONTENTS.test(t)) continue;
      const m = t.match(TOC_LINE);
      if (!m) continue;
      const title = m[1].replace(/[\s.·•_…\-]+$/, '').trim();
      const page = parseInt(m[2], 10);
      if (!title || JUNK.test(title) || title.length < 2) continue;
      entries.push({ title, printed: page });
    }
    return entries;
  }

  function fromToc(extraction) {
    const scan = Math.min(extraction.numPages, Math.max(15, Math.ceil(extraction.numPages * 0.1)));
    let entries = [];
    let tocPage = -1;
    for (let i = 0; i < scan; i++) {
      const page = extraction.pages[i];
      const hasHeading = page.lines.some(l => CONTENTS.test(l.text.trim()));
      const parsed = parseTocLines(page.lines);
      if (hasHeading || parsed.length >= 4) {
        if (tocPage < 0) tocPage = i;
        entries = entries.concat(parsed);
      } else if (tocPage >= 0 && parsed.length < 3) {
        break; // TOC ended
      }
    }
    if (entries.length < 2) return null;
    // Keep page numbers monotonic; a TOC never goes backwards
    entries = entries.filter((e, i) => i === 0 || e.printed >= entries[i - 1].printed);
    if (entries.length < 2) return null;

    // Printed page numbers rarely equal PDF page indices; find the offset that lines the titles up
    const pageText = extraction.pages.map(p => norm(p.text));
    let best = { offset: null, score: -1 };
    const maxOffset = Math.min(40, extraction.numPages);
    for (let offset = 0; offset <= maxOffset; offset++) {
      let score = 0;
      for (const e of entries) {
        const idx = e.printed + offset - 1;
        if (idx <= tocPage || idx >= extraction.numPages) continue;
        const key = norm(e.title).slice(0, 30);
        if (key && pageText[idx].includes(key)) score++;
      }
      if (score > best.score) best = { offset, score };
    }
    const needed = Math.max(2, Math.ceil(entries.length * 0.3));
    if (best.score < needed) return null;
    const mapped = entries
      .map(e => ({ title: e.title, pageNumber: e.printed + best.offset }))
      .filter(e => e.pageNumber > tocPage + 1 && e.pageNumber <= extraction.numPages);
    if (mapped.length < 2) return null;
    return finalize(mapped, extraction, 'toc');
  }

  // ---------- Method 3: headings ----------
  function bodyFontSize(extraction) {
    const hist = new Map();
    for (const p of extraction.pages) for (const l of p.lines) {
      hist.set(l.fontSize, (hist.get(l.fontSize) || 0) + l.text.length);
    }
    let best = 0, size = 11;
    for (const [s, n] of hist) if (n > best) { best = n; size = s; }
    return size;
  }

  function repeatedLines(extraction) {
    const seen = new Map();
    for (const p of extraction.pages) {
      const uniq = new Set(p.lines.map(l => norm(l.text)).filter(Boolean));
      for (const t of uniq) seen.set(t, (seen.get(t) || 0) + 1);
    }
    const repeated = new Set();
    for (const [t, n] of seen) if (n >= 3) repeated.add(t);
    return repeated;
  }

  function fromHeadings(extraction) {
    const body = bodyFontSize(extraction);
    const repeated = repeatedLines(extraction);
    const strong = [];   // wording says "chapter", "introduction", "3. Title"
    const visual = [];   // just looks like a heading
    for (const page of extraction.pages) {
      const lines = page.lines;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const t = l.text.trim();
        if (t.length < 2 || t.length > 90 || JUNK.test(t) || repeated.has(norm(t))) continue;
        if (/[.:;,]$/.test(t) && !NUMBERED.test(t)) continue;
        const wordy = CHAPTER_WORD.test(t) || MATTER.test(t) || NUMBERED.test(t);
        const big = l.fontSize >= body * 1.35;
        const nearTop = l.topFraction <= 0.35;
        const bold = l.bold && l.fontSize >= body * 1.1;
        let title = t;
        // "Chapter 3" on one line and its name on the next: join them
        const next = lines[i + 1];
        if (CHAPTER_WORD.test(t) && t.length <= 20 && next && next.text.length <= 80 &&
            (next.fontSize >= body * 1.15 || next.bold) && !CHAPTER_WORD.test(next.text)) {
          title = `${t} – ${next.text.trim()}`;
        }
        const entry = { title, pageNumber: page.pageNumber, charIndex: locate(page, t), size: l.fontSize };
        if (wordy && (big || bold || nearTop || body === 1)) strong.push(entry);
        else if (big && nearTop) visual.push(entry);
      }
    }
    let picked = null;
    if (strong.length >= 2) {
      picked = strong;
    } else if (visual.length >= 2 && visual.length <= Math.max(3, extraction.numPages * 0.6)) {
      // One heading per page at most: keep the largest
      const byPage = new Map();
      for (const v of visual) if (!byPage.has(v.pageNumber) || byPage.get(v.pageNumber).size < v.size) byPage.set(v.pageNumber, v);
      picked = [...byPage.values()];
    } else if (strong.length === 1) {
      picked = strong;
    }
    if (!picked) return null;
    if (picked.length > 300) picked = picked.slice(0, 300);
    return finalize(picked, extraction, 'headings');
  }

  // ---------- Fallback: page groups ----------
  function fromPages(extraction) {
    if (extraction.numPages < 4) return { chapters: [], method: 'none' };
    const step = extraction.numPages <= 30 ? 5 : 10;
    const entries = [];
    for (let p = 1; p <= extraction.numPages; p += step) {
      const end = Math.min(extraction.numPages, p + step - 1);
      entries.push({ title: `Pages ${p}–${end}`, pageNumber: p, charIndex: extraction.pages[p - 1].startCharIndex });
    }
    return finalize(entries, extraction, 'pages');
  }

  function detect(extraction) {
    return fromOutline(extraction) || fromToc(extraction) || fromHeadings(extraction) || fromPages(extraction);
  }

  return { detect, fromOutline, fromToc, fromHeadings, fromPages };
})();
