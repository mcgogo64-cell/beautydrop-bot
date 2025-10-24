// bot.mjs — BeautyDrop deals scraper (Node 20+, ESM, Playwright)
// Odak: fiyat yakalama güvenilirliği (LD+JSON → Microdata → OG → DOM → Script JSON).
// Çıktılar: data/deals-YYYY-MM-DD.json  ve  data/deals-latest.json

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
const MAX_PER_PAGE = Number(args.maxPerPage || 60);
const CONCURRENCY  = Number(args.concurrency || 4);
const DETAIL_LIMIT = Number(args.detailLimit || 10);

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
function parseNumberLocalized(input) {
  if (input == null) return null;
  let s = String(input);
  // HTML entities vs. whitespace temizliği
  s = s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  // Para sembol ve harfleri ayıkla fakat ayırıcıları koru
  s = s.replace(/[^\d,.\-]/g, '');
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
    } else {
      s = s.replace(/,/g, '');                    // 1,234.56 → 1234.56
    }
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const val = Number(s);
  return Number.isFinite(val) ? val : null;
}
function detectCurrencyFromText(txt) {
  if (!txt) return null;
  const s = txt.toUpperCase();
  if (/[€]/.test(txt) || /EUR/.test(s)) return 'EUR';
  if (/[£]/.test(txt) || /GBP/.test(s)) return 'GBP';
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
  return null;
}
function computeDiscount(priceNew, priceOld) {
  if (priceNew == null || priceOld == null) return null;
  if (!Number.isFinite(priceNew) || !Number.isFinite(priceOld)) return null;
  if (priceOld <= 0 || priceNew >= priceOld) return null;
  const pct = ((priceOld - priceNew) / priceOld) * 100;
  return Math.round(pct * 10) / 10;
}

// ---- feeds parser (satır içindeki ilk URL'i yakalar; "Ad | URL" dahil) ----
function parseFeedsTxt(txt) {
  const urls = [];
  for (let raw of txt.split(/\r?\n/)) {
    let l = (raw || '').trim();
    if (!l) continue;
    l = l.replace(/\s+#.*$/, '').replace(/\s+\/\/.*$/, '').trim();
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

// ===== DOM extractors =====
function safeJsonParse(txt) { try { return JSON.parse(txt); } catch { return null; } }

function extractFromLdJson(html, baseUrl, host, country) {
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
            price_new: null, price_old: null, discount_pct: null,
            currency: null, availability: null, url, image, store: host, country
          });
          continue;
        }
        for (const ofr of offers) {
          const pNew = typeof ofr.price === 'number' ? ofr.price
                     : parseNumberLocalized(ofr.price ?? ofr.lowPrice ?? ofr.highPrice ?? null);
          const curr = ofr.priceCurrency || null;

          const pOldCand = (ofr.listPrice ?? ofr.highPrice ?? ofr.priceSpecification?.price ?? null);
          const pOld = typeof pOldCand === 'number' ? pOldCand : parseNumberLocalized(pOldCand);

          const price_old = (pNew != null && pOld != null && pOld > pNew) ? pOld : null;
          const discount_pct = computeDiscount(pNew ?? null, price_old);

          items.push({
            source: 'ldjson', name: trim(name,180), brand: trim(brand,80),
            price_new: pNew ?? null, price_old, discount_pct,
            currency: curr, availability: ofr.availability ?? null,
            url, image, store: host, country
          });
        }
      }
    }
  }
  return items;
}

function extractFromOg(html, baseUrl, host, country) {
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

// Fallback: görünür DOM + microdata/meta + script JSON tarama
async function extractFromDom(page, host, country) {
  return await page.evaluate(() => {
    function txt(el) {
      return (el && (el.textContent || '').trim()) || '';
    }
    function getNum(s) {
      if (!s) return null;
      let v = s.replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
      v = v.replace(/[^\d,.\-]/g,'');
      if (v.includes(',') && v.includes('.')) {
        if (v.lastIndexOf(',') > v.lastIndexOf('.')) v = v.replace(/\./g,'').replace(',', '.');
        else v = v.replace(/,/g, '');
      } else if (v.includes(',')) v = v.replace(',', '.');
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    function currencyFrom(s) {
      if (!s) return null;
      const u = s.toUpperCase();
      if (/[€]/.test(s) || /EUR/.test(u)) return 'EUR';
      if (/[£]/.test(s) || /GBP/.test(u)) return 'GBP';
      if (/PLN|ZŁ/.test(u)) return 'PLN';
      if (/CHF/.test(u)) return 'CHF';
      if (/CZK|KČ/.test(u)) return 'CZK';
      if (/HUF|FT/.test(u)) return 'HUF';
      if (/RON|LEI/.test(u)) return 'RON';
      if (/BGN/.test(u)) return 'BGN';
      if (/DKK/.test(u)) return 'DKK';
      if (/SEK/.test(u)) return 'SEK';
      if (/NOK/.test(u)) return 'NOK';
      if (/TRY|TL/.test(u)) return 'TRY';
      return null;
    }

    const out = [];

    // 1) Microdata
    document.querySelectorAll('meta[itemprop="price"], [itemprop="price"]').forEach(el => {
      const val = el.getAttribute && el.getAttribute('content') || txt(el);
      const price_new = getNum(val);
      if (price_new == null) return;
      let currency = null;
      const cEl = document.querySelector('meta[itemprop="priceCurrency"], [itemprop="priceCurrency"]');
      if (cEl) currency = (cEl.getAttribute && cEl.getAttribute('content')) || txt(cEl);
      currency = currencyFrom(currency) || currencyFrom(val);
      const nameEl = document.querySelector('[itemprop="name"]') || document.querySelector('h1');
      const name = (nameEl && nameEl.textContent && nameEl.textContent.trim()) || document.title || '';
      const imgEl = document.querySelector('[itemprop="image"]') || document.querySelector('meta[property="og:image"]');
      const image = imgEl ? (imgEl.getAttribute('content') || imgEl.getAttribute('src') || '') : '';
      out.push({ source:'dom-microdata', name, brand:null, price_new, price_old:null, discount_pct:null, currency, availability:null, url:location.href, image });
    });

    // 2) Görünür fiyat classları
    const priceSel = [
      '[class*="price"]:not(script):not(style)',
      '[data-price]',
      'meta[name="twitter:data1"]'
    ];
    const priceNodes = [];
    priceSel.forEach(sel => document.querySelectorAll(sel).forEach(e => priceNodes.push(e)));
    for (const el of priceNodes) {
      const val = el.tagName === 'META' ? el.getAttribute('content') : txt(el);
      const price_new = getNum(val);
      if (price_new == null) continue;
      const nameEl = document.querySelector('h1,[class*="title"],[itemprop="name"]');
      const name = nameEl ? nameEl.textContent.trim() : document.title || '';
      let currency = currencyFrom(val);
      if (!currency) {
        const metaCurr = document.querySelector('meta[itemprop="priceCurrency"], meta[property="product:price:currency"]');
        if (metaCurr) currency = currencyFrom(metaCurr.getAttribute('content'));
      }
      const imgMeta = document.querySelector('meta[property="og:image"]');
      const image = imgMeta ? (imgMeta.getAttribute('content') || '') : '';
      out.push({ source:'dom-visible', name, brand:null, price_new, price_old:null, discount_pct:null, currency, availability:null, url:location.href, image });
    }

    // 3) Script içi JSON taraması ("price": 123 gibi)
    const scriptTexts = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent || '');
    for (const s of scriptTexts) {
      const m = s.match(/"price"\s*:\s*"?([\d.,\s]+)"?/i);
      if (m) {
        const price_new = getNum(m[1]);
        if (price_new != null) {
          const nameEl = document.querySelector('h1,[itemprop="name"]');
          const name = nameEl ? nameEl.textContent.trim() : document.title || '';
          let currency = null;
          const m2 = s.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/i);
          if (m2) currency = m2[1];
          const imgMeta = document.querySelector('meta[property="og:image"]');
          const image = imgMeta ? (imgMeta.getAttribute('content') || '') : '';
          out.push({ source:'dom-script', name, brand:null, price_new, price_old:null, discount_pct:null, currency, availability:null, url:location.href, image });
        }
      }
    }

    // 4) Eski fiyat (strike/was/statt/antes)
    function findOldPrice() {
      const candidates = Array.from(document.querySelectorAll('[class*="old"], [class*="was"], [class*="strike"], [class*="statt"], [class*="antes"]'))
        .concat(Array.from(document.querySelectorAll('s, del')));
      for (const el of candidates) {
        const n = getNum(el.textContent || '');
        if (n != null) return n;
      }
      return null;
    }
    const oldPrice = findOldPrice();

    // Tüm kayıtların price_old'u yoksa bir kısmına uygula (aynı sayfadaki belirgin durumlar için)
    if (oldPrice != null) {
      for (const it of out) {
        if (it.price_old == null && it.price_new != null && oldPrice > it.price_new) {
          it.price_old = oldPrice;
          const pct = ((oldPrice - it.price_new) / oldPrice) * 100;
          it.discount_pct = Math.round(pct * 10) / 10;
        }
      }
    }

    return out;
  });
}

// ===== Playwright helpers =====
async function launchBrowser() {
  return await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}
const DEFAULT_HEADERS = {
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8,tr;q=0.7,fr;q=0.6',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function newContext(browser) {
  const ctx = await browser.newContext({
    extraHTTPHeaders: DEFAULT_HEADERS,
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 900 }
  });
  // webdriver fingerprint azaltma
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return ctx;
}

async function autoConsent(page) {
  const selectors = [
    'button:has-text("Accept")','button:has-text("I agree")','button:has-text("Allow all")',
    'button:has-text("Akzeptieren")','button:has-text("Alle akzeptieren")','button:has-text("Zustimmen")',
    'button:has-text("Tout accepter")','button:has-text("Accepter")',
    'button:has-text("Aceptar")','button:has-text("Aceptar todo")',
    'button:has-text("Kabul et")','button:has-text("Tümünü kabul et")',
    'button[aria-label*="accept" i]','button[aria-label*="Akzeptieren" i]'
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click({ timeout: 500 }); await page.waitForTimeout(200); }
    } catch {}
  }
}

async function gotoWithRetry(page, url) {
  let lastErr;
  for (let i=0;i<3;i++){
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await autoConsent(page);
      // kısa scroll + network sakinliği
      await page.waitForTimeout(700);
      await page.evaluate(() => window.scrollBy(0, 1600));
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(800);
    }
  }
  throw lastErr;
}

// ===== Scraping =====
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

async function findProductLinks(page) {
  const broad = await page.$$eval('a', as => {
    const hrefs = [];
    for (const a of as) {
      const href = a.href || a.getAttribute('href') || '';
      if (!href || !/^https?:\/\//i.test(href)) continue;
      const t = href.toLowerCase();
      if (
        t.includes('/product') || t.includes('/produkte') || t.includes('/producto') ||
        t.includes('/produkt') || /\/p\/[a-z0-9]/.test(t) || /\/\d{4,}/.test(t)
      ) {
        hrefs.push(href);
      }
    }
    return Array.from(new Set(hrefs));
  });

  const selectors = [
    'a.product-link','a.product-card','a.ProductCard__link','a.c-product-card__link',
    '.product a[href]','.product-card a[href]','.product-item a[href]','.grid-product a[href]'
  ];
  const matched = new Set(broad);
  for (const sel of selectors) {
    try {
      const links = await page.$$eval(sel, els =>
        Array.from(new Set(
          els.map(e => e.href || e.getAttribute('href') || '').filter(h => /^https?:\/\//i.test(h))
        ))
      );
      for (const l of links) matched.add(l);
    } catch {}
  }
  return Array.from(matched);
}

async function scrapeDetail(context, href, host, country) {
  const p = await context.newPage();
  try {
    await gotoWithRetry(p, href);
    const html = await p.content();
    const finalUrl = p.url();

    let items = [
      ...extractFromLdJson(html, finalUrl, host, country),
      ...extractFromOg(html, finalUrl, host, country)
    ];

    // Fiyat hâlâ boşsa DOM fallback
    const needDom = !items.some(it => it.price_new != null);
    if (needDom) {
      const domItems = await extractFromDom(p, host, country);
      for (const d of domItems) {
        items.push({
          source: d.source,
          name: trim(d.name, 180),
          brand: d.brand || null,
          price_new: d.price_new ?? null,
          price_old: d.price_old ?? null,
          discount_pct: d.discount_pct ?? null,
          currency: d.currency ?? null,
          availability: d.availability ?? null,
          url: d.url,
          image: d.image || null,
          store: host,
          country
        });
      }
    }
    return { ok: true, url: href, finalUrl, items: dedupe(items) };
  } catch (err) {
    return { ok: false, url: href, error: String(err?.message || err) };
  } finally {
    await p.close().catch(()=>{});
  }
}

async function scrapeUrl(url) {
  const startedAt = new Date().toISOString();
  const browser = await launchBrowser();
  const context = await newContext(browser);

  try {
    const page = await context.newPage();
    await gotoWithRetry(page, url);

    const listHtml  = await page.content();
    const listUrl   = page.url();
    const host      = new URL(listUrl).host;
    const country   = guessCountryFromHost(host) || 'UNK';

    let items = dedupe([
      ...extractFromLdJson(listHtml, listUrl, host, country),
      ...extractFromOg(listHtml, listUrl, host, country)
    ]);

    // Ürün linkleri → ilk N detay
    let productLinks = await findProductLinks(page);
    productLinks = productLinks.slice(0, DETAIL_LIMIT);

    const lim = pLimit(Math.min(DETAIL_LIMIT, 4));
    const detailResults = await Promise.all(
      productLinks.map(href => lim(() => scrapeDetail(context, href, host, country)))
    );
    for (const r of detailResults) {
      if (r.ok && r.items?.length) items.push(...r.items);
    }

    // Para birimi fallback (ülkeye göre)
    const fallbackCurrency = defaultCurrencyForCountry(country);
    items = items.map(it => ({
      ...it,
      currency: it.currency || fallbackCurrency || it.currency
    }));

    // Temizlik + indirim yüzdesi
    items = dedupe(items)
      .filter(it => it.name && it.url && it.price_new != null)
      .map(it => ({ ...it, discount_pct: computeDiscount(it.price_new, it.price_old) }))
      .slice(0, 60);

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
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

// ===== Main =====
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
