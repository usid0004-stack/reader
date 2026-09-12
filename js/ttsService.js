/**
 * ttsService: speech for the reader, with two engines behind one interface.
 *   Browser voices  – the device's own speech synthesis, one sentence per utterance
 *   Cloud voices    – audio fetched from api/tts (OpenAI text-to-speech behind a
 *                     Vercel function), identical on every device
 * Sentences stay the unit of progress for both engines. Voice or speed changes
 * made while paused are applied on resume.
 */
window.TtsService = (function () {
  const synth = window.speechSynthesis || null;
  const MAX_UTTERANCE = 220;      // browser voices: Chrome drops long utterances
  const MAX_CLOUD_CHARS = 1200;   // cloud voices: keep requests small and quick
  const CLOUD_PREFIX = 'cloud:';
  const CLOUD_VOICES = [
    { id: 'onyx',    name: 'Onyx',    desc: 'deep and calm, the closest to Jarvis' },
    { id: 'fable',   name: 'Fable',   desc: 'warm narrator, British feel' },
    { id: 'echo',    name: 'Echo',    desc: 'clear and steady' },
    { id: 'alloy',   name: 'Alloy',   desc: 'neutral' },
    { id: 'ash',     name: 'Ash',     desc: 'confident' },
    { id: 'sage',    name: 'Sage',    desc: 'gentle' },
    { id: 'coral',   name: 'Coral',   desc: 'friendly' },
    { id: 'nova',    name: 'Nova',    desc: 'bright' },
    { id: 'shimmer', name: 'Shimmer', desc: 'soft' }
  ];
  // A tiny silent WAV; playing it inside the user's tap unlocks audio on iOS for the fetched clips that follow
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  const NOVELTY = new Set(['Albert','Bad News','Bahh','Bells','Boing','Bubbles','Cellos','Fred','Good News',
    'Jester','Junior','Kathy','Organ','Ralph','Superstar','Trinoids','Whisper','Wobble','Zarvox',
    'Eddy','Flo','Grandma','Grandpa','Reed','Rocko','Sandy','Shelley']);
  const JARVIS = ['Daniel','Oliver','Jamie','Arthur','Ryan','George'];

  let voices = [];
  let voiceKeySelected = null;
  let rate = 1;
  let generation = 0;
  let playing = false, paused = false, current = -1;
  let settingsDirty = false;
  let session = null;                 // { sentences, handlers, index }
  let credentials = async () => ({}); // set by the app: { accessCode, bearer }
  let audioEl = null, audioUnlocked = false;
  const clipCache = new Map();        // "voice|text" -> object URL
  const listeners = new Set();

  // ---------------------------------------------------------------- voices
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
  function cloudAvailable() {
    const c = window.READER_CONFIG || {};
    return !!(c.cloudTts && c.cloudTtsEndpoint && typeof Audio !== 'undefined');
  }
  function isCloudKey(k) { return typeof k === 'string' && k.indexOf(CLOUD_PREFIX) === 0; }
  function cloudVoiceFor(k) { return CLOUD_VOICES.find(v => CLOUD_PREFIX + v.id === k) || null; }
  const usingCloud = () => isCloudKey(voiceKeySelected) && cloudAvailable();

  function loadVoices() {
    if (!synth) return [];
    const list = synth.getVoices();
    if (!list.length) return voices;
    voices = list.slice().sort((a, b) => {
      const en = (v) => v.lang.startsWith('en') ? 0 : 1;
      return en(a) - en(b) || quality(b) - quality(a) || (isJarvis(b) - isJarvis(a)) || a.name.localeCompare(b.name);
    });
    if (!isCloudKey(voiceKeySelected) && (!voiceKeySelected || !voices.some(v => voiceKey(v) === voiceKeySelected))) {
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

  // ---------------------------------------------------------------- browser engine
  function makeUtterance(text) {
    const u = new SpeechSynthesisUtterance(text);
    const v = selectedVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = rate;
    return u;
  }

  function speakBrowser(sentences, h, myGen) {
    function speakSentence() {
      if (myGen !== generation) return;
      const index = session.index;
      if (index >= sentences.length) { playing = false; current = -1; h.onFinish && h.onFinish(); return; }
      const chunks = window.TextService.splitForSpeech(sentences[index].text, MAX_UTTERANCE);
      let ci = 0;
      function speakChunk() {
        if (myGen !== generation) return;
        if (ci >= chunks.length) { session.index = index + 1; speakSentence(); return; }
        const u = makeUtterance(chunks[ci]);
        const first = ci === 0;
        u.onstart = () => { if (myGen !== generation) return; if (first) { current = index; h.onSentenceStart && h.onSentenceStart(index); } };
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

  // ---------------------------------------------------------------- cloud engine
  function audioElement() {
    if (!audioEl) { audioEl = new Audio(); audioEl.preload = 'auto'; }
    return audioEl;
  }
  /** Must run synchronously inside a user gesture so later play() calls are allowed on iOS. */
  function unlockAudio() {
    if (audioUnlocked) return;
    const el = audioElement();
    try { el.src = SILENT; const p = el.play(); if (p && p.then) p.then(() => { audioUnlocked = true; }, () => {}); } catch (e) { /* ignore */ }
  }

  async function fetchClip(text, voiceId) {
    const key = voiceId + '|' + text;
    if (clipCache.has(key)) return clipCache.get(key);
    const cfg = window.READER_CONFIG || {};
    const creds = await credentials();
    const headers = { 'Content-Type': 'application/json' };
    if (creds.accessCode) headers['x-access-code'] = creds.accessCode;
    if (creds.bearer) headers.Authorization = 'Bearer ' + creds.bearer;
    let res;
    try { res = await fetch(cfg.cloudTtsEndpoint, { method: 'POST', headers, body: JSON.stringify({ text, voice: voiceId }) }); }
    catch (e) { throw new Error('cloud:Could not reach the voice service.'); }
    if (res.status === 401 || res.status === 403) throw new Error('cloud-auth');
    if (!res.ok) {
      let detail = ''; try { detail = (await res.json()).error || ''; } catch (e) { /* ignore */ }
      throw new Error('cloud:' + (detail || ('Voice service error ' + res.status)));
    }
    const url = URL.createObjectURL(await res.blob());
    clipCache.set(key, url);
    if (clipCache.size > 60) { const oldest = clipCache.keys().next().value; URL.revokeObjectURL(clipCache.get(oldest)); clipCache.delete(oldest); }
    return url;
  }

  function speakCloud(sentences, h, myGen) {
    const el = audioElement();
    const voice = cloudVoiceFor(voiceKeySelected) || CLOUD_VOICES[0];
    const chunksOf = (i) => window.TextService.splitForSpeech(sentences[i].text, MAX_CLOUD_CHARS);
    const prefetch = (i) => { if (i < sentences.length) chunksOf(i).forEach(t => fetchClip(t, voice.id).catch(() => {})); };
    async function speakSentence() {
      if (myGen !== generation) return;
      const index = session.index;
      if (index >= sentences.length) { playing = false; current = -1; h.onFinish && h.onFinish(); return; }
      const chunks = chunksOf(index);
      prefetch(index + 1);
      for (let ci = 0; ci < chunks.length; ci++) {
        let url;
        try { url = await fetchClip(chunks[ci], voice.id); }
        catch (err) { if (myGen !== generation) return; playing = false; paused = false; h.onError && h.onError(err.message); return; }
        if (myGen !== generation) return;
        await new Promise((resolve) => {
          el.onended = () => { if (myGen === generation) resolve(); };
          el.onerror = () => { if (myGen !== generation) return; playing = false; paused = false; h.onError && h.onError('cloud:Audio playback failed.'); };
          el.onplay = () => { if (myGen === generation && ci === 0) { current = index; h.onSentenceStart && h.onSentenceStart(index); } };
          el.src = url;
          el.playbackRate = rate;
          const p = el.play();
          if (p && p.catch) p.catch(err => { if (myGen !== generation) return; playing = false; paused = false; h.onError && h.onError(err && err.name === 'NotAllowedError' ? 'cloud:Tap Play again to allow audio.' : 'cloud:' + (err && err.message)); });
        });
        if (myGen !== generation) return;
      }
      session.index = index + 1;
      speakSentence();
    }
    speakSentence();
  }

  // ---------------------------------------------------------------- shared controls
  function speakFrom(sentences, startIndex, handlers) {
    const h = handlers || {};
    const cloud = usingCloud();
    if (!cloud && !synth) { h.onError && h.onError('unavailable'); return; }
    if (cloud) unlockAudio();
    stop();
    const myGen = ++generation;
    session = { sentences, handlers: h, index: startIndex };
    playing = true; paused = false; settingsDirty = false;
    if (cloud) speakCloud(sentences, h, myGen); else speakBrowser(sentences, h, myGen);
  }
  function restartCurrent() { if (session && playing) { const s = session; speakFrom(s.sentences, s.index, s.handlers); } }
  function settingsChanged() { if (!playing) return; if (paused) settingsDirty = true; else restartCurrent(); }

  function pause() {
    if (!playing || paused) return;
    if (usingCloud()) { if (audioEl) audioEl.pause(); } else if (synth) synth.pause();
    paused = true;
  }
  function resume() {
    if (!playing || !paused) return;
    if (settingsDirty) { settingsDirty = false; restartCurrent(); return; }
    if (usingCloud()) { if (audioEl) { audioEl.playbackRate = rate; audioEl.play().catch(() => {}); } } else if (synth) synth.resume();
    paused = false;
  }
  function stop() {
    generation += 1;
    if (synth) synth.cancel();
    if (audioEl) { audioEl.onended = audioEl.onerror = audioEl.onplay = null; try { audioEl.pause(); } catch (e) { /* ignore */ } }
    playing = false; paused = false; current = -1; settingsDirty = false;
  }
  function preview(text) {
    const sample = text || 'Good evening, sir. All systems are online and ready.';
    if (usingCloud()) {
      unlockAudio(); stop();
      const el = audioElement(); const voice = cloudVoiceFor(voiceKeySelected) || CLOUD_VOICES[0];
      return fetchClip(sample, voice.id).then(url => { el.onended = el.onerror = el.onplay = null; el.src = url; el.playbackRate = rate; return el.play(); });
    }
    if (!synth) return Promise.resolve(false);
    stop();
    synth.speak(makeUtterance(sample));
    return Promise.resolve(true);
  }

  return {
    available: !!synth || cloudAvailable(),
    loadVoices, getVoices: () => voices, onVoicesChanged: (fn) => listeners.add(fn),
    voiceKey, quality, isJarvis, groupName, hasHighQualityEnglish,
    cloudAvailable, getCloudVoices: () => CLOUD_VOICES.map(v => ({ key: CLOUD_PREFIX + v.id, name: v.name, desc: v.desc })),
    isCloudVoice: isCloudKey, isUsingCloud: usingCloud,
    setCredentialsProvider: (fn) => { credentials = fn; },
    getVoiceKey: () => voiceKeySelected,
    setVoiceKey: (k) => { if (k === voiceKeySelected) return; voiceKeySelected = k; settingsChanged(); },
    getRate: () => rate,
    setRate: (r) => {
      const next = Math.min(3, Math.max(0.5, parseFloat(r) || 1));
      if (next === rate) return;
      rate = next;
      if (usingCloud() && playing) { if (audioEl) audioEl.playbackRate = rate; return; } // live, no restart needed
      settingsChanged();
    },
    speakFrom, pause, resume, stop, preview,
    isPlaying: () => playing, isPaused: () => paused, currentIndex: () => current
  };
})();
