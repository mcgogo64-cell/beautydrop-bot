// bot.mjs — BeautyDrop fetcher (serversız, günlük JSON üretir)
// Node 20+, ESM. Playwright kullanır. Hedef: stabil run + temiz JSON.

// === Imports ===
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import pLimit from 'p-limit';

// (Opsiyonel) RSS/Atom ileride gerekir diye parser import edildi; şimdilik başlık/metaları alıyoruz.
import { XMLParser } from 'fast-xml-parser';

// === CLI options ===
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.split('=');
    const key = k.replace(/^--/, '');
    return [key, v === undefined ? true : v];
  })
);
const HEADLESS = args.headless !== undefined ? args.headless !== 'false' : true;
const MAX_PER_PAGE = Number(args.maxPerPage || 60);
const CONCURRENCY = Number(args.concurrency || 4);

// === Paths ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FEEDS_TXT = path.join(__dirname, 'feeds', 'beautydrop-feeds.txt');
const DATA_DIR = path.join(__dirname, 'data');

// === Helpers ===
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
function todayIsoDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}
function trimToMax(str, max = 300) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ---- feeds.txt parser (tek ve nihai tanım) ----
function parseFeedsTxt(txt) {
  return txt
    .split(/\r?\n/)
    .map(l => l.trim())
    // satır sonu açıklamalarını temizle (# veya //)
    .map(l => l.replace(/\s+#.*$/, '').replace(/\s+\/\/.*$/, ''))
    // boş ve yorum satırlarını at
    .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))
    // yalnızca URL olanları al
    .filter(l => /^https?:\/\//i.test(l))
    // yinelenenleri kaldır
    .filter((v, i, a) => a.indexOf(v) === i)
    // güvenlik için whitespace kırp
    .map(u => u.trim());
}

async function readFeedsTxt(filePath) {
  try {
    const buf = await fs.readFile(filePath, 'utf8');
    const urls = parseFeedsTxt(buf);
    if (!urls.length) {
      console.warn(`[warn] ${filePath} içinde geçerli URL bulunamadı.`);
    }
    return urls.slice(0, MAX_PER_PAGE);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[warn] ${filePath} bulunamadı. Çalışma tamamlandı (boş).`);
      return [];
    }
    throw err;
  }
}

function isLikelyXmlFeed(text) {
  // çok kaba sezgi: XML başlığı içeriyor mu?
  return /^\s*<\?xml\b/.test(text) || /<(rss|feed)\b/i.test(text);
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function extractMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=[\"']${name}[\"'][^>]*content=[\"']([^\"']+)[\"'][^>]*>`,
    'i'
  );
  const m = html.match(re);
  return m ? m[1].trim() : '';
}

async function fetchWithPlaywright(url) {
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Ağır siteler için ufak bekleme + hafif scroll
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(400);

    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function parseXmlFeed(xmlText, baseUrl) {
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
    const doc = parser.parse(xmlText);
    // RSS veya Atom başlık çıkarımı (basit)
    let feedTitle = '';
    if (doc.rss?.channel?.title) feedTitle = String(doc.rss.channel.title);
    else if (doc.feed?.title) feedTitle = String(doc.feed.title);

    // Bu bot şu an ürün kırpmaz; yalnızca feed başlığını raporlar.
    return {
      type: 'xml',
      feedTitle: trimToMax(feedTitle, 120),
      itemsCount:
        (doc.rss?.channel?.item?.length || doc.feed?.entry?.length || 0)
    };
  } catch {
    return { type: 'xml', parseError: 'xml-parse-failed' };
  }
}

// === Main scrape ===
async function scrapeAll() {
  await ensureDir(DATA_DIR);
  const feeds = await readFeedsTxt(FEEDS_TXT);

  if (!feeds.length) {
    const outPath = path.join(DATA_DIR, `${todayIsoDate()}.json`);
    const payload = {
      date: todayIsoDate(),
      total: 0,
      note: 'No feeds to scrape',
      results: []
    };
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[ok] Boş çıktı yazıldı: ${outPath}`);
    return;
  }

  console.log(`[info] ${feeds.length} URL işlenecek | headless=${HEADLESS} | cc=${CONCURRENCY}`);

  const limit = pLimit(CONCURRENCY);
  const jobs = feeds.map((url, idx) =>
    limit(async () => {
      const startedAt = new Date().toISOString();
      try {
        const { html, finalUrl } = await fetchWithPlaywright(url);

        if (isLikelyXmlFeed(html)) {
          const meta = parseXmlFeed(html, finalUrl);
          return {
            url,
            finalUrl,
            startedAt,
            finishedAt: new Date().toISOString(),
            kind: 'xml',
            title: meta.feedTitle || extractTitle(html),
            meta,
            hash: sha1(html),
            ok: true
          };
        }

        const title = extractTitle(html);
        const desc =
          extractMeta(html, 'og:description') ||
          extractMeta(html, 'description') ||
          '';

        return {
          url,
          finalUrl,
          startedAt,
          finishedAt: new Date().toISOString(),
          kind: 'html',
          title: trimToMax(title, 140),
          description: trimToMax(desc, 240),
          hash: sha1(html),
          ok: true
        };
      } catch (err) {
        return {
          url,
          startedAt,
          finishedAt: new Date().toISOString(),
          ok: false,
          error: {
            message: String(err?.message || err),
            name: err?.name || 'Error'
          }
        };
      }
    })
  );

  const results = await Promise.all(jobs);
  const out = {
    date: todayIsoDate(),
    total: results.length,
    ok: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results
  };

  const outPath = path.join(DATA_DIR, `${todayIsoDate()}.json`);
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[ok] Çıktı yazıldı: ${outPath}`);
}

// === Entry ===
scrapeAll().catch(err => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
