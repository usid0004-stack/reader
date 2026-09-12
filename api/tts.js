/**
 * Vercel serverless function: turns a sentence into speech with OpenAI's
 * text-to-speech API, keeping the API key on the server.
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables):
 *   OPENAI_API_KEY    required, secret
 *   TTS_ACCESS_CODE   a passphrase the app asks for once; blocks strangers from using your key
 *   SUPABASE_URL / SUPABASE_ANON_KEY   optional; a signed-in Supabase user is accepted instead of the code
 */
const VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
const MAX_CHARS = 1500;

async function isAuthorized(req) {
  const code = req.headers['x-access-code'];
  if (process.env.TTS_ACCESS_CODE && code && code === process.env.TTS_ACCESS_CODE) return true;
  const auth = req.headers.authorization;
  if (auth && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: auth } });
      if (r.ok) return true;
    } catch (e) { /* fall through */ }
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Cloud voices are not configured on this deployment.' });
  if (!process.env.TTS_ACCESS_CODE && !(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)) {
    return res.status(503).json({ error: 'Set TTS_ACCESS_CODE so only you can use the cloud voices.' });
  }
  if (!(await isAuthorized(req))) return res.status(401).json({ error: 'Access code required.' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const text = String(body.text || '').trim();
  const voice = VOICES.includes(body.voice) ? body.voice : 'onyx';
  if (!text) return res.status(400).json({ error: 'No text.' });
  if (text.length > MAX_CHARS) return res.status(413).json({ error: `Text longer than ${MAX_CHARS} characters.` });

  let upstream;
  try {
    upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || 'tts-1', voice, input: text, response_format: 'mp3' })
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach the voice service.' });
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    const status = upstream.status === 429 ? 429 : 502;
    return res.status(status).json({ error: upstream.status === 429 ? 'The voice service is rate-limited right now.' : 'The voice service returned an error.', detail: detail.slice(0, 300) });
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(audio.length));
  return res.status(200).send(audio);
};

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
module.exports.VOICES = VOICES;
