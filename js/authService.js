/**
 * authService: thin wrapper over Supabase Auth. Only active when config.js
 * provides a Supabase URL and anon key; otherwise the app runs in
 * per-browser mode and this service reports configured() === false.
 */
window.AuthService = (function () {
  let client = null;

  function config() { return window.READER_CONFIG || {}; }
  function configured() {
    const c = config();
    return !!(c.supabaseUrl && c.supabaseAnonKey && window.supabase && window.supabase.createClient);
  }
  function getClient() {
    if (!configured()) throw new Error('Cloud sync is not configured.');
    if (!client) {
      client = window.supabase.createClient(config().supabaseUrl, config().supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    }
    return client;
  }
  function redirectTo() { return location.origin + location.pathname; }

  async function getSession() {
    const { data, error } = await getClient().auth.getSession();
    if (error) throw error;
    return data.session || null;
  }
  function onChange(fn) {
    getClient().auth.onAuthStateChange((event, session) => fn(event, session || null));
  }
  async function signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }
  async function signUp(email, password) {
    const { data, error } = await getClient().auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
    if (error) throw error;
    return data; // session is null until the email is confirmed, when confirmation is on
  }
  async function signInWithGoogle() {
    const { error } = await getClient().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });
    if (error) throw error;
  }
  async function resetPassword(email) {
    const { error } = await getClient().auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
    if (error) throw error;
  }
  async function signOut() {
    const { error } = await getClient().auth.signOut();
    if (error) throw error;
  }

  return { configured, getClient, getSession, onChange, signIn, signUp, signInWithGoogle, resetPassword, signOut };
})();
