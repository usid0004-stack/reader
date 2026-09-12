# Reader

A Speechify-style reader that runs entirely in the browser. Upload PDFs, keep
them in a library, and have them read aloud with the voices built into your
computer. Every book remembers exactly where you stopped.

## Run it

Double-click `index.html`. No install, no server, no account. The first PDF
you add needs an internet connection so the browser can fetch pdf.js.

## Deployment

Live site (Vercel): https://temporary-speedy-alder-p8a3fpf.vercel.app (temporary until claimed, see below)
Previous site (GitHub Pages, still deployed): https://usid0004-stack.github.io/reader/

The app is static (HTML, CSS, JavaScript, no build step), so hosting is a
static site plus Supabase for the account, database and PDF storage. The
browser talks to Supabase directly; row-level security means every query is
scoped to the signed-in user and no custom server is needed. PDF text
extraction and speech still run in the browser.

**Cloud services**

| Part | Service | Cost |
|---|---|---|
| Frontend hosting | GitHub Pages (workflow in `.github/workflows/deploy.yml`); `vercel.json` and `netlify.toml` are included for Vercel or Netlify | free |
| Auth, database, file storage | Supabase (Postgres + Storage + Auth, schema in `supabase/schema.sql`) | free tier: 500 MB database, 1 GB files, 50 MB per PDF |
| PDF parsing library | cdnjs (pdf.js) | free |

**Backend.** There is none to deploy. Multi-row writes go through the
`create_document` SQL function so a document is created atomically.

**Database.** Three tables owned by `user_id`: `documents` (title, file path,
page map, chapters, dates), `document_texts` (extracted text), and
`reading_progress` (page, character index, sentence, chapter, percentage,
completed, saved_at). Deleting a document cascades. Progress is upserted
with `keepalive` so a closing tab still saves, and mirrored in localStorage
as a fallback.

**PDF storage.** A private Supabase Storage bucket `pdfs`, one object per
document at `<user id>/<document id>.pdf`, readable only by its owner through
signed URLs. Files survive refreshes, redeploys and other devices.

**Modes.** With `config.js` empty the app runs in per-browser mode
(IndexedDB, no account). With Supabase credentials it runs in cloud mode and
shows a sign-in screen. A button in the library copies books from the
browser into the account once.

**Environment variables** (both are public values; the anon key is designed
to ship to browsers):

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon public key>
```

`scripts/build.js` turns them into `config.js`. Never commit `config.js` or
`.env`; both are git-ignored. Never put the `service_role` key anywhere in
this project.

**Set up Supabase once**

1. Create a project at https://supabase.com (free).
2. SQL Editor → paste `supabase/schema.sql` → Run.
3. Authentication → Providers: Email is on by default. For Google, enable
   the provider and paste a Google OAuth client id and secret.
4. Authentication → URL Configuration: set Site URL to your deployed
   address and add `http://localhost:8080` to Redirect URLs for local use.
5. Project Settings → API: copy the Project URL and the anon public key.

**Local development**

```bash
cp .env.example .env      # fill in the two values, or leave them out for per-browser mode
npm run dev               # writes config.js and serves http://localhost:8080
```

**Production deployment**

GitHub Pages (already wired up): add `SUPABASE_URL` and `SUPABASE_ANON_KEY`
as repository *variables* (Settings → Secrets and variables → Actions →
Variables), then push to `main`. The workflow builds `dist/` and publishes it.

Vercel (primary): `vercel.json` sets the build command and `dist` output, so
no dashboard settings are needed. From the folder:

```bash
npx vercel login          # once, opens a browser
npx vercel --prod         # production deployment
```

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` under Project → Settings →
Environment Variables (Production) and redeploy for cloud mode. Netlify:
`npx netlify deploy --prod`, same variables.

## Cloud voices (optional)

The device's own voices are free but vary a lot; iPhones only have Apple's.
Cloud voices sound the same everywhere and are much more natural. They use
OpenAI's text-to-speech through `api/tts.js`, a Vercel function that keeps
the API key on the server. Cost is about US$15 per million characters, so
a 300-page book is roughly US$7 if you listen to all of it. Clips are cached
per sentence while the page is open.

Set these in Vercel (Project → Settings → Environment Variables), then redeploy:

```
OPENAI_API_KEY    secret, from platform.openai.com
TTS_ACCESS_CODE   any passphrase; the app asks for it once per device so strangers can't use your key
```

Signed-in Supabase users are accepted instead of the code when `SUPABASE_URL`
and `SUPABASE_ANON_KEY` are also set on the server. The build turns the key's
presence into `cloudTts: true` in `config.js`, which adds a "Cloud voices"
group to the voice menu. GitHub Pages has no functions, so cloud voices only
work on the Vercel deployment.

## Use it on your phone (same Wi-Fi)

Your computer serves the app and must stay awake and on the same network:

```bash
./serve.sh
```

It prints two addresses. Open the `http://192.168.x.x:8765/` one in your
phone's browser. macOS may ask whether Python can accept incoming
connections the first time; allow it. The server only listens on your local
network; nothing is exposed to the internet and no router settings change.
Press Ctrl+C to stop it.

**Each browser has its own library.** Books and reading positions live in
that browser's IndexedDB. What you upload on the computer does not appear on
the phone, and the other way round. Nothing is synced or uploaded anywhere.

**Speech on phones.** iOS Safari and Android Chrome both support the built-in
voices. Playback must start from a tap (the Play button). Voices on iOS load
after the first tap, which is why the voice menu can look empty for a moment.

**Listening with the screen off.** iOS stops the device's own voices the
moment the screen locks; no web app can change that. Two things help:

- *Keep screen on* (in the player, on browsers that support the Screen Wake
  Lock API, including iOS 16.4+) stops the phone auto-locking while reading.
- *Cloud voices* are real audio, which iOS keeps playing in the background
  and on the lock screen, with play, pause and skip controls there. The next
  two sentences are fetched ahead so gaps stay short. This needs the cloud
  voices set up below.

**Away from home** you would need to host the three folders (`index.html`,
`css/`, `js/`) on any static host such as GitHub Pages or Netlify. Both have
free tiers; a GitHub account is required. The library stays per-browser either
way.

## How it is organised

```
index.html                       page markup (library view, reader view, player bar)
css/styles.css                   all styling, light and dark
js/textService.js                sentence splitting with character offsets
js/pdfService.js                 PDF -> text, per-page lines with font info, PDF outline
js/chapterDetectionService.js    outline -> table of contents -> headings -> page groups
js/documentStorageService.js     IndexedDB library: documents, texts, files, progress
js/readingProgressService.js     position <-> progress record, throttled autosave
js/ttsService.js                 speech synthesis, voice ranking
js/app.js                        wires it all to the UI
test-fixtures/                   six small PDFs (detection methods, two columns, blank
                                 pages, scanned) and the script that makes them: python3 mkpdf.py
test/                            browser test suite
serve.sh                         serves the app on your Wi-Fi for phones
js/authService.js                Supabase Auth wrapper (cloud mode)
js/cloudStorageService.js        same storage interface, backed by Supabase
supabase/schema.sql              tables, row-level security, storage bucket
scripts/build.js                 writes config.js from env vars, copies the site to dist/
```

Pipeline for a new PDF:

```
Upload -> PdfService.extract -> ChapterDetectionService.detect
       -> DocumentStorageService.createDocument -> library card -> reader
       -> TtsService.speakFrom -> onSentenceStart -> ReadingProgressService.build
       -> autosave (throttled) -> IndexedDB + localStorage mirror
```

## Reading position

The reader keeps one position: the index of the current sentence. From it the
app derives the character index into the extracted text, the page, the chapter
and the percentage. The stored record looks like:

```json
{ "pageNumber": 47, "characterIndex": 18342, "sentenceIndex": 412,
  "chapterId": "5-chapter-5", "percentage": 36.7, "completed": false }
```

On reopen, the sentence index is used when it still lines up with the character
index; otherwise the nearest sentence boundary to the character index is used.
Progress is saved every 2.5 s while reading and immediately on pause, stop,
chapter jump, leaving the reader, hiding the tab, or closing the page. The
localStorage mirror is written synchronously so a closing tab does not lose it.

## Deleting

Delete is available on each library card and in the reader header. It asks
for confirmation in an in-app dialog (Escape or Cancel keeps the book). If
the book is open, speech stops and pending progress writes drain first. The
document, its text, the PDF file and its progress are removed in a single
IndexedDB transaction, so a failure leaves the book fully intact and reported.

## Tests

Open `test/index.html` from a local server (for example `./serve.sh`, then
`http://localhost:8765/test/index.html`). The suite covers sentence
splitting, speech chunking, progress records, chapter detection for all four
methods, PDF line ordering and header removal, and the storage service using
a separate `readerLibraryTest` database. `test/nospeech.html` is the app with
speech synthesis removed, for checking the disabled controls.

## Chapter detection

1. **PDF outline** (bookmarks). Used whenever the file has one.
2. **Printed table of contents** in the first pages. Titles and printed page
   numbers are parsed, then the offset between printed and actual page numbers
   is found by checking which offset makes the titles appear on the right pages.
3. **Headings**: lines that say "Chapter 3", "Introduction", "2. Title", or are
   clearly larger or bolder than the body text and sit near the top of a page.
   Lines repeated on many pages (running headers, page numbers) are ignored.
4. **Page groups** as a last resort, so navigation always has something.

Chapters are stored as:

```json
{ "id": "2-chapter-1-fundamentals", "title": "Chapter 1 - Fundamentals",
  "startPage": 8, "endPage": 33, "startCharacterIndex": 8501, "endCharacterIndex": 42300 }
```

## Better voices

The dropdown ranks voices by quality. On a Mac, download Daniel (Enhanced) or
Oliver (Enhanced) under System Settings > Accessibility > Spoken Content >
System Voice > Manage Voices, then reload. The app shows this tip until it
finds a high-quality voice.
