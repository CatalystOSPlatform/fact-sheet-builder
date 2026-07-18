// deploy/api/build.js
// Vercel serverless function.
// Receives an uploaded page image + directive, asks Claude to rebuild it as an
// inline-styled web page, and returns the HTML. The Anthropic key stays here on
// the server (set as an environment variable in Vercel) — never in the browser.

const Anthropic = require('@anthropic-ai/sdk');

const DIRECTIVE =
  'You are rebuilding a financial fact sheet from an image into a single, self-contained web page. ' +
  'Build it with 100% visual accuracy at a FIXED width and height of 2550 x 3300 px. ' +
  'Requirements: ' +
  '1) One root <div> exactly style="position:relative;width:2550px;height:3300px;background:#fff;overflow:hidden". ' +
  '2) INLINE STYLES ONLY — no <style> blocks, no classes, no external CSS. ' +
  '3) Rebuild ALL text, tables and numbers as crisp, selectable HTML (do not rasterize text). ' +
  '4) Match fonts (use Georgia/serif and Arial/sans-serif families to approximate), sizes, weights, colors (sample exact hex), spacing, rules and column positions. ' +
  '5) For the logo, insert an editable placeholder: a bordered box reading "Upload logo" (do NOT embed a cropped logo bitmap). ' +
  '6) For photos/headshots/charts/QR that cannot be rebuilt as text, leave a neatly sized, labeled placeholder box in the correct position. ' +
  '7) No element overlaps unless the original overlaps. Everything fits within 2550x3300 with correct margins. ' +
  'Return ONLY the complete HTML for the root <div> — no commentary, no markdown code fences.';

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

    // Stream so bytes flow immediately (keeps the serverless function alive and
    // lets the browser show real progress). Forward text as it generates.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    const stream = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 22000,
      stream: true,
      system: DIRECTIVE + (extraInstructions ? ('\n\nAdditional instructions: ' + extraInstructions) : ''),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: imageBase64 } },
          { type: 'text', text: 'Rebuild this page now. Return only the root <div> HTML.' }
        ]
      }]
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
