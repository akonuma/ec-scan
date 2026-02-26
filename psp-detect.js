#!/usr/bin/env node
/**
 * PSP Detector v3 - カートURL自動推測版
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

// ── カートURLパターン（日本ECサイト向け） ────────────────────────────────────
const CART_PATHS = [
  '/cart',
  '/cart/',
  '/bag',
  '/basket',
  '/basket/',
  '/shopping/cart',
  '/shopping-cart',
  '/shop/cart',
  '/store/cart',
  '/ec/cart',
  '/order/cart',
  '/checkout',
  '/checkout/',
  '/purchase',
  '/buy',
  // EC-CUBE
  '/cart/index',
  // MakeShop
  '/cart/cart.aspx',
  // futureshop
  '/fs/cart',
  // カラーミー
  '/cart/list',
  // Yahoo!ショッピング風
  '/ys/cart',
  // 独自システムでよくあるパターン
  '/mypage/cart',
  '/member/cart',
  '/user/cart',
  '/sp/cart',
  '/pc/cart',
];

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

// ── EC プラットフォーム検出 ───────────────────────────────────────────────────
const PLATFORM_DEFINITIONS = [
  { name: 'Shopify',           patterns: [/cdn\.shopify\.com/i, /shopify\.com\/s\//i, /Shopify\.theme/i] },
  { name: 'EC-CUBE',           patterns: [/ec-cube/i, /eccube/i] },
  { name: 'カラーミーショップ',   patterns: [/color-me-shop\.com/i, /shop-pro\.jp/i] },
  { name: 'MakeShop',          patterns: [/makeshop\.jp/i] },
  { name: 'futureshop',        patterns: [/future-shop\.jp/i, /futureshop/i] },
  { name: 'BASE',              patterns: [/base\.ec/i, /thebase\.in/i] },
  { name: 'STORES',            patterns: [/stores\.jp/i, /stores\.business/i] },
  { name: 'Yahoo!ショッピング', patterns: [/shopping\.yahooapis\.jp/i, /ystatic\.net.*shopping/i] },
  { name: '楽天',              patterns: [/rakuten\.co\.jp/i, /r10s\.jp/i] },
];

// ── PSP / Platform Detection ──────────────────────────────────────────────────
function detectPSPs(html, networkUrls) {
  const allText = html + '\n' + networkUrls.join('\n');
  const detected = [];
  for (const psp of PSP_DEFINITIONS) {
    for (const pattern of psp.patterns) {
      if (pattern.test(allText)) { detected.push(psp.name); break; }
    }
  }
  return detected;
}

function detectPlatform(html, networkUrls) {
  const allText = html + '\n' + networkUrls.join('\n');
  for (const platform of PLATFORM_DEFINITIONS) {
    for (const pattern of platform.patterns) {
      if (pattern.test(allText)) return platform.name;
    }
  }
  return '';
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
  const header = ['入力URL', 'カートURL', 'ステータス', 'プラットフォーム', '検出PSP', 'エラー', ...allPspNames];
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) {
    const detectedSet = new Set(row.psps || []);
    const flagCols = allPspNames.map((name) => (detectedSet.has(name) ? '1' : '0'));
    const line = [
      row.inputUrl,
      row.cartUrl || '',
      row.status || '',
      row.platform || '',
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
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── カートURL探索 ─────────────────────────────────────────────────────────────
async function findCartUrl(page, baseUrl, timeout) {
  const base = new URL(baseUrl);
  const origin = base.origin;

  for (const cartPath of CART_PATHS) {
    const cartUrl = origin + cartPath;
    try {
      const res = await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 10000) });
      if (res && res.status() === 200) {
        // カートっぽいページか簡易チェック（404ページでも200を返すサイト対策）
        const content = await page.content();
        const isCartLike = /cart|カート|basket|bag|ショッピング|買い物|checkout/i.test(content);
        if (isCartLike) return cartUrl;
      }
    } catch (_) {
      // このパスはスキップ
    }
  }
  return null;
}

// ── 1サイトをスキャン ─────────────────────────────────────────────────────────
async function scanSite(browser, inputUrl, timeout, waitMs) {
  const page = await browser.newPage();
  const networkUrls = [];

  page.on('request', (req) => networkUrls.push(req.url()));

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' });

  try {
    // Step1: トップページでプラットフォーム検出
    await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout });
    const topHtml = await page.content();
    const platform = detectPlatform(topHtml, networkUrls);

    // Step2: カートURL探索
    const cartUrl = await findCartUrl(page, inputUrl, timeout);

    if (!cartUrl) {
      // カートページが見つからない場合はトップページで判定
      const psps = detectPSPs(topHtml, networkUrls);
      return { inputUrl, cartUrl: '(未発見)', status: '-', platform, psps, error: 'カートページ未発見' };
    }

    // Step3: カートページでPSP検出
    networkUrls.length = 0; // ネットワークログをリセット
    const res = await page.goto(cartUrl, { waitUntil: 'networkidle2', timeout });
    const status = res ? res.status() : '';

    // JS実行待機
    await new Promise((r) => setTimeout(r, waitMs));

    const html = await page.content();
    const psps = detectPSPs(html, networkUrls);

    return { inputUrl, cartUrl, status, platform, psps, error: '' };
  } catch (err) {
    return { inputUrl, cartUrl: '', status: '', platform: '', psps: [], error: err.message };
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

  const rawUrls = fs.readFileSync(urlsFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (rawUrls.length === 0) {
    console.error('Error: No URLs found in input file.');
    process.exit(1);
  }

  console.log(`\n🔍 PSP Detector v3 (カートURL自動推測版)`);
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
    const inputUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const result = await scanSite(browser, inputUrl, timeout, waitMs);
    completed++;

    const pspLabel = result.psps.length > 0 ? result.psps.join(', ') : 'none';
    const platformLabel = result.platform || '不明';
    console.log(
      `[${completed}/${rawUrls.length}] ${inputUrl}\n` +
      `   プラットフォーム: ${platformLabel}\n` +
      `   カートURL: ${result.cartUrl || 'なし'}\n` +
      `   PSP: ${pspLabel}\n`
    );
    return result;
  });

  const results = await runWithConcurrency(tasks, concurrency);
  await browser.close();

  const bom = '\uFEFF';
  fs.writeFileSync(outputFile, bom + buildCsv(results), 'utf8');

  const detected = results.filter((r) => r.psps && r.psps.length > 0).length;
  const cartFound = results.filter((r) => r.cartUrl && r.cartUrl !== '(未発見)').length;
  const errors = results.filter((r) => r.error && r.cartUrl !== '(未発見)').length;

  console.log(`\n✅ Done!`);
  console.log(`   合計:           ${results.length} サイト`);
  console.log(`   カートURL発見:  ${cartFound} サイト`);
  console.log(`   PSP検出:        ${detected} サイト`);
  console.log(`   エラー:         ${errors} サイト`);
  console.log(`   出力:           ${path.resolve(outputFile)}\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
