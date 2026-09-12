/**
 * cloudStorageService: the same interface as documentStorageService, backed
 * by Supabase so the library and reading positions follow the signed-in
 * user across devices.
 *   documents         – metadata, chapters, page map
 *   document_texts    – extracted text, loaded when a document is opened
 *   reading_progress  – one row per document, written often
 *   storage bucket    – the original PDF at <user id>/<document id>.pdf
 * Row-level security in supabase/schema.sql restricts every row and file to
 * its owner. Progress is also mirrored to localStorage and sent with
 * keepalive so a closing tab still saves.
 */
window.CloudStorageService = (function () {
  const BUCKET = 'pdfs';
  const MIRROR_PREFIX = 'reader.cloudprogress.';
  const Auth = window.AuthService;

  const client = () => Auth.getClient();
  async function session() {
    const s = await Auth.getSession();
    if (!s) throw new Error('You are signed out.');
    return s;
  }
  async function userId() { return (await session()).user.id; }
  function fail(error, what) {
    const e = new Error(`${what}: ${error.message || error.error_description || String(error)}`);
    e.cause = error;
    return e;
  }

  function readMirror(id) { try { return JSON.parse(localStorage.getItem(MIRROR_PREFIX + id) || 'null'); } catch (e) { return null; } }
  function writeMirror(id, r) { try { localStorage.setItem(MIRROR_PREFIX + id, JSON.stringify(r)); } catch (e) { /* ignore */ } }
  function removeMirror(id) { try { localStorage.removeItem(MIRROR_PREFIX + id); } catch (e) { /* ignore */ } }
  function newer(a, b) { if (!a) return b; if (!b) return a; return (b.savedAt || 0) > (a.savedAt || 0) ? b : a; }

  function rowToDoc(r) {
    return {
      id: r.id,
      title: r.title,
      filename: r.original_filename || '',
      hasFile: !!r.file_path,
      filePath: r.file_path || null,
      totalPages: r.total_pages,
      textLength: r.text_length,
      uploadedAt: r.uploaded_at,
      lastOpenedAt: r.last_opened_at,
      pages: r.pages || [],
      chapters: r.chapters || [],
      chapterMethod: r.chapter_method || 'none'
    };
  }
  function rowToProgress(r) {
    if (!r) return null;
    return {
      id: r.document_id,
      pageNumber: r.page_number,
      characterIndex: r.character_index,
      sentenceIndex: r.sentence_index,
      chapterId: r.chapter_id,
      percentage: Number(r.percentage),
      completed: !!r.completed,
      savedAt: r.saved_at ? new Date(r.saved_at).getTime() : 0
    };
  }

  /** Create a document: upload the PDF (if any), then insert all rows in one transaction via an RPC. */
  async function createDocument({ extraction, chapters, chapterMethod, file, title }) {
    if (!extraction || typeof extraction.fullText !== 'string' || !extraction.fullText.trim()) throw new Error('There is no text to save.');
    const uid = await userId();
    const id = crypto.randomUUID();
    let filePath = null;
    if (file) {
      filePath = `${uid}/${id}.pdf`;
      const { error } = await client().storage.from(BUCKET).upload(filePath, file, { contentType: 'application/pdf', upsert: false });
      if (error) throw fail(error, 'Could not upload the PDF');
    }
    const payload = {
      p_id: id,
      p_title: title || extraction.title || extraction.filename || 'Untitled',
      p_original_filename: extraction.filename || '',
      p_file_path: filePath,
      p_total_pages: extraction.numPages,
      p_text_length: extraction.fullText.length,
      p_chapter_method: chapterMethod || 'none',
      p_chapters: chapters || [],
      p_pages: extraction.pages.map(p => ({ pageNumber: p.pageNumber, startCharIndex: p.startCharIndex, endCharIndex: p.endCharIndex })),
      p_text: extraction.fullText,
      p_chapter_id: (chapters && chapters[0]) ? chapters[0].id : null
    };
    const { data, error } = await client().rpc('create_document', payload);
    if (error) {
      if (filePath) await client().storage.from(BUCKET).remove([filePath]).catch(() => {});
      throw fail(error, 'Could not save to your library');
    }
    const doc = rowToDoc(data);
    writeMirror(id, { id, pageNumber: 1, characterIndex: 0, sentenceIndex: 0, chapterId: payload.p_chapter_id, percentage: 0, completed: false, savedAt: Date.now() });
    return doc;
  }

  async function list() {
    await session();
    const { data, error } = await client().from('documents').select('*, reading_progress(*)').order('last_opened_at', { ascending: false });
    if (error) throw fail(error, 'Could not load your library');
    return data.map(r => {
      const d = rowToDoc(r);
      const p = Array.isArray(r.reading_progress) ? r.reading_progress[0] : r.reading_progress;
      d.progress = newer(rowToProgress(p), readMirror(d.id)) || null;
      return d;
    });
  }

  async function getDocument(id) {
    await session();
    const { data, error } = await client().from('documents').select('*').eq('id', id).maybeSingle();
    if (error) throw fail(error, 'Could not open that book');
    return data ? rowToDoc(data) : null;
  }
  async function getText(id) {
    const { data, error } = await client().from('document_texts').select('text').eq('document_id', id).maybeSingle();
    if (error) throw fail(error, 'Could not load the text');
    return data ? data.text : '';
  }
  async function getProgress(id) {
    const { data, error } = await client().from('reading_progress').select('*').eq('document_id', id).maybeSingle();
    if (error) throw fail(error, 'Could not load the reading position');
    return newer(rowToProgress(data), readMirror(id)) || null;
  }
  async function getFileUrl(id) {
    const doc = await getDocument(id);
    if (!doc || !doc.filePath) return null;
    const { data, error } = await client().storage.from(BUCKET).createSignedUrl(doc.filePath, 3600);
    if (error) throw fail(error, 'Could not get the PDF');
    return data.signedUrl;
  }
  async function getFile(id) {
    const doc = await getDocument(id);
    if (!doc || !doc.filePath) return null;
    const { data, error } = await client().storage.from(BUCKET).download(doc.filePath);
    if (error) throw fail(error, 'Could not download the PDF');
    return data;
  }

  /**
   * Save the reading position. Uses a direct REST upsert with keepalive so a
   * write issued while the tab closes still goes out. Resolves false when the
   * document no longer exists (row-level security also blocks other users).
   */
  async function saveProgress(id, progress) {
    const record = Object.assign({}, progress, { id, savedAt: Date.now() });
    writeMirror(id, record);
    const s = await session();
    const cfg = window.READER_CONFIG;
    const body = {
      document_id: id, user_id: s.user.id,
      page_number: record.pageNumber, character_index: record.characterIndex, sentence_index: record.sentenceIndex,
      chapter_id: record.chapterId, percentage: record.percentage, completed: !!record.completed,
      saved_at: new Date(record.savedAt).toISOString()
    };
    let res;
    try {
      res = await fetch(`${cfg.supabaseUrl}/rest/v1/reading_progress?on_conflict=document_id`, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${s.access_token}`, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(body)
      });
    } catch (err) { throw fail(err, 'Could not save the reading position'); }
    if (res.status === 409 || res.status === 403 || res.status === 404) { removeMirror(id); return false; } // document gone (FK) or not ours
    if (!res.ok) throw new Error('Could not save the reading position: HTTP ' + res.status);
    return true;
  }

  async function touchLastOpened(id) {
    const { error } = await client().from('documents').update({ last_opened_at: new Date().toISOString() }).eq('id', id);
    if (error) throw fail(error, 'Could not update the book');
    return true;
  }
  async function updateDocument(id, patch) {
    const map = { title: 'title', chapters: 'chapters', chapterMethod: 'chapter_method' };
    const row = {};
    for (const k of Object.keys(patch)) if (map[k]) row[map[k]] = patch[k];
    const { data, error } = await client().from('documents').update(row).eq('id', id).select().maybeSingle();
    if (error) throw fail(error, 'Could not update the book');
    return data ? rowToDoc(data) : null;
  }

  /** Delete rows first (texts and progress cascade), then the file. A leftover file never resurrects a book. */
  async function removeDocument(id) {
    const doc = await getDocument(id);
    const { error } = await client().from('documents').delete().eq('id', id);
    if (error) throw fail(error, 'Could not delete');
    removeMirror(id);
    if (doc && doc.filePath) {
      const { error: e2 } = await client().storage.from(BUCKET).remove([doc.filePath]);
      if (e2) console.warn('PDF file could not be removed from storage', e2);
    }
  }

  async function check() { await session(); return true; }

  return { createDocument, list, getDocument, getText, getFile, getFileUrl, getProgress, saveProgress, touchLastOpened, updateDocument, removeDocument, check };
})();
