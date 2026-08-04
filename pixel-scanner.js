#!/usr/bin/env node
/**
 * pixel-scanner.js
 * Loads a single webpage in headless Chromium and reports every
 * ad/marketing pixel and tracking tag it can detect: known-platform
 * network requests, pixel-shaped requests, DOM-level tracking globals,
 * 1x1 <img> tags, <noscript> pixel fallbacks, and cookies set.
 *
 * Usage:
 *   node pixel-scanner.js <url> [--headful] [--wait=8000] [--no-consent]
 *
 * Options:
 *   --headful     Show the browser window instead of running headless
 *   --wait=8000   Extra milliseconds to wait after load for async pixels (default 8000)
 *   --no-consent  Skip the auto-click-consent-banner step
 *
 * Requires:
 *   npm install playwright
 *   npx playwright install chromium --with-deps
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const KNOWN_TRACKERS = {
  'Meta / Facebook Pixel': ['facebook.com/tr', 'connect.facebook.net'],
  'Google Ads / Analytics / GTM': [
    'googletagmanager.com', 'google-analytics.com', 'googlesyndication.com',
    'googleadservices.com', 'doubleclick.net', 'google.com/pagead',
  ],
  'TikTok Pixel': ['analytics.tiktok.com', 'ads-api.tiktok.com', 'business-api.tiktok.com'],
  'X / Twitter Ads': ['ads-twitter.com', 'analytics.twitter.com', 't.co/i/adsct'],
  'LinkedIn Insight Tag': ['px.ads.linkedin.com', 'snap.licdn.com', 'ads.linkedin.com'],
  'Pinterest Tag': ['ct.pinterest.com'],
  'Snapchat Pixel': ['tr.snapchat.com'],
  'Microsoft/Bing UET': ['bat.bing.com'],
  Criteo: ['criteo.com', 'criteo.net'],
  AdRoll: ['adroll.com'],
  Outbrain: ['outbrain.com'],
  Taboola: ['taboola.com'],
  'Amazon Ads': ['amazon-adsystem.com'],
  Quantcast: ['quantserve.com'],
  Hotjar: ['hotjar.com', 'hotjar.io'],
  'Microsoft Clarity': ['clarity.ms'],
  Segment: ['segment.com', 'segment.io'],
  Mixpanel: ['mixpanel.com'],
  Amplitude: ['amplitude.com'],
  HubSpot: ['hs-analytics.net', 'hsforms.net', 'hs-scripts.com'],
  'Reddit Pixel': ['alb.reddit.com', 'pixel.redditmedia.com'],
  'Adobe Analytics': ['omtrdc.net', 'demdex.net'],
};

const PIXEL_URL_HINTS = ['/pixel', '/tr?', '/tr/', 'beacon', 'collect', 'track', 'impression', 'conversion', '1x1', 'noscript'];

const CONSENT_BUTTON_TEXTS = [
  'Accept all', 'Accept All', 'I agree', 'I Agree', 'Allow all', 'Allow All',
  'Accept cookies', 'Accept Cookies', 'Got it', 'Agree',
];

function classify(url) {
  const hits = [];
  for (const [platform, patterns] of Object.entries(KNOWN_TRACKERS)) {
    if (patterns.some((p) => url.includes(p))) hits.push(platform);
  }
  return hits;
}

function looksLikePixel(reqUrl, resourceType, contentLength) {
  const lower = reqUrl.toLowerCase();
  const hintMatch = PIXEL_URL_HINTS.some((h) => lower.includes(h));
  const tinyImage = resourceType === 'image' && contentLength !== null && contentLength > 0 && contentLength < 150;
  return hintMatch || tinyImage;
}

async function main() {
  const args = process.argv.slice(2);
  const targetUrl = args.find((a) => !a.startsWith('--'));
  if (!targetUrl) {
    console.error('Usage: node pixel-scanner.js <url> [--headful] [--wait=8000] [--no-consent]');
    process.exit(1);
  }
  const headful = args.includes('--headful');
  const noConsent = args.includes('--no-consent');
  const waitArg = args.find((a) => a.startsWith('--wait='));
  const extraWait = waitArg ? parseInt(waitArg.split('=')[1], 10) : 8000;

  const browser = await chromium.launch({ headless: !headful });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  const requests = [];

  page.on('response', async (response) => {
    try {
      const req = response.request();
      const headers = response.headers();
      const contentLength = headers['content-length'] ? parseInt(headers['content-length'], 10) : null;
      requests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        status: response.status(),
        contentType: headers['content-type'] || null,
        contentLength,
      });
    } catch (e) {
      // response object may already be recycled by the time we read it; skip
    }
  });

  console.error(`Loading ${targetUrl} ...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  if (!noConsent) {
    for (const text of CONSENT_BUTTON_TEXTS) {
      try {
        const btn = page.getByText(text, { exact: false }).first();
        if (await btn.isVisible({ timeout: 800 })) {
          await btn.click({ timeout: 800 });
          console.error(`Clicked consent button: "${text}"`);
          break;
        }
      } catch (e) {
        // not found with this text, try the next one
      }
    }
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (e) {
    // some pages never go fully idle (polling, ads) -- that's fine
  }
  await page.waitForTimeout(extraWait);

  const domSignals = await page.evaluate(() => {
    const globals = ['fbq', 'gtag', 'dataLayer', 'ttq', 'twq', 'snaptr', 'uetq', 'pintrk', '_linkedin_data_partner_ids', '_fbq', 'ga'];
    const foundGlobals = globals.filter((g) => typeof window[g] !== 'undefined');
    const tinyImages = Array.from(document.querySelectorAll('img'))
      .filter((img) => {
        const w = img.width || img.naturalWidth;
        const h = img.height || img.naturalHeight;
        return w <= 2 && h <= 2;
      })
      .map((img) => img.src);
    const noscriptPixels = Array.from(document.querySelectorAll('noscript'))
      .map((n) => n.innerHTML)
      .filter((html) => html.includes('<img'));
    return { foundGlobals, tinyImages, noscriptPixels };
  });

  const cookies = await context.cookies();

  const trackerHits = {};
  const pixelLikeRequests = [];
  for (const r of requests) {
    const platforms = classify(r.url);
    for (const p of platforms) {
      trackerHits[p] = trackerHits[p] || [];
      trackerHits[p].push(r.url);
    }
    if (looksLikePixel(r.url, r.resourceType, r.contentLength)) {
      pixelLikeRequests.push(r);
    }
  }

  const report = {
    targetUrl,
    scannedAt: new Date().toISOString(),
    totalRequests: requests.length,
    knownTrackersFound: trackerHits,
    pixelLikeRequests,
    domSignals,
    cookies: cookies.map((c) => ({
      name: c.name, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
    })),
    allRequests: requests,
  };

  const outPath = path.join(process.cwd(), `pixel-report-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== PIXEL / TRACKER SCAN SUMMARY ===');
  console.log(`Target: ${targetUrl}`);
  console.log(`Total network requests captured: ${requests.length}`);
  console.log('\nKnown tracking platforms detected:');
  if (Object.keys(trackerHits).length === 0) {
    console.log('  (none matched the known-platform list)');
  } else {
    for (const [platform, urls] of Object.entries(trackerHits)) {
      console.log(`  - ${platform}: ${urls.length} request(s)`);
    }
  }
  console.log(`\nGlobal tracking objects found on page: ${domSignals.foundGlobals.join(', ') || 'none'}`);
  console.log(`1x1 / near-invisible <img> pixels in DOM: ${domSignals.tinyImages.length}`);
  console.log(`<noscript> pixel fallbacks: ${domSignals.noscriptPixels.length}`);
  console.log(`Pixel-like network requests (by URL pattern or tiny size): ${pixelLikeRequests.length}`);
  console.log(`Cookies set: ${cookies.length}`);
  console.log(`\nFull JSON report written to: ${outPath}`);

  await browser.close();
}

main().catch((err) => {
  console.error('Scan failed:', err);
  process.exit(1);
});
