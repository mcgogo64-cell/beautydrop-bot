// bot.mjs — BeautyDrop fetcher (Node 20+, ESM, Playwright)
// Çıktılar: data/deals-YYYY-MM-DD.json ve data/deals-latest.json

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import pLimit from 'p-limit';
import { XMLParser } from 'fast-xml-parser';

// === CLI ===
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v === undefined ? true : v];
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

// === Utils ===
async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
function todayIsoDate() { return new Date().toISOString().slice(0, 10); }
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function trimToMax(s, n = 300) { return s ? (s.length > n ? s.slice(0, n) + '…' : s) : ''; }

// ---- feeds.txt parser (TEK tanım) ----
function parseFeedsTxt(txt) {
  return txt
    .split(/\r?\n/)
    .map(l => l.trim())
    .map(l => l.replace(/\s+#.*$/, '').replace(/\s+\/\/.*$/, '')) // satır sonu açıklamalar
    .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))
    .filter(l => /^https?:\/\//i.test(l))                          // sadece URL
    .filter((v, i, a) => a.indexOf(v) === i)
    .map(u => u.trim());
}

async function readFeedsTxt(filePath) {
  try {
    const buf = await fs.readFile(filePath, 'utf8');
    const urls = parseFeedsTxt(buf);
    if (!urls.length) console.warn(`[warn] ${filePath} içinde geçerli URL yok.`);
    return urls.slice(0, MAX_PER_PAGE);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[warn] ${filePath} bulunamadı. Boş çalışılacak.`);
      return [];
    }
    throw e;
  }
}

function isLikelyXmlFeed(text) {
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
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(400);
    const html = await page.content();
    return { html, finalUrl: page.url() };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function parseXmlFeed(xmlText) {
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
    const doc = parser.parse(xmlText);
    let feedTitle = '';
    if (doc.rss?.channel?.title) feedTitle = String(doc.rss.channel.title);
    else if (doc.feed?.title) feedTitle = String(doc.feed.title);
    return {
      type: 'xml',
      feedTitle: trimToMax(feedTitle, 120),
      itemsCount: (doc.rss?.channel?.item?.length || doc.feed?.entry?.length || 0),
    };
  } catch {
    return { type: 'xml', parseError: 'xml-parse-failed' };
  }
}

// === Main ===
async function scrapeAll() {
  await ensureDir(DATA_DIR);
  const feeds = await readFeedsTxt(FEEDS_TXT);

  const day = todayIsoDate();
  const dailyPath = path.join(DATA_DIR, `deals-${day}.json`);
  const latestPath = path.join(DATA_DIR, `deals-latest.json`);

  if (!feeds.length) {
    const payload = { date: day, total: 0, note: 'No feeds to scrape', results: [] };
    await fs.writeFile(dailyPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.writeFile(latestPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[ok] Yazıldı: ${dailyPath}`);
    console.log(`[ok] Yazıldı: ${latestPath}`);
    return;
  }

  console.log(`[info] ${feeds.length} URL | headless=${HEADLESS} | cc=${CONCURRENCY}`);

  const limit = pLimit(CONCURRENCY);
  const jobs = feeds.map(url =>
    limit(async () => {
      const startedAt = new Date().toISOString();
      try {
        const { html, finalUrl } = await fetchWithPlaywright(url);
        if (isLikelyXmlFeed(html)) {
          const meta = parseXmlFeed(html);
          return {
            url, finalUrl, startedAt, finishedAt: new Date().toISOString(),
            kind: 'xml', title: meta.feedTitle || extractTitle(html), meta,
            hash: sha1(html), ok: true
          };
        }
        const title = extractTitle(html);
        const desc = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
        return {
          url, finalUrl, startedAt, finishedAt: new Date().toISOString(),
          kind: 'html', title: trimToMax(title, 140), description: trimToMax(desc, 240),
          hash: sha1(html), ok: true
        };
      } catch (err) {
        return {
          url, startedAt, finishedAt: new Date().toISOString(), ok: false,
          error: { message: String(err?.message || err), name: err?.name || 'Error' }
        };
      }
    })
  );

  const results = await Promise.all(jobs);
  const out = {
    date: day,
    total: results.length,
    ok: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results
  };

  await fs.writeFile(dailyPath, JSON.stringify(out, null, 2), 'utf8');
  await fs.writeFile(latestPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[ok] Yazıldı: ${dailyPath}`);
  console.log(`[ok] Yazıldı: ${latestPath}`);
}

scrapeAll().catch(err => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
