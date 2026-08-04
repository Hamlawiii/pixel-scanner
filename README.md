# Pixel / Tracker Scanner

Loads a single page in headless Chromium, watches every network request,
inspects the DOM, and reports every ad/marketing pixel and tracking tag
it can find.

## Setup (Ubuntu)

```bash
mkdir pixel-scanner && cd pixel-scanner
# copy pixel-scanner.js into this folder

npm init -y
npm install playwright
npx playwright install chromium --with-deps   # downloads a Chromium build + OS deps
```

`--with-deps` installs the handful of system libraries Chromium needs to
run headless on Ubuntu (fonts, codecs, etc.) via apt, so this step needs
sudo the first time.

## Run it

```bash
node pixel-scanner.js https://example.com
```

Options:

```bash
node pixel-scanner.js https://example.com --headful       # watch it run in a real window
node pixel-scanner.js https://example.com --wait=15000     # wait longer for slow/async pixels
node pixel-scanner.js https://example.com --no-consent     # skip auto-clicking cookie banners
```

## What it captures

- **Every network request** the page makes (URL, method, resource type, status, content-length)
- **Known ad/tracking platforms**, matched against a domain list covering Meta, Google
  Ads/Analytics/GTM, TikTok, LinkedIn, X/Twitter, Pinterest, Snapchat, Bing UET, Criteo,
  AdRoll, Taboola, Outbrain, Amazon Ads, Quantcast, Hotjar, Microsoft Clarity, Segment,
  Mixpanel, Amplitude, HubSpot, Reddit, and Adobe Analytics
- **Pixel-shaped requests** — anything matching common tracking URL patterns
  (`/tr?`, `beacon`, `collect`, `impression`, etc.) or images under 150 bytes
  (the size of a typical 1x1 tracking gif)
- **DOM-level signals** — global JS objects that mean a tracker's SDK is loaded
  (`fbq`, `gtag`, `dataLayer`, `ttq`, `uetq`, `pintrk`, ...), 1x1 `<img>` tags,
  and `<noscript>` pixel fallbacks (common for Meta/LinkedIn when JS is disabled)
- **Cookies** set during the page load, with domain/path/httpOnly/secure flags

## Output

- A console summary
- A full `pixel-report-<timestamp>.json` file with every request, every match,
  and every cookie, for deeper digging or diffing between scans

## Notes

- Many pixels only fire *after* cookie consent is granted on GDPR-regulated
  sites — the script tries to auto-click common "Accept all" style buttons
  before waiting, but if the site uses a custom consent UI, run with
  `--headful` once to check what actually needs clicking, or click manually
  yourself and increase `--wait`.
- Some pixels fire on delay, scroll, or exit-intent, not on load. If a report
  looks thin, rerun with a longer `--wait`.
- Chromium's headless network log doesn't include the JS call stack for each
  request out of the box, so the report tells you *what* fired, not exactly
  *which script* triggered it — cross-reference against `domSignals.foundGlobals`
  and view-source for that.
