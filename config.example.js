// Copy to config.js (git-ignored) for local development, or let scripts/build.js
// generate it from SUPABASE_URL and SUPABASE_ANON_KEY. Leave both empty to run
// in per-browser mode with no account or cloud sync.
window.READER_CONFIG = {
  supabaseUrl: '',      // e.g. https://abcdefghijkl.supabase.co
  supabaseAnonKey: ''   // the "anon public" key; it is safe to ship to browsers, row-level security protects the data
};
