# Fact Sheet Builder — Deploy Package

Everything here deploys to **Vercel** and connects to **Supabase**. No prior coding needed —
just follow the steps in order. Nothing secret lives in these files; keys are pasted into
Vercel and Supabase dashboards only.

## What's in this folder
- `index.html` — the app users see: sign in → upload PNG → **Confirm build** → build appears.
- `api/build.js` — the build engine: Claude drafts the page, the server crops real image
  assets from your PNG, then renders → compares → corrects the page against the original (2–3 passes).
- `api/_render.js` — headless-Chromium helper that screenshots the draft so Claude can "see" and correct it.
- `api/apply-change.js` — applies one plain-English edit to an existing build.
- `package.json` — dependencies: Anthropic SDK, puppeteer-core, @sparticuz/chromium, sharp.
- `vercel.json` — build function runs up to 300s with 3GB memory (needed for Chromium).
- `.env.example` — the key names you'll set in Vercel (examples only).
- `.gitignore` — keeps secrets/junk out of GitHub.

### Requires Vercel Pro
The render→compare→correct loop launches a headless browser and runs multiple Claude vision
passes, so it needs Pro (300s / 3GB). Optional env vars:
- `BUILD_MODEL` — override the model (default `claude-sonnet-4-5`).
- `FIX_PASSES` — number of visual-correction passes, 0–3 (default `2`).

---

## STEP 1 — Anthropic key
1. Go to console.anthropic.com → create account → add billing.
2. Create an **API key**. Copy it (starts with `sk-ant-`). Keep it private.

## STEP 2 — Supabase (logins + saved projects + files)
1. supabase.com → **New project** (save the DB password).
2. **Project Settings → API**: copy the **Project URL** and the **anon public** key.
3. **Authentication → Providers**: enable **Email**.
4. **Storage → New bucket** named `uploads`.
5. **Table Editor → New table** `projects` with columns:
   - `id` (int8, primary, auto)
   - `owner` (uuid)
   - `title` (text)
   - `data` (jsonb)
   - `created_at` (timestamptz, default now())
6. Enable **Row Level Security** on `projects`, then add the template policy
   "Enable access to own rows" using `owner = auth.uid()`.

## STEP 3 — Put the code on GitHub (optional but recommended)
1. github.com → **New repository** (Private), name it `fact-sheet-builder`.
2. Install **GitHub Desktop**, **Clone** the repo, copy the CONTENTS of this `deploy/`
   folder into it, then **Commit** → **Push**.
   (No GitHub? You can instead drag this folder straight into Vercel in Step 4.)

## STEP 4 — Deploy to Vercel
1. vercel.com → sign in **with GitHub**.
2. **Add New → Project** → import `fact-sheet-builder` (or drag the folder if not using GitHub).
3. Open **Environment Variables** and add three:
   - `ANTHROPIC_API_KEY` = your key from Step 1
   - `SUPABASE_URL` = Project URL from Step 2
   - `SUPABASE_ANON_KEY` = anon public key from Step 2
4. Click **Deploy**. You'll get a live URL like `fact-sheet-builder.vercel.app`.

## STEP 5 — Tell the app its Supabase keys
Open `public/index.html` and replace `PASTE_SUPABASE_URL` and `PASTE_SUPABASE_ANON_KEY`
near the bottom with your two Supabase values. Commit/push (or re-drag to Vercel).
(The anon key is designed to be public — safe in the browser. The Anthropic key is NOT,
which is why it only lives in Vercel's env vars and is used by `api/build.js`.)

## STEP 6 — Test
Open your Vercel URL → create an account → upload a PNG → **Confirm build**.
The app calls `/api/build` → Claude builds it → it appears in the AI build frame and is
saved to the client's `projects` table. No chat, no waiting.

---

### How this maps to the in-preview app
The preview app (`Document Builder v9.dc.html`) does the same steps but waits for a human
to deliver the build. In this deployed version, `api/build.js` IS the deliverer — the
"Confirm build" button calls it and the result returns automatically.
