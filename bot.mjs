// bot.mjs — BeautyDrop deals scraper (Node 20+, ESM)
// Çıktılar: data/deals-YYYY-MM-DD.json ve data/deals-latest.json

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import pLimit from 'p-limit';

// ===== CLI =====
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v === undefined ? true : v];
  })
);
const HEADLESS     = args.headless !== undefined ? args.headless !== 'false' : true;
const MAX_PER_PAGE = Number(args.maxPerPage || 60);     // feed'den alınacak sayfa sayısı
const CONCURRENCY  = Number(args.concurrency || 4);     // aynı anda kaç feed işlenecek
const DETAIL_LIMIT = Number(args.detailLimit || 8);     // bir liste sayfasından kaç ürün detayına girilecek

// ===== Paths =====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FEEDS_TXT  = path.join(__dirname, 'feeds', 'beautydrop-feeds.txt');
const DATA_DIR   = path.join(__dirname, 'data');

// ===== Utils =====
async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
function isoDay() { return new Date().toISOString().slice(0, 10); }
function sha1(x) { return crypto.createHash('sha1').update(String(x)).digest('hex'); }
function trim(s, n = 200) { return s ? (s.length > n ? s.slice(0, n) + '…' : s) : ''; }
function uniq(arr) { return Array.from(new Set(arr)); }

function guessCountryFromHost(host) {
  const h = host.toLowerCase();
  if (h.endsWith('.de')) return 'DE';
  if (h.endsWith('.fr')) return 'FR';
  if (h.endsWith('.it')) return 'IT';
  if (h.endsWith('.es')) return 'ES';
  if (h.endsWith('.nl')) return 'NL';
  if (h.endsWith('.pl')) return 'PL';
  if (h.endsWith('.ro')) return 'RO';
  if (h.endsWith('.tr')) return 'TR';
  if (h.endsWith('.co.uk') || h.endsWith('.uk')) return 'UK';
  return null;
}

// ---- feeds.txt parser (Ad | URL dahil her formu destekler) ----
function parseFeedsTxt(txt) {
  const urls = [];
  for (let raw of txt.split(/\r?\n/)) {
    let l = (raw || '').trim();
    if (!l) continue;
    // satır sonu açıklama temizle (#, //)
    l = l.replace(/\s+#.*$/, '').replace(/\s+\/\/.*$/, '').trim();
    if (!l || l.startsWith('#') || l.startsWith('//')) continue;

    // satırdaki ilk URL'i yakala (Ad | URL, URL | Ad, vb.)
    const m = l.match(/https?:\/\/\S+/i);
    if (m) urls.push(m[0]);
  }
  return uniq(urls);
}

async function readFeeds(file) {
  try {
    const t = await fs.readFile(file, 'utf8');
    const list = parseFeedsTxt(t);
    if (!list.length) console.warn(`[warn] ${file} içinde geçerli URL bulunamadı.`);
    return list.slice(0, MAX_PER_PAGE);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[warn] ${file} bulunamadı. (boş çalışılacak)`);
      return [];
    }
    throw e;
  }
}

function safeJsonParse(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

function extractProductsFromLdJson(html, baseUrl) {
  const items = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    const obj = safeJsonParse(raw);
    if (!obj) continue;
    const nodes = Array.isArray(obj) ? obj : [obj];
    for (const node of nodes) {
      const graphs = Array.isArray(node['@graph']) ? node['@graph'] : [node];
      for (const g of graphs) {
        const types = [].concat(g['@type'] || []);
        if (!types.some(t => String(t).toLowerCase() === 'product')) continue;

        const name  = g.name || '';
        const brand = typeof g.brand === 'object' ? (g.brand?.name || '') : (g.brand || '');
        const image = Array.isArray(g.image) ? g.image[0] : (g.image || '');
        const url   = g.url || baseUrl;

        const offers = g.offers ? (Array.isArray(g.offers) ? g.offers : [g.offers]) : [];
        if (!offers.length) {
          items.push({
            source: 'ldjson', name: trim(name,180), brand: trim(brand,80),
            price: null, currency: null, availability: null, url, image, is_on_sale: null
          });
          continue;
        }
        for (const ofr of offers) {
          const price = ofr.price ?? ofr.lowPrice ?? ofr.highPrice ?? null;
          const curr  = ofr.priceCurrency ?? null;
          const old   = ofr.priceSpecification?.price ?? ofr.listPrice ?? ofr.highPrice ?? null;
          const isOn  = (price && old && Number(price) < Number(old)) ? true : null;

          items.push({
            source: 'ldjson',
            name: trim(name,180),
            brand: trim(brand,80),
            price: price !== undefined ? String(price) : null,
            currency: curr,
            availability: ofr.availability ?? null,
            url, image,
            is_on_sale: isOn
          });
        }
      }
    }
  }
  return items;
}

function extractProductsFromOg(html, baseUrl) {
  const out = [];
  const amt   = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i);
  const curr  = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]*content=["']([^"']+)["']/i);
  const title = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const img   = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

  if (amt && curr) {
    out.push({
      source: 'og',
      name: trim(title?.[1] || '', 180),
      brand: null,
      price: String(amt[1]),
      currency: curr[1],
      availability: null,
      url: baseUrl,
      image: img?.[1] || null,
      is_on_sale: null
    });
  }
  return out;
}

function dedupe(items) {
  const seen = new Set();
  const out  = [];
  for (const it of items) {
    const key = sha1(`${it.name}|${it.price}|${it.currency}|${it.url}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function scrapeDetail(context, href) {
  const p = await context.newPage();
  try {
    await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p.waitForTimeout(400);
    const html = await p.content();
    const finalUrl = p.url();
    const ld = extractProductsFromLdJson(html, finalUrl);
    const og = extractProductsFromOg(html, finalUrl);
    const items = dedupe([...ld, ...og]);
    return { ok: true, url: href, finalUrl, items };
  } catch (err) {
    return { ok: false, url: href, error: String(err?.message || err) };
  } finally {
    await p.close().catch(() => {});
  }
}

async function scrapeUrl(url) {
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(400);

    // 1) Liste sayfasının kendisinden ürün verisi (nadiren)
    const listHtml  = await page.content();
    const listUrl   = page.url();
    const host      = new URL(listUrl).host;
    const country   = guessCountryFromHost(host) || 'UNK';

    let items = dedupe([
      ...extractProductsFromLdJson(listHtml, listUrl),
      ...extractProductsFromOg(listHtml, listUrl)
    ]);

    // 2) Ürün linklerini bul ve ilk N tanesini detaydan çek
    let productLinks = await page.$$eval('a', as => {
      const hrefs = [];
      for (const a of as) {
        const href = a.href || a.getAttribute('href') || '';
        if (!href) continue;
        if (href.startsWith('javascript:')) continue;
        // sadece tam URL
        const abs = href.startsWith('http://') || href.startsWith('https://');
        if (!abs) continue;
        const t = href.toLowerCase();
        // geniş ama güvenli heuristikler
        if (
          t.includes('/product') ||
          t.includes('/produkte') ||
          t.includes('/produs') ||
          t.includes('/producto') ||
          t.includes('/p/') ||
          /\/\d{4,}/.test(t) // bazı sitelerde ürün id'leri
        ) {
          hrefs.push(href);
        }
      }
      return Array.from(new Set(hrefs));
    });

    productLinks = productLinks.slice(0, DETAIL_LIMIT);

    const lim = pLimit(Math.min(DETAIL_LIMIT, 4));
    const detailResults = await Promise.all(
      productLinks.map(href => lim(() => scrapeDetail(context, href)))
    );

    for (const r of detailResults) {
      if (r.ok && r.items?.length) items.push(...r.items);
    }

    items = dedupe(items).slice(0, 50); // güvenli üst limit

    return {
      sourceUrl: url,
      finalUrl: listUrl,
      host,
      country,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      itemsCount: items.length,
      items
    };
  } catch (err) {
    return {
      sourceUrl: url,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: { name: err?.name || 'Error', message: String(err?.message || err) }
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  await ensureDir(DATA_DIR);
  const feeds = await readFeeds(FEEDS_TXT);

  const day        = isoDay();
  const dailyPath  = path.join(DATA_DIR, `deals-${day}.json`);
  const latestPath = path.join(DATA_DIR, `deals-latest.json`);

  if (!feeds.length) {
    const payload = { date: day, total: 0, note: 'No feeds to scrape', results: [] };
    await fs.writeFile(dailyPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.writeFile(latestPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[warn] ${FEEDS_TXT} boş veya URL bulunamadı.`);
    console.log(`[ok] Yazıldı: ${dailyPath}`);
    return;
  }

  console.log(`[info] ${feeds.length} feed | headless=${HEADLESS} | cc=${CONCURRENCY} | detailLimit=${DETAIL_LIMIT}`);

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(feeds.map(u => limit(() => scrapeUrl(u))));

  const out = {
    date: day,
    total: results.length,
    perCountry: Object.fromEntries(
      Object.entries(
        results.reduce((acc, r) => {
          const c = r.country || 'UNK';
          acc[c] = (acc[c] || 0) + (r.itemsCount || 0);
          return acc;
        }, {})
      ).sort()
    ),
    results
  };

  await fs.writeFile(dailyPath, JSON.stringify(out, null, 2), 'utf8');
  await fs.writeFile(latestPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[ok] Yazıldı: ${dailyPath}`);
  console.log(`[ok] Yazıldı: ${latestPath}`);
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exitCode = 1;
});
