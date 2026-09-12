/**
 * textService: splits text into sentences while remembering where each one
 * sits in the full document, so a reading position can be stored as a
 * character index and mapped back to a sentence later.
 */
window.TextService = (function () {
  // Sentence end: punctuation (optionally a closing quote/bracket) then whitespace, or a blank line. No lookbehind, for older Safari.
  const BOUNDARY = /[.!?…]["')\]]?\s+|\n{2,}/g;

  /** @returns {{text:string, start:number, end:number}[]} sentences with character offsets */
  function segmentSentences(text) {
    const out = [];
    if (!text) return out;
    let last = 0;
    const push = (from, to) => {
      const raw = text.slice(from, to);
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (trimmed) out.push({ text: trimmed, start: from + lead, end: from + lead + trimmed.length });
    };
    BOUNDARY.lastIndex = 0;
    let m;
    while ((m = BOUNDARY.exec(text)) !== null) {
      const ws = (m[0].match(/\s+$/) || [''])[0];
      push(last, m.index + m[0].length - ws.length); // keep the punctuation with the sentence
      last = m.index + m[0].length;
      if (m[0].length === 0) BOUNDARY.lastIndex++;
    }
    push(last, text.length);
    return out;
  }

  /** Index of the sentence containing charIndex, or the next sentence boundary after it. */
  function sentenceAt(sentences, charIndex) {
    if (!sentences.length) return 0;
    let lo = 0, hi = sentences.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].end <= charIndex) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * Split one sentence into pieces short enough for a single utterance.
   * Prefers clause punctuation, then whitespace, then a hard cut. The pieces
   * concatenate (with the removed whitespace) back to the original text, so
   * character offsets of the sentence are unaffected.
   */
  function splitForSpeech(text, maxLen) {
    const max = maxLen || 220;
    const out = [];
    let rest = text;
    const strategies = [
      { re: /[,;:—–](?=\s)[^,;:—–]*$/, keep: 1 },  // after the last clause break
      { re: /\s[^\s]*$/, keep: 0 }                  // before the last word
    ];
    while (rest.length > max) {
      const window = rest.slice(0, max);
      let cut = -1;
      for (const { re, keep } of strategies) {
        const m = window.match(re);
        if (m && m.index >= max * 0.4) { cut = m.index + keep; break; }
      }
      if (cut < max * 0.4) cut = max;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }

  function normalize(s) {
    return (s || '').toLowerCase().replace(/[–—]/g, '-').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  return { segmentSentences, sentenceAt, splitForSpeech, normalize };
})();
