// deploy/api/build.js
// Vercel serverless function.
// Receives an uploaded page image + directive, asks Claude to rebuild it as an
// inline-styled web page, and returns the HTML. The Anthropic key stays here on
// the server (set as an environment variable in Vercel) — never in the browser.

const Anthropic = require('@anthropic-ai/sdk');

const DIRECTIVE =
  'You are rebuilding a financial fact sheet from an image into a single, self-contained web page. ' +
  'Build it with 100% visual accuracy at a FIXED width and height of 2550 x 3300 px. ' +
  'Study the image carefully first: overall grid, number of columns, every section, every rule/divider line, and the exact position of each block. ' +
  'Requirements: ' +
  '1) One root <div> exactly style="position:relative;width:2550px;height:3300px;background:#fff;overflow:hidden". ' +
  '2) INLINE STYLES ONLY — no <style> blocks, no classes, no external CSS. Use absolute positioning (position:absolute; left/top) for every major block so placement matches the original exactly. ' +
  '3) Rebuild ALL text, tables and numbers as crisp, selectable HTML (do not rasterize text). Transcribe the real text from the image verbatim — do not paraphrase or invent. ' +
  '4) Match fonts (Georgia/serif and Arial/sans-serif to approximate), font sizes, weights, letter-spacing, line-height, text colors (sample exact hex from the image), spacing, dividers/rules, and column widths and positions. ' +
  '5) Reproduce colored bands, stat boxes, sidebars and footers with the exact sampled hex colors and the same sizes and positions. ' +
  '6) For the logo, insert an editable placeholder: a bordered box reading "Upload logo" (do NOT embed a cropped logo bitmap). ' +
  '7) For photos/headshots/charts/maps/QR that cannot be rebuilt as text, leave a neatly sized, labeled placeholder box in the correct position and size. ' +
  '8) No element overlaps unless the original overlaps. Everything fits within 2550x3300 with correct margins. ' +
  'Return ONLY the complete HTML for the root <div> — no commentary, no markdown code fences.';

const REFINE =
  'Here is your DRAFT rebuild (HTML) and the ORIGINAL image. Compare them side by side and correct the draft so it matches the original as closely as possible. ' +
  'Fix: wrong or missing text, positions that are off, wrong font sizes/weights/colors, missing rule/divider lines, sections that are too high/low or overlapping, and colored blocks whose size/position/hex is off. ' +
  'Keep the same 2550x3300 root div, inline styles only, all text selectable, and the "Upload logo" placeholder. ' +
  'Return ONLY the complete corrected HTML for the root <div> — no commentary, no code fences.';

module.exports = async (req, res) => {
  // CORS so your app (on any domain) can call this.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { imageBase64, mediaType, extraInstructions } = body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.BUILD_MODEL || 'claude-sonnet-4-5';
    const imgBlock = { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: imageBase64 } };
    const clean = (s) => { let h=(s||'').replace(/^```html\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim(); const m=h.match(/<[\s\S]*>/); return m?m[0]:h; };

    // ---- Pass 1: initial full build (collected, not streamed) ----
    const first = await anthropic.messages.create({
      model, max_tokens: 22000,
      system: DIRECTIVE + (extraInstructions ? ('\n\nAdditional instructions: ' + extraInstructions) : ''),
      messages: [{ role:'user', content: [ imgBlock, { type:'text', text:'Rebuild this page now. Return only the root <div> HTML.' } ] }]
    });
    const draft = clean((first.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));

    // ---- Pass 2: optical-match refinement, streamed to the browser ----
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    const stream = await anthropic.messages.create({
      model, max_tokens: 22000, stream: true,
      system: REFINE,
      messages: [{ role:'user', content: [ imgBlock, { type:'text', text:'ORIGINAL image is above. DRAFT HTML to correct:\n\n' + draft } ] }]
    });

    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        res.write(ev.delta.text);
      }
    }
    return res.end();
  } catch (e) {
    // If we already started streaming, just close; otherwise send JSON error.
    if (res.headersSent) { try { res.end(); } catch(_){} return; }
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
