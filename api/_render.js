// deploy-FINAL/api/_render.js
// Shared helper: render an inline-styled HTML page to a PNG screenshot using a
// headless Chromium that runs inside a Vercel serverless function.
// Used by the build loop to "see" its own draft and compare it to the original.

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

let _browser = null;
async function getBrowser() {
  if (_browser) return _browser;
  _browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 2550, height: 3300, deviceScaleFactor: 1 },
    executablePath: await chromium.executablePath(),
    headless: true
  });
  return _browser;
}

// Render a root-<div> HTML fragment at 2550x3300 and return a PNG Buffer.
async function renderToPng(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 2550, height: 3300, deviceScaleFactor: 1 });
    const doc = '<!doctype html><html><head><meta charset="utf-8">' +
      '<style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}' +
      '@import url("https://fonts.googleapis.com/css2?family=Georgia&display=swap");</style>' +
      '</head><body>' + html + '</body></html>';
    await page.setContent(doc, { waitUntil: 'networkidle0', timeout: 30000 });
    // give web fonts a moment
    await new Promise(r => setTimeout(r, 400));
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 2550, height: 3300 } });
    return buf;
  } finally {
    await page.close();
  }
}

module.exports = { renderToPng };
