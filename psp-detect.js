#!/usr/bin/env node
/**
 * PSP Detector - Detects Payment Service Providers used by websites
 * Usage: node psp-detect.js [options] <urls-file>
 * Options:
 *   --output <file>       Output CSV file (default: results.csv)
 *   --concurrency <n>     Number of parallel requests (default: 5)
 *   --timeout <ms>        Request timeout in ms (default: 15000)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── PSP Fingerprint Definitions ──────────────────────────────────────────────
const PSP_DEFINITIONS = [
  {
    name: 'Stripe',
    patterns: [
      /js\.stripe\.com/i,
      /stripe\.com\/v[0-9]/i,
      /pk_(live|test)_[A-Za-z0-9]+/,
      /Stripe\s*\(/,
    ],
  },
  {
    name: 'PayPal',
    patterns: [
      /paypal\.com\/sdk\/js/i,
      /paypalobjects\.com/i,
      /paypal\.Buttons/i,
      /paypal-button/i,
      /data-partner-attribution-id/i,
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
      /gmo.?payment/i,
      /gmopg/i,
    ],
  },
  {
    name: 'GMO Epsilon',
    patterns: [
      /epsilon\.jp/i,
      /epsilonjavascript/i,
      /gmo.?epsilon/i,
      /trans\.epsilon\.jp/i,
    ],
  },
  {
    name: 'DGFT (Digital Garage)',
    patterns: [
      /dgft\.jp/i,
      /digital-garage.*payment/i,
      /veritrans/i,
      /ks\.veritrans\.co\.jp/i,
      /token\.veritrans\.co\.jp/i,
    ],
  },
];

// ── HTTP Fetch with redirect following ───────────────────────────────────────
function fetchUrl(targetUrl, timeout = 15000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) {
      return reject(new Error('Too many redirects'));
    }

    let parsed;
    try {
      parsed = new url.URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; PSPDetector/1.0; +https://github.com/your-org/psp-detector)',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      timeout,
    };

    const req = lib.request(options, (res) => {
      const { statusCode, headers } = res;

      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        res.destroy();
        const nextUrl = new url.URL(headers.location, targetUrl).href;
        return resolve(fetchUrl(nextUrl, timeout, redirectCount + 1));
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        // Limit to 2MB
        if (body.length > 2 * 1024 * 1024) {
          res.destroy();
        }
      });
      res.on('end', () => resolve({ statusCode, body, finalUrl: targetUrl }));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${timeout}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── PSP Detection ─────────────────────────────────────────────────────────────
function detectPSPs(html) {
  const detected = [];
  for (const psp of PSP_DEFINITIONS) {
    for (const pattern of psp.patterns) {
      if (pattern.test(html)) {
        detected.push(psp.name);
        break; // One match per PSP is enough
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Parse args
  let urlsFile = null;
  let outputFile = 'results.csv';
  let concurrency = 5;
  let timeout = 15000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) outputFile = args[++i];
    else if (args[i] === '--concurrency' && args[i + 1]) concurrency = parseInt(args[++i], 10);
    else if (args[i] === '--timeout' && args[i + 1]) timeout = parseInt(args[++i], 10);
    else if (!args[i].startsWith('--')) urlsFile = args[i];
  }

  if (!urlsFile) {
    console.error('Usage: node psp-detect.js [--output results.csv] [--concurrency 5] [--timeout 15000] <urls.txt>');
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

  console.log(`\n🔍 PSP Detector`);
  console.log(`   URLs:        ${rawUrls.length}`);
  console.log(`   Concurrency: ${concurrency}`);
  console.log(`   Timeout:     ${timeout}ms`);
  console.log(`   Output:      ${outputFile}\n`);

  let completed = 0;

  const tasks = rawUrls.map((rawUrl) => async () => {
    const targetUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let result;

    try {
      const { statusCode, body, finalUrl } = await fetchUrl(targetUrl, timeout);
      const psps = detectPSPs(body);
      result = { url: targetUrl, finalUrl, status: statusCode, psps, error: '' };
    } catch (err) {
      result = { url: targetUrl, status: '', psps: [], error: err.message };
    }

    completed++;
    const pspLabel = result.psps.length > 0 ? result.psps.join(', ') : 'none';
    const statusLabel = result.error ? `ERROR` : `HTTP ${result.status}`;
    console.log(`[${completed}/${rawUrls.length}] ${statusLabel.padEnd(10)} ${targetUrl} → ${pspLabel}`);

    return result;
  });

  const results = await runWithConcurrency(tasks, concurrency);

  // Write CSV with BOM
  const bom = '\uFEFF';
  const csv = bom + buildCsv(results);
  fs.writeFileSync(outputFile, csv, 'utf8');

  // Summary
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
