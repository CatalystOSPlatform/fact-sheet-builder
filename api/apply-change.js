// deploy/api/apply-change.js
// Applies a single plain-English edit to an existing built page and returns the
// updated HTML. Same key-on-server pattern as build.js.

const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { html, instruction } = body;
    if (!html || !instruction) return res.status(400).json({ error: 'Missing html or instruction' });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const sys =
      'You are editing an inline-styled HTML fact sheet page. Apply ONLY this change: "' + instruction + '". ' +
      'Keep everything else identical — same structure, positions, inline styles. ' +
      'Return the COMPLETE modified HTML, inline styles only, no commentary, no code fences.';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 22000,
      system: sys,
      messages: [{ role: 'user', content: [{ type: 'text', text: html }] }]
    });

    let out = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    out = out.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const m = out.match(/<[\s\S]*>/);
    if (m) out = m[0];

    if (!out || out.length < 120) return res.status(502).json({ error: 'Empty result from model' });
    return res.status(200).json({ html: out });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
