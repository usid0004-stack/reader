/**
 * pdfService: turns a PDF file into plain text plus the structural hints
 * chapter detection needs (per-page lines with font size / bold / vertical
 * position, and the PDF outline if the author included one).
 *
 * Reading order: items are grouped into visual lines. When a page has two
 * columns (a vertical gutter that almost no item crosses), each column is
 * read top to bottom before moving to the next; full-width lines such as
 * headings split the page into bands so they stay in sequence.
 */
window.PdfService = (function () {
  const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const EDGE = 0.12; // top/bottom 12% of the page is where running headers, footers and page numbers live

  function cleanPageText(t) {
    return t
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(?<!\n)\n(?!\n)/g, ' ')   // single line breaks are just wrapping
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/(\w)- (?=[a-z])/g, '$1')  // re-join words hyphenated across lines
      .trim();
  }

  function isBoldFont(item, styles) {
    const name = (item.fontName || '') + ' ' + ((styles[item.fontName] || {}).fontFamily || '');
    return /bold|black|heavy|semibold|demibold/i.test(name);
  }

  /** Find a vertical gutter between two text columns, or null for a single-column page. */
  function detectGutter(items, pageWidth) {
    const narrow = items.filter(it => it.w > 0 && it.w < pageWidth * 0.6);
    if (narrow.length < 20) return null;
    let best = null;
    for (let gx = pageWidth * 0.3; gx <= pageWidth * 0.7; gx += pageWidth / 100) {
      let left = 0, right = 0, cross = 0;
      for (const it of narrow) {
        if (it.x + it.w <= gx - 3) left++;
        else if (it.x >= gx + 3) right++;
        else cross++;
      }
      if (cross <= narrow.length * 0.02 && left >= narrow.length * 0.25 && right >= narrow.length * 0.25) {
        const score = Math.min(left, right) - cross * 10;
        if (!best || score > best.score) best = { gx, score };
      }
    }
    return best ? best.gx : null;
  }

  /** Group items (already in one column/band) into lines by vertical position, top first. */
  function groupLines(items, pageHeight) {
    const lines = [];
    for (const it of items) {
      let line = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, it.size * 0.3));
      if (!line) { line = { y: it.y, x: it.x, parts: [] }; lines.push(line); }
      line.parts.push(it);
    }
    for (const line of lines) {
      line.parts.sort((a, b) => a.x - b.x);
      line.x = line.parts[0].x;
      line.text = line.parts.map(p => p.str).join(' ').replace(/\s+/g, ' ').trim();
      line.fontSize = Math.max(...line.parts.map(p => p.size));
      const boldChars = line.parts.filter(p => p.bold).reduce((n, p) => n + p.str.length, 0);
      line.bold = boldChars >= line.text.length * 0.6;
      line.topFraction = pageHeight ? Math.max(0, Math.min(1, 1 - line.y / pageHeight)) : 0.5;
      delete line.parts;
    }
    lines.sort((a, b) => b.y - a.y);
    return lines;
  }

  /** Build the page's visual lines in reading order. */
  function buildLines(content, viewport) {
    const styles = content.styles || {};
    const H = viewport.height, W = viewport.width;
    const items = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      items.push({
        x: item.transform[4], y: item.transform[5], w: item.width || 0, str: item.str,
        size: Math.round(Math.hypot(item.transform[2], item.transform[3]) * 2) / 2 || item.height || 0,
        bold: isBoldFont(item, styles)
      });
    }
    const gutter = detectGutter(items, W);
    if (gutter == null) return groupLines(items, H);

    // Two columns: walk top to bottom; anything crossing the gutter closes the current band
    items.sort((a, b) => b.y - a.y);
    const out = [];
    let left = [], right = [];
    const flush = () => {
      if (left.length) out.push(...groupLines(left, H));
      if (right.length) out.push(...groupLines(right, H));
      left = []; right = [];
    };
    for (const it of items) {
      const crosses = it.x < gutter - 3 && it.x + it.w > gutter + 3;
      if (crosses) { flush(); out.push(...groupLines([it], H)); continue; }
      (it.x + it.w / 2 < gutter ? left : right).push(it);
    }
    flush();
    return out;
  }

  /** The most common font size on a page, weighted by how much text uses it. */
  function bodySize(lines) {
    const hist = new Map();
    for (const l of lines) hist.set(l.fontSize, (hist.get(l.fontSize) || 0) + l.text.length);
    let best = 0, size = 0;
    for (const [s, n] of hist) if (n > best) { best = n; size = s; }
    return size;
  }

  const atEdge = (l) => l.topFraction <= EDGE || l.topFraction >= 1 - EDGE;
  const PAGE_NUMBER = /^(page\s*)?\d{1,4}$|^[ivxlc]{1,7}$|^\d{1,4}\s*(of|\/)\s*\d{1,4}$/i;

  /**
   * Turn a page's visual lines into readable text. Headings and short
   * paragraph-ending lines become paragraph breaks; wrapped lines are joined.
   * Running headers/footers and page numbers are only dropped at the page edges.
   */
  function linesToText(lines, repeated) {
    const body = bodySize(lines);
    const maxLen = Math.max(1, ...lines.map(l => l.text.length));
    const norm = window.TextService.normalize;
    const kept = lines.filter(l => !(atEdge(l) && (repeated.has(norm(l.text)) || PAGE_NUMBER.test(l.text.trim()))));
    let out = '';
    for (let i = 0; i < kept.length; i++) {
      const l = kept[i], next = kept[i + 1];
      out += l.text;
      if (!next) break;
      const heading = (body && l.fontSize >= body * 1.15) || (l.bold && !next.bold);
      const shortEnd = l.text.length < maxLen * 0.6 && /[.!?:"')\]]$/.test(l.text);
      const nextHeading = body && next.fontSize >= body * 1.15;
      out += (heading || shortEnd || nextHeading) ? '\n\n' : ' ';
    }
    return cleanPageText(out);
  }

  /**
   * Short lines that recur on at least 3 pages (and 40% of pages) and sit at
   * the top or bottom of the page most of the time are running headers/footers.
   * Recurring lines in the body of the page are real content and survive.
   */
  function findRepeated(pageLines) {
    const norm = window.TextService.normalize;
    const seen = new Map();
    for (const lines of pageLines) {
      const perPage = new Map();
      for (const l of lines) {
        const t = norm(l.text);
        if (!t || t.length >= 80) continue;
        const cur = perPage.get(t) || { edge: false };
        if (atEdge(l)) cur.edge = true;
        perPage.set(t, cur);
      }
      for (const [t, v] of perPage) {
        const c = seen.get(t) || { count: 0, edge: 0 };
        c.count++; if (v.edge) c.edge++;
        seen.set(t, c);
      }
    }
    const repeated = new Set();
    const threshold = Math.max(3, Math.ceil(pageLines.length * 0.4));
    for (const [t, c] of seen) if (c.count >= threshold && c.edge >= c.count * 0.7) repeated.add(t);
    return repeated;
  }

  /** Resolve an outline entry's destination to a 1-based page number. */
  async function resolvePage(pdf, dest) {
    try {
      let d = dest;
      if (typeof d === 'string') d = await pdf.getDestination(d);
      if (!Array.isArray(d) || !d.length) return null;
      const ref = d[0];
      if (typeof ref === 'number') return ref + 1;
      if (ref && typeof ref === 'object') return (await pdf.getPageIndex(ref)) + 1;
    } catch (e) { /* unresolvable entry */ }
    return null;
  }

  async function readOutline(pdf) {
    let items;
    try { items = await pdf.getOutline(); } catch (e) { items = null; }
    if (!items || !items.length) return [];
    const out = [];
    async function walk(list, level) {
      for (const it of list) {
        const pageNumber = await resolvePage(pdf, it.dest);
        const title = (it.title || '').replace(/\s+/g, ' ').trim();
        if (title) out.push({ title, pageNumber, level });
        if (it.items && it.items.length && level < 2) await walk(it.items, level + 1);
      }
    }
    await walk(items, 0);
    return out;
  }

  /** Assemble pages and the full text from per-page lines. Blank pages own no characters. */
  function assemble(pageLines) {
    const repeated = findRepeated(pageLines);
    const pages = [];
    let fullText = '';
    pageLines.forEach((lines, i) => {
      const text = linesToText(lines, repeated);
      if (text) {
        const startCharIndex = fullText.length ? fullText.length + 2 : 0;
        fullText = fullText.length ? fullText + '\n\n' + text : text;
        pages.push({ pageNumber: i + 1, text, startCharIndex, endCharIndex: fullText.length, lines });
      } else {
        pages.push({ pageNumber: i + 1, text: '', startCharIndex: fullText.length, endCharIndex: fullText.length, lines });
      }
    });
    return { pages, fullText };
  }

  /**
   * @param {File|Blob} file
   * @param {(msg:string)=>void} [onProgress]
   * @returns {Promise<Extraction>}
   */
  async function extract(file, onProgress) {
    if (!window.pdfjsLib) throw new Error('pdf.js is not loaded. PDF support needs an internet connection the first time.');
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
    const report = onProgress || (() => {});
    const filename = (file && typeof file.name === 'string' && file.name) || 'document.pdf';
    report('Opening PDF…');
    const data = await file.arrayBuffer();
    const task = pdfjsLib.getDocument({ data });
    let pdf = null;
    try {
      pdf = await task.promise;
      const pageLines = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        report(`Reading page ${p} of ${pdf.numPages}…`);
        const page = await pdf.getPage(p);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          pageLines.push(buildLines(content, viewport));
        } finally {
          try { page.cleanup(); } catch (e) { /* ignore */ }
        }
      }
      const { pages, fullText } = assemble(pageLines);
      report('Looking for chapters…');
      const outline = await readOutline(pdf);
      let title = filename.replace(/\.pdf$/i, '');
      try {
        const meta = await pdf.getMetadata();
        const t = meta && meta.info && meta.info.Title;
        if (t && String(t).trim().length > 1) title = String(t).trim();
      } catch (e) { /* no metadata */ }
      return { numPages: pdf.numPages, pages, fullText, outline, title, filename };
    } finally {
      try { if (pdf) await pdf.destroy(); else await task.destroy(); } catch (e) { /* ignore */ }
    }
  }

  /** Build an Extraction-shaped object from plain pasted text so the same pipeline can run. */
  function fromPlainText(text, title) {
    const lines = text.split(/\n/).map(t => t.trim()).filter(Boolean)
      .map(t => ({ text: t, fontSize: 1, bold: false, topFraction: 0.5, y: 0, x: 0 }));
    return {
      numPages: 1,
      pages: [{ pageNumber: 1, text, startCharIndex: 0, endCharIndex: text.length, lines }],
      fullText: text,
      outline: [],
      title: title || 'Pasted text',
      filename: ''
    };
  }

  return {
    extract, fromPlainText, cleanPageText,
    _internal: { buildLines, detectGutter, groupLines, linesToText, findRepeated, assemble }
  };
})();
