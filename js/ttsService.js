/**
 * ttsService: wraps the browser's speech synthesis. Speaks one sentence at a
 * time (long utterances get cut off in Chrome, so very long sentences are
 * split into chunks that still report as one sentence), reports which
 * sentence is playing, and ranks voices so the good ones come first.
 * Voice or speed changes made while paused are applied when playback resumes.
 */
window.TtsService = (function () {
  const synth = window.speechSynthesis || null;
  const MAX_UTTERANCE = 220;

  const NOVELTY = new Set(['Albert','Bad News','Bahh','Bells','Boing','Bubbles','Cellos','Fred','Good News',
    'Jester','Junior','Kathy','Organ','Ralph','Superstar','Trinoids','Whisper','Wobble','Zarvox',
    'Eddy','Flo','Grandma','Grandpa','Reed','Rocko','Sandy','Shelley']);
  const JARVIS = ['Daniel','Oliver','Jamie','Arthur','Ryan','George'];

  let voices = [];
  let voiceKeySelected = null;
  let rate = 1;
  let generation = 0;
  let playing = false, paused = false, current = -1;
  let settingsDirty = false;      // changed while paused; apply on resume
  let session = null;             // { sentences, handlers, index } for restarts
  const listeners = new Set();

  function baseName(v) { return v.name.replace(/\s*\(.*$/, '').trim(); }
  function voiceKey(v) { return v.voiceURI + '|' + v.name + '|' + v.lang; }
  function quality(v) {
    const n = v.name.toLowerCase();
    if (n.includes('premium') || n.includes('siri')) return 3;
    if (n.includes('enhanced') || n.includes('natural') || n.includes('neural')) return 2;
    if (NOVELTY.has(baseName(v))) return 0;
    return 1;
  }
  function isJarvis(v) { return v.lang === 'en-GB' && JARVIS.includes(baseName(v)); }
  function groupName(v) {
    if (!v.lang.startsWith('en')) return 'Other languages';
    return ({ 3: 'Best quality', 2: 'Best quality', 1: 'Standard', 0: 'Novelty (for fun)' })[quality(v)];
  }

  function loadVoices() {
    if (!synth) return [];
    const list = synth.getVoices();
    if (!list.length) return voices;
    voices = list.slice().sort((a, b) => {
      const en = (v) => v.lang.startsWith('en') ? 0 : 1;
      return en(a) - en(b) || quality(b) - quality(a) || (isJarvis(b) - isJarvis(a)) || a.name.localeCompare(b.name);
    });
    if (!voiceKeySelected || !voices.some(v => voiceKey(v) === voiceKeySelected)) {
      const pick = voices.find(v => isJarvis(v) && quality(v) >= 2)
        || voices.find(v => quality(v) >= 2 && v.lang.startsWith('en'))
        || voices.find(v => isJarvis(v))
        || voices.find(v => v.default) || voices[0];
      voiceKeySelected = pick ? voiceKey(pick) : null;
    }
    listeners.forEach(fn => { try { fn(voices); } catch (e) { console.warn(e); } });
    return voices;
  }
  if (synth) synth.addEventListener('voiceschanged', loadVoices);

  function selectedVoice() { return voices.find(v => voiceKey(v) === voiceKeySelected); }
  function hasHighQualityEnglish() { return voices.some(v => v.lang.startsWith('en') && quality(v) >= 2); }

  function makeUtterance(text) {
    const u = new SpeechSynthesisUtterance(text);
    const v = selectedVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = rate;
    return u;
  }

  /**
   * Speak sentences[startIndex..] in order.
   * @param {{text:string}[]} sentences
   * @param {number} startIndex
   * @param {{onSentenceStart?:(i:number)=>void, onFinish?:()=>void, onError?:(err:string)=>void}} handlers
   */
  function speakFrom(sentences, startIndex, handlers) {
    const h = handlers || {};
    if (!synth) { h.onError && h.onError('unavailable'); return; }
    stop();
    const myGen = ++generation;
    session = { sentences, handlers: h, index: startIndex };
    playing = true; paused = false; settingsDirty = false;
    function speakSentence() {
      if (myGen !== generation) return;
      const index = session.index;
      if (index >= sentences.length) {
        playing = false; current = -1;
        h.onFinish && h.onFinish();
        return;
      }
      const chunks = window.TextService.splitForSpeech(sentences[index].text, MAX_UTTERANCE);
      let ci = 0;
      function speakChunk() {
        if (myGen !== generation) return;
        if (ci >= chunks.length) { session.index = index + 1; speakSentence(); return; }
        const u = makeUtterance(chunks[ci]);
        const first = ci === 0;
        u.onstart = () => {
          if (myGen !== generation) return;
          if (first) { current = index; h.onSentenceStart && h.onSentenceStart(index); }
        };
        u.onend = () => { if (myGen !== generation) return; ci += 1; speakChunk(); };
        u.onerror = (e) => {
          if (myGen !== generation) return;
          if (e.error === 'interrupted' || e.error === 'canceled') return;
          playing = false; paused = false;
          h.onError && h.onError(e.error);
        };
        synth.speak(u);
      }
      speakChunk();
    }
    speakSentence();
  }

  function restartCurrent() {
    if (!session || !playing) return;
    const s = session;
    speakFrom(s.sentences, s.index, s.handlers);
  }
  function settingsChanged() {
    if (!playing) return;
    if (paused) settingsDirty = true;
    else restartCurrent();
  }

  function pause() {
    if (!synth || !playing || paused) return;
    synth.pause(); paused = true;
  }
  function resume() {
    if (!synth || !playing || !paused) return;
    if (settingsDirty) { settingsDirty = false; restartCurrent(); return; }
    synth.resume(); paused = false;
  }
  function stop() {
    generation += 1;
    if (synth) synth.cancel();
    playing = false; paused = false; current = -1; settingsDirty = false;
  }
  function preview(text) {
    if (!synth) return false;
    stop();
    synth.speak(makeUtterance(text || 'Good evening, sir. All systems are online and ready.'));
    return true;
  }

  return {
    available: !!synth,
    loadVoices, getVoices: () => voices, onVoicesChanged: (fn) => listeners.add(fn),
    voiceKey, quality, isJarvis, groupName, hasHighQualityEnglish,
    getVoiceKey: () => voiceKeySelected,
    setVoiceKey: (k) => { if (k === voiceKeySelected) return; voiceKeySelected = k; settingsChanged(); },
    getRate: () => rate,
    setRate: (r) => { const next = Math.min(3, Math.max(0.5, parseFloat(r) || 1)); if (next === rate) return; rate = next; settingsChanged(); },
    speakFrom, pause, resume, stop, preview,
    isPlaying: () => playing, isPaused: () => paused, currentIndex: () => current
  };
})();
