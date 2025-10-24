// bot.mjs — BeautyDrop deals scraper (Node 20+, ESM, Playwright)
// Amaç: İndirim odaklı, sayısal alanlara sahip, mobil app'e beslenebilir JSON üretmek.
// Çıktılar: data/deals-YYYY-MM-DD.json  ve  data/deals-latest.json

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import pLimit from 'p-limit';

// ====== CLI ======
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v === undefined ? true : v];
  })
);
const HEADLESS     = args.headless !== undefined ? args.headless !== 'false' : true;
const MAX_PER_PAGE = Number(args.maxPerPage || 60);   // feed'den alınacak sayfa
const CONCURRENCY  = Number(args.concurrency || 4);   // aynı anda kaç feed
const DETAIL_LIMIT = Number(args.detailLimit || 10);  // listeden kaç ürün detayına girilecek

// ====== Paths ======
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FEEDS_TXT  = path.join(__dirname, 'feeds', 'beautydrop-feeds.txt');
const DATA_DIR   = path.join(__dirname, 'data');

// ====== Utils ======
async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
function isoDay() { return new Date().toISOString().slice(0, 10); }
function sha1(x) { return crypto.createHash('sha1').update(String(x)).digest('hex'); }
function trim(s, n = 200) { return s ? (s.length > n ? s.slice(0, n) + '…' : s) : ''; }
function uniq(arr) { return Array.from(new Set(arr)); }

function guessCountryFromHost(host) {
  const h = host.toLowerCase();
  if (h.endsWith('.tr')) return 'TR';
  if (h.endsWith('.de')) return 'DE';
  if (h.endsWith('.fr')) return 'FR';
  if (h.endsWith('.it')) return 'IT';
  if (h.endsWith('.es')) return 'ES';
  if (h.endsWith('.nl')) return 'NL';
  if (h.endsWith('.be')) return 'BE';
  if (h.endsWith('.at')) return 'AT';
  if (h.endsWith('.ch')) return 'CH';
  if (h.endsWith('.pl')) return 'PL';
  if (h.endsWith('.cz')) return 'CZ';
  if (h.endsWith('.sk')) return 'SK';
  if (h.endsWith('.hu')) return 'HU';
  if (h.endsWith('.ro')) return 'RO';
  if (h.endsWith('.bg')) return 'BG';
  if (h.endsWith('.gr')) return 'GR';
  if (h.endsWith('.pt')) return 'PT';
  if (h.endsWith('.dk')) return 'DK';
  if (h.endsWith('.se')) return 'SE';
  if (h.endsWith('.no')) return 'NO';
  if (h.endsWith('.fi')) return 'FI';
  if (h.endsWith('.ie')) return 'IE';
  if (h.endsWith('.co.uk') || h.endsWith('.uk')) return 'UK';
  return null;
}
function defaultCurrencyForCountry(country) {
  const map = {
    TR: 'TRY', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR',
    BE: 'EUR', AT: 'EUR', CH: 'CHF', PL: 'PLN', CZ: 'CZK', SK: 'EUR',
    HU: 'HUF', RO: 'RON', BG: 'BGN', GR: 'EUR', PT: 'EUR', DK: 'DKK',
    SE: 'SEK', NO: 'NOK', FI: 'EUR', IE: 'EUR', UK: 'GBP'
  };
  return map[country] || null;
}

// ---- feeds.txt parser (satır içindeki ilk URL'i yakalar; "Ad | URL" dahil) ----
function parseFeedsTxt(txt) {
  const urls = [];
  for (let raw of txt.split(/\r?\n/)) {
    let l = (raw || '').trim();
    if (!l) continue;
    l = l.replace(/\s+#.*$/, '').replace(/\s+\/\/.*$/, '').trim(); // satır sonu yorum
    if (!l || l.startsWith('#') || l.startsWith('//')) continue;
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

// ---- price helpers ----
function parseNumberLocalized(input) {
  if (input == null) return null;
  let s = String(input).replace(/\s/g, '').replace(/[^\d,.\-]/g, '');
  // Eğer hem virgül hem nokta varsa: son görülen ayırıcıyı ondalık say
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
    } else {
      s = s.replace(/,/g, ''); // 1,234.56 -> 1234.56
    }
  } else if (s.includes(',')) {
    // Sadece virgül varsa onu ondalığa çevir
    s = s.replace(',', '.');
  }
  const val = Number(s);
  return Number.isFinite(val) ? val : null;
}
function detectCurrencyFromText(txt) {
  if (!txt) return null;
  const s = txt.toUpperCase();
  if (/[€]/.test(txt)) return 'EUR';
  if (/[£]/.test(txt)) return 'GBP';
  if (/[$]/.test(txt)) return 'USD'; // varsayımsal
  if (/PLN|ZŁ/.test(s)) return 'PLN';
  if (/CHF/.test(s)) return 'CHF';
  if (/CZK|KČ/.test(s)) return 'CZK';
  if (/HUF|FT/.test(s)) return 'HUF';
  if (/RON|LEI/.test(s)) return 'RON';
  if (/BGN/.test(s)) return 'BGN';
  if (/DKK/.test(s)) return 'DKK';
  if (/SEK/.test(s)) return 'SEK';
  if (/NOK/.test(s)) return 'NOK';
  if (/TRY|TL/.test(s)) return 'TRY';
  if (/GBP/.test(s)) return 'GBP';
  if (/EUR/.test(s)) return 'EUR';
  return null;
}
function computeDiscount(priceNew, priceOld) {
  if (priceNew == null || priceOld == null) return null;
  if (!Number.isFinite(priceNew) || !Number.isFinite(priceOld)) return null;
  if (priceOld <= 0 || priceNew >= priceOld) return null;
  const pct = ((priceOld - priceNew) / priceOld) * 100;
  return Math.round(pct * 10) / 10; // 1 ondalık
}

// ---- HTML parsers ----
function safeJsonParse(txt) { try { return JSON.parse(txt); } catch { return null; } }

function extractProductsFromLdJson(html, baseUrl, host, country) {
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
            source: 'ldjson',
            name: trim(name, 180),
            brand: trim(brand, 80),
            price_new: null,
            price_old: null,
            discount_pct: null,
            currency: null,
            availability: null,
            url,
            image,
            store: host,
            country
          });
          continue;
        }
        for (const ofr of offers) {
          // LD-JSON çoğunlukla numeric/detaylıdır
          const pNewStr = ofr.price ?? ofr.lowPrice ?? ofr.highPrice ?? null;
          const pNewNum = typeof pNewStr === 'number' ? pNewStr : parseNumberLocalized(pNewStr);
          const curr    = ofr.priceCurrency || null;

          // Eski fiyatı yakalamaya çalış: listPrice / highPrice > price
          const pOldCand =
            ofr.listPrice ??
            (typeof ofr.highPrice === 'number' ? ofr.highPrice : null) ??
            (ofr.priceSpecification && ofr.priceSpecification.price ? ofr.priceSpecification.price : null);

          const pOldNum = typeof pOldCand === 'number' ? pOldCand : parseNumberLocalized(pOldCand);
          const price_old = (pNewNum != null && pOldNum != null && pOldNum > pNewNum) ? pOldNum : null;

          const discount_pct = computeDiscount(pNewNum ?? null, price_old);

          items.push({
            source: 'ldjson',
            name: trim(name, 180),
            brand: trim(brand, 80),
            price_new: pNewNum ?? null,
            price_old,
            discount_pct,
            currency: curr,
            availability: ofr.availability ?? null,
            url,
            image,
            store: host,
            country
          });
        }
      }
    }
  }
  return items;
}

function extractProductsFromOg(html, baseUrl, host, country) {
  // OG product meta — tek ürün sayfalarında işe yarar
  const out = [];
  const amt   = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i);
  const curr  = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]*content=["']([^"']+)["']/i);
  const title = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const img   = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

  if (amt) {
    const priceNewNum = parseNumberLocalized(amt[1]);
    const currency = (curr && curr[1]) ? curr[1] : detectCurrencyFromText(amt[1]);
    out.push({
      source: 'og',
      name: trim(title?.[1] || '', 180),
      brand: null,
      price_new: priceNewNum,
      price_old: null,
      discount_pct: null,
      currency,
      availability: null,
      url: baseUrl,
      image: img?.[1] || null,
      store: host,
      country
    });
  }
  return out;
}

function dedupe(items) {
  const seen = new Set();
  const out  = [];
  for (const it of items) {
    const key = sha1(`${(it.name||'').toLowerCase()}|${it.url}|${it.price_new ?? ''}|${it.currency ?? ''}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---- Navigation helpers ----
async function scrapeDetail(context, href, host, country) {
  const p = await context.newPage();
  try {
    await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p.waitForTimeout(400);
    const html = await p.content();
    const finalUrl = p.url();
    const ld = extractProductsFromLdJson(html, finalUrl, host, country);
    const og = extractProductsFromOg(html, finalUrl, host, country);
    const items = dedupe([...ld, ...og]);
    return { ok: true, url: href, finalUrl, items };
  } catch (err) {
    return { ok: false, url: href, error: String(err?.message || err) };
  } finally {
    await p.close().catch(() => {});
  }
}

async function findProductLinks(page) {
  // Heuristik + yaygın kart seçicileri
  const selectors = [
    'a.product-link',
    'a.product-card',
    'a.ProductCard__link',
    'a.c-product-card__link',
    '.product a[href]',
    '.product-card a[href]',
    '.product-item a[href]',
    '.grid-product a[href]',
    'a[href*="/product"]',
    'a[href*="/produkte"]',
    'a[href*="/producto"]',
    'a[href*="/produkt"]',
    'a[href*="/p/"]'
  ];

  // Çok geniş tarama: tüm <a>’ları al, filtrele
  const broadLinks = await page.$$eval('a', as => {
    const hrefs = [];
    for (const a of as) {
      const href = a.href || a.getAttribute('href') || '';
      if (!href) continue;
      if (!/^https?:\/\//i.test(href)) continue;
      const t = href.toLowerCase();
      if (
        t.includes('/product') ||
        t.includes('/produkte') ||
        t.includes('/producto') ||
        t.includes('/produkt') ||
        /\/p\/[a-z0-9]/.test(t) ||
        /\/\d{4,}/.test(t)
      ) {
        hrefs.push(href);
      }
    }
    return Array.from(new Set(hrefs));
  });

  // Spesifik seçiciler (daha güvenilir)
  const matched = new Set(broadLinks);
  for (const sel of selectors) {
    try {
      const links = await page.$$eval(sel, els =>
        Array.from(new Set(
          els
            .map(e => (e.href || e.getAttribute('href') || ''))
            .filter(h => /^https?:\/\//i.test(h))
        ))
      );
      for (const l of links) matched.add(l);
    } catch { /* selector yoksa geç */ }
  }
  return Array.from(matched);
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

    const listHtml  = await page.content();
    const listUrl   = page.url();
    const host      = new URL(listUrl).host;
    const country   = guessCountryFromHost(host) || 'UNK';

    // 1) Liste sayfasının kendisinden yakalanabilen ürünler (nadir)
    let items = dedupe([
      ...extractProductsFromLdJson(listHtml, listUrl, host, country),
      ...extractProductsFromOg(listHtml, listUrl, host, country)
    ]);

    // 2) Ürün linklerini bul → ilk N tanesini detaydan topla
    let productLinks = await findProductLinks(page);
    productLinks = productLinks.slice(0, DETAIL_LIMIT);

    const lim = pLimit(Math.min(DETAIL_LIMIT, 4));
    const detailResults = await Promise.all(
      productLinks.map(href => lim(() => scrapeDetail(context, href, host, country)))
    );
    for (const r of detailResults) {
      if (r.ok && r.items?.length) items.push(...r.items);
    }

    // 3) Para birimi eksikse ülke varsayılanı ile doldur
    const fallbackCurrency = defaultCurrencyForCountry(country);
    items = items.map(it => ({
      ...it,
      currency: it.currency || fallbackCurrency || it.currency
    }));

    // 4) Son temizlik
    items = dedupe(items)
      .filter(it => it.name && it.url)
      .map(it => {
        // Net indirim yüzdesi yoksa (price_old&price_new varsa) hesapla
        const discount_pct = computeDiscount(it.price_new, it.price_old);
        return { ...it, discount_pct };
      })
      .slice(0, 50);

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

// ====== Main ======
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
  const results = await Promise.all(feeds.slice(0, MAX_PER_PAGE).map(u => limit(() => scrapeUrl(u))));

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
