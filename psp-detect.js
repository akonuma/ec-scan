#!/usr/bin/env node
/**
 * PSP Detector v2 (Puppeteer版)
 * Usage: node psp-detect.js [options] <urls-file>
 * Options:
 *   --output <file>       Output CSV file (default: results.csv)
 *   --concurrency <n>     Number of parallel browsers (default: 3)
 *   --timeout <ms>        Page load timeout in ms (default: 30000)
 *   --wait <ms>           Wait after page load for JS execution (default: 3000)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ── PSP Fingerprint Definitions ──────────────────────────────────────────────
const PSP_DEFINITIONS = [
  {
    name: 'Stripe',
    patterns: [
      /js\.stripe\.com/i,
      /stripe\.com\/v[0-9]/i,
      /pk_(live|test)_[A-Za-z0-9]+/,
      /Stripe\s*\(/,
      /stripe-js/i,
    ],
  },
  {
    name: 'PayPal',
    patterns: [
      /paypal\.com\/sdk\/js/i,
      /paypalobjects\.com/i,
      /paypal\.Buttons/i,
      /paypal-button/i,
    ],
  },
  {
    name: 'Braintree',
    patterns: [
      /js\.braintreegateway\.com/i,
      /braintree-web/i,
      /braintree\.client\.create/i,
      /braintreegateway\.com/i,
    ],
  },
  {
    name: 'Square',
    patterns: [
      /js\.squareup\.com/i,
      /squareupsandbox\.com/i,
      /web\.squarecdn\.com/i,
      /Square\.payments/i,
    ],
  },
  {
    name: 'Adyen',
    patterns: [
      /checkoutshopper.*adyen\.com/i,
      /adyen\.com\/checkoutshopper/i,
      /AdyenCheckout/i,
      /adyen-checkout/i,
    ],
  },
  {
    name: 'Checkout.com',
    patterns: [
      /cdn\.checkout\.com/i,
      /checkout\.com\/frames/i,
      /Frames\.init/i,
      /cko-frames/i,
    ],
  },
  {
    name: 'SoftBank Payment',
    patterns: [
      /sbpayment\.jp/i,
      /softbank-payment\.jp/i,
      /softbankpayment/i,
      /sbps-/i,
    ],
  },
  {
    name: 'GMO Payment Gateway',
    patterns: [
      /static\.mul-pay\.com/i,
      /p01\.mul-pay\.com/i,
      /mul-pay\.com/i,
      /gmopg/i,
    ],
  },
  {
    name: 'GMO Epsilon',
    patterns: [
      /epsilon\.jp/i,
      /epsilonjavascript/i,
      /trans\.epsilon\.jp/i,
    ],
  },
  {
    name: 'DGFT (Digital Garage)',
    patterns: [
      /dgft\.jp/i,
      /veritrans/i,
      /ks\.veritrans\.co\.jp/i,
      /token\.veritrans\.co\.jp/i,
    ],
  },
];

// ── PSP Detection ─────────────────────────────────────────────────────────────
function detectPSPs(html, networkUrls) {
  const allText = html + '\n' + networkUrls.join('\n');
  const detected = [];
  for (const psp of PSP_DEFINITIONS) {
    for (const pattern of psp.patterns) {
      if (pattern.test(allText)) {
        detected.push(psp.name);
        break;
      }
    }
  }
  return detected;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvEscape(value) {
  const s = String(value == null ? '' : value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv(rows) {
  const allPspNames = PSP_DEFINITIONS.map((p) => p.name);
  const header = ['URL', 'Status', 'Detected PSPs', 'Error', ...allPspNames];
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) {
    const detectedSet = new Set(row.psps || []);
    const flagCols = allPspNames.map((name) => (detectedSet.has(name) ? '1' : '0'));
    const line = [
      row.url,
      row.status || '',
      (row.psps || []).join(' | '),
      row.error || '',
      ...flagCols,
    ].map(csvEscape);
    lines.push(line.join(','));
  }
  return lines.join('\r\n');
}

// ── Concurrency Pool ──────────────────────────────────────────────────────────
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Scan one URL with Puppeteer ───────────────────────────────────────────────
async function scanUrl(browser, targetUrl, timeout, waitMs) {
  const page = await browser.newPage();
  const networkUrls = [];

  // ネットワークリクエストを傍受してPSP関連URLを収集
  page.on('request', (req) => {
    networkUrls.push(req.url());
  });

  // UA偽装（ボット判定回避）
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' });

  let status = '';
  try {
    const response = await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout,
    });
    status = response ? response.status() : '';

    // JS実行後の追加待機
    await new Promise((r) => setTimeout(r, waitMs));

    const html = await page.content();
    const psps = detectPSPs(html, networkUrls);
    return { url: targetUrl, status, psps, error: '' };
  } catch (err) {
    return { url: targetUrl, status, psps: [], error: err.message };
  } finally {
    await page.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  let urlsFile = null;
  let outputFile = 'results.csv';
  let concurrency = 3;
  let timeout = 30000;
  let waitMs = 3000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) outputFile = args[++i];
    else if (args[i] === '--concurrency' && args[i + 1]) concurrency = parseInt(args[++i], 10);
    else if (args[i] === '--timeout' && args[i + 1]) timeout = parseInt(args[++i], 10);
    else if (args[i] === '--wait' && args[i + 1]) waitMs = parseInt(args[++i], 10);
    else if (!args[i].startsWith('--')) urlsFile = args[i];
  }

  if (!urlsFile) {
    console.error('Usage: node psp-detect.js [--output results.csv] [--concurrency 3] [--timeout 30000] [--wait 3000] <urls.txt>');
    process.exit(1);
  }

  if (!fs.existsSync(urlsFile)) {
    console.error(`Error: File not found: ${urlsFile}`);
    process.exit(1);
  }

  const rawUrls = fs
    .readFileSync(urlsFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (rawUrls.length === 0) {
    console.error('Error: No URLs found in input file.');
    process.exit(1);
  }

  console.log(`\n🔍 PSP Detector v2 (Puppeteer)`);
  console.log(`   URLs:        ${rawUrls.length}`);
  console.log(`   Concurrency: ${concurrency}`);
  console.log(`   Timeout:     ${timeout}ms`);
  console.log(`   JS Wait:     ${waitMs}ms`);
  console.log(`   Output:      ${outputFile}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let completed = 0;

  const tasks = rawUrls.map((rawUrl) => async () => {
    const targetUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const result = await scanUrl(browser, targetUrl, timeout, waitMs);

    completed++;
    const pspLabel = result.psps.length > 0 ? result.psps.join(', ') : 'none';
    const statusLabel = result.error ? 'ERROR' : `HTTP ${result.status}`;
    console.log(`[${completed}/${rawUrls.length}] ${statusLabel.padEnd(10)} ${targetUrl} → ${pspLabel}`);

    return result;
  });

  const results = await runWithConcurrency(tasks, concurrency);
  await browser.close();

  const bom = '\uFEFF';
  const csv = bom + buildCsv(results);
  fs.writeFileSync(outputFile, csv, 'utf8');

  const detected = results.filter((r) => r.psps && r.psps.length > 0).length;
  const errors = results.filter((r) => r.error).length;
  console.log(`\n✅ Done!`);
  console.log(`   Total:    ${results.length}`);
  console.log(`   Detected: ${detected} sites with PSPs`);
  console.log(`   Errors:   ${errors}`);
  console.log(`   Output:   ${path.resolve(outputFile)}\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
