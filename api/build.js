// deploy-FINAL/api/build.js
// Vercel serverless function — Claude render→compare→correct build pipeline.
//
// Flow (mirrors how the interactive agent gets to ~100%):
//   1. Pass 1: Claude returns { html, assets[] } — HTML at 2550x3300 with
//      <div data-asset="ID"> placeholders, plus pixel bounding boxes for each
//      real image (logo, headshots, charts, maps, QR) in the ORIGINAL image.
//   2. Server crops each asset region from the original with sharp and injects
//      it as an <img> into the matching placeholder (real assets, not gray boxes).
//   3. Correction loop (up to 2x): render the current HTML to PNG with headless
//      Chromium, send ORIGINAL + RENDER to Claude, get corrected full HTML back.
//   4. Stream status lines (prefix "§S ") then "§HTML\n" + the final HTML.
//
// The Anthropic key stays here on the server (Vercel env var).

const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const { renderToPng } = require('./_render');

const BUILD_SYS =
  'You rebuild a financial fact sheet image into a single self-contained web page at a FIXED 2550x3300 px. ' +
  'Return STRICT JSON only (no prose, no code fences) shaped exactly: ' +
  '{"html":"<div ...>...</div>","assets":[{"id":"logo1","type":"logo|photo|chart|map|qr","x":0,"y":0,"w":0,"h":0}]}. ' +
  'RULES for html: ' +
  '1) Root <div> exactly style="position:relative;width:2550px;height:3300px;background:#fff;overflow:hidden". ' +
  '2) INLINE STYLES ONLY, absolute positioning (left/top/width/height) for every block so placement matches the original. ' +
  '3) Rebuild ALL text/tables/numbers as crisp selectable HTML, transcribed verbatim (never invent). ' +
  '4) Match fonts (Georgia/serif, Arial/sans-serif), sizes, weights, letter-spacing, line-height, and SAMPLE EXACT hex colors from the image for text, bands, sidebars, stat boxes and footers. ' +
  '5) Reproduce FULL-BLEED colored banners/bands exactly (same color, size, position) — do not turn a dark banner into white. ' +
  '6) For every real image (logo, headshots, charts, maps, QR) place a positioned <div data-asset="ID" style="position:absolute;left..;top..;width..;height.."></div> placeholder AND list it in assets[] with its pixel box (x,y,w,h) in the ORIGINAL image coordinate space. Do NOT draw those images yourself. ' +
  '7) A photo block that has text over a colored panel: reproduce the colored panel + text in HTML, and add the photo as a data-asset behind/under it as in the original. ' +
  '8) No overlaps unless the original overlaps; fit within 2550x3300 with correct margins.';

const FIX_SYS =
  'You are given the ORIGINAL fact sheet image, a SCREENSHOT of the current HTML rebuild, and the current HTML. ' +
  'Correct the HTML so the rebuild matches the original: fix wrong/missing text, positions, font sizes/weights, ' +
  'colors (sample exact hex), missing rule/divider lines, full-bleed bands rendered as white, sections too high/low or overlapping, and mis-sized colored blocks. ' +
  'PRESERVE every <div data-asset="ID"> element and its position (do not delete or replace the injected <img> inside them). ' +
  'Keep the 2550x3300 root, inline styles only, all text selectable. Return ONLY the complete corrected root <div> HTML — no commentary, no code fences.';

function cleanHtml(s){ let h=(s||'').replace(/^```html\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim(); const m=h.match(/<[\s\S]*>/); return m?m[0]:h; }
function cleanJson(s){ let t=(s||'').replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim(); const a=t.indexOf('{'), b=t.lastIndexOf('}'); return (a>=0&&b>a)?t.slice(a,b+1):t; }

// Replace each <div data-asset="ID"> ... </div> body with an <img> of the crop.
function injectAsset(html, id, dataUrl){
  const re = new RegExp('(<div[^>]*data-asset="'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"[^>]*>)([\\s\\S]*?)(</div>)');
  const img = '<img src="'+dataUrl+'" style="width:100%;height:100%;object-fit:contain;display:block;" />';
  return html.replace(re, '$1'+img+'$3');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const say = (m) => { try { res.write('§S ' + m + '\n'); } catch(_){} };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { imageBase64, mediaType, extraInstructions } = body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.BUILD_MODEL || 'claude-sonnet-4-5';
    const passes = Math.max(0, Math.min(3, parseInt(process.env.FIX_PASSES || '2', 10)));
    const origBuf = Buffer.from(imageBase64, 'base64');
    const meta = await sharp(origBuf).metadata();
    const IW = meta.width || 2550, IH = meta.height || 3300;
    const imgBlock = { type:'image', source:{ type:'base64', media_type: mediaType || 'image/png', data: imageBase64 } };

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    // ---- Pass 1: structured build ----
    say('Analyzing layout & building the first draft…');
    const p1 = await anthropic.messages.create({
      model, max_tokens: 32000, system: BUILD_SYS + (extraInstructions?('\n\nAlso: '+extraInstructions):''),
      messages: [{ role:'user', content:[ imgBlock, { type:'text', text:'Rebuild this page. Return the strict JSON now.' } ] }]
    });
    let parsed = {}; try { parsed = JSON.parse(cleanJson((p1.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''))); } catch(e){ parsed = {}; }
    let html = cleanHtml(parsed.html || '');
    const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
    if (!html) throw new Error('First pass returned no HTML');

    // ---- Crop & inject real assets ----
    if (assets.length){
      say('Cropping '+assets.length+' real image asset(s) from your page…');
      for (const a of assets){
        try{
          const x=Math.max(0,Math.round(a.x)), y=Math.max(0,Math.round(a.y));
          const w=Math.max(1,Math.round(a.w)), h=Math.max(1,Math.round(a.h));
          if (x>=IW||y>=IH) continue;
          const cw=Math.min(w, IW-x), ch=Math.min(h, IH-y);
          const crop = await sharp(origBuf).extract({ left:x, top:y, width:cw, height:ch }).png().toBuffer();
          const durl = 'data:image/png;base64,'+crop.toString('base64');
          html = injectAsset(html, a.id, durl);
        }catch(_){ /* skip a bad box */ }
      }
    }

    // ---- Correction loop: render → compare → fix ----
    for (let i=0;i<passes;i++){
      say('Rendering the draft to compare against your original… (pass '+(i+1)+' of '+passes+')');
      let shot;
      try { shot = await renderToPng(html); }
      catch(e){ say('Render unavailable — skipping visual correction.'); break; }
      say('Comparing pixel-for-pixel and correcting differences… (pass '+(i+1)+')');
      const shotB64 = shot.toString('base64');
      const fix = await anthropic.messages.create({
        model, max_tokens: 32000, system: FIX_SYS,
        messages: [{ role:'user', content:[
          { type:'text', text:'ORIGINAL image:' }, imgBlock,
          { type:'text', text:'SCREENSHOT of current rebuild:' },
          { type:'image', source:{ type:'base64', media_type:'image/png', data: shotB64 } },
          { type:'text', text:'Current HTML to correct:\n\n'+html }
        ]}]
      });
      const corrected = cleanHtml((fix.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''));
      if (corrected && corrected.length>200) html = corrected;
    }

    say('Finalizing…');
    res.write('§HTML\n');
    res.write(html);
    return res.end();
  } catch (e) {
    if (res.headersSent) { try { res.write('§S ERROR '+String(e&&e.message||e)+'\n'); res.end(); } catch(_){} return; }
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
