// bot.mjs — BeautyDrop deals scraper (Node 20+, ESM, Playwright)
// Odak özellikler:
// - HTTP/2 sorunlarına karşı Chromium --disable-http2 + Firefox fallback
// - SPA/Next/Nuxt listinglerde gelişmiş link çıkarımı (__NEXT_DATA__, __NUXT__, dataLayer)
// - Consent otomasyonu (iframe dahil), auto-scroll + "Load more" + basit sayfalama
// - Locale-aware fiyat ayrıştırma + sanity filtresi (uç/bozuk değerler elenir)
// - Ülke çözümleyici: TLD + .com override + path/language ipuçları
// - Aggregator (Cimri/Akakçe) "two-hop": ürün sayfasındaki dış mağaza linkine gidip gerçek ürün detayını da toplar
// - Çıktılar: data/deals-YYYY-MM-DD.json  ve  data/deals-latest.json

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium, firefox } from 'playwright';
import pLimit from 'p-limit';

// ===== CLI =====
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v === undefined ? true : v];
  })
);
const HEADLESS      = args.headless !== undefined ? args.headless !== 'false' : true;
const MAX_PER_PAGE  = Number(args.maxPerPage || 60);   // Maks. feed URL adedi
const CONCURRENCY   = Number(args.concurrency || 4);   // Aynı anda kaç feed
const DETAIL_LIMIT  = Number(args.detailLimit || 12);  // Listingten açılacak ürün sayısı
const MAX_SCROLLS   = Number(args.maxScrolls || 6);    // Listingte auto-scroll tur sayısı
const TRY_PAGINATE  = args.tryPaginate !== 'false';    // ?page=2.. denensin mi

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

function resolveCountry(url) {
  // TLD + path/dil ipuçları + .com override
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./,'').toLowerCase();
    const pathLow = u.pathname.toLowerCase();
    const tld = host.split('.').pop();

    const tldMap = { de:'DE', tr:'TR', fr:'FR', it:'IT', es:'ES', nl:'NL', be:'BE', at:'AT', ch:'CH',
                     pl:'PL', cz:'CZ', sk:'SK', hu:'HU', ro:'RO', bg:'BG', gr:'GR', pt:'PT',
                     dk:'DK', se:'SE', no:'NO', fi:'FI', ie:'IE', uk:'UK', co:'UK' };

    const hostOverride = {
      'gratis.com': 'TR', 'boyner.com.tr': 'TR', 'sevil.com.tr': 'TR',
      'perfumesclub.com': 'ES', 'parfumdo.com': 'FR',
      'lookfantastic.com': 'UK', 'cultbeauty.co.uk': 'UK', 'beautybay.com': 'UK',
      'boots.com': 'UK', 'spacenk.com': 'UK',
      // Pazar yerleri/aggregator
      'cimri.com': 'TR', 'akakce.com': 'TR',
      'trendyol.com': 'TR', 'hepsiburada.com': 'TR', 'n11.com': 'TR'
    };
    if (hostOverride[host]) return hostOverride[host];

    // Path ipuçları
    if (host.endsWith('primor.eu') && pathLow.includes('/es_es/')) return 'ES';
    if (host.endsWith('kikocosmetics.com') && pathLow.includes('/it-it/')) return 'IT';
    if (host.endsWith('sephora.co.uk') && (pathLow.includes('/gb/en') || pathLow.includes('/en-gb'))) return 'UK';
    if (host.endsWith('gratis.com') && pathLow.includes('/kampanyalar')) return 'TR';

    return tldMap[tld] || 'UNK';
  } catch {
    return 'UNK';
  }
}

function defaultCurrencyForCountry(country) {
  const map = {
    TR:'TRY', DE:'EUR', FR:'EUR', IT:'EUR', ES:'EUR', NL:'EUR', BE:'EUR', AT:'EUR', CH:'CHF',
    PL:'PLN', CZ:'CZK', SK:'EUR', HU:'HUF', RO:'RON', BG:'BGN', GR:'EUR', PT:'EUR',
    DK:'DKK', SE:'SEK', NO:'NOK', FI:'EUR', IE:'EUR', UK:'GBP'
  };
  return map[country] || null;
}

function parseNumberLocalized(input) {
  if (input == null) return null;
  let s = String(input)
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/['’]/g, '')   // CHF vb. için apostrof binlikleri kaldır
    .trim();

  s = s.replace(/[^\d,.\-]/g, '');
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
    else s = s.replace(/,/g, ''); // 1,234.56 → 1234.56
  } else if (s.includes(',')) s = s.replace(',', '.');

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

function isSanePrice(value, currency) {
  if (!Number.isFinite(value) || value <= 0) return false;
  const caps = { EUR: 2000, USD: 2000, GBP: 1800, PLN: 8000, HUF: 300000, RON: 10000, TRY: 200000, CHF: 2200, CZK: 50000, DKK: 15000, SEK: 20000, NOK: 20000 };
  const cap = caps[currency || 'EUR'] || 2000;
  return value <= cap;
}

// ---- feeds parser (satırdaki ilk URL; "Ad | URL" formatı desteklenir) ----
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

// ===== Extractors =====
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

async function extractFromDom(page, host, country) {
  return await page.evaluate(() => {
    function txt(el) { return (el && (el.textContent || '').trim()) || ''; }
    function getNum(s) {
      if (!s) return null;
      let v = s.replace(/&nbsp;/g,' ').replace(/\s+/g,' ').replace(/['’]/g,'').trim();
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

    // 3) Script içi JSON ("price": 123)
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
async function launchBrowser(engine = 'chromium') {
  const common = {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-http2' // HTTP/2 kaynaklı ERR_HTTP2_PROTOCOL_ERROR azaltır
    ]
  };
  if (engine === 'firefox') return await firefox.launch(common);
  return await chromium.launch(common);
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
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return ctx;
}

async function clickConsentIn(pageLike) {
  const selectors = [
    'button:has-text("Accept")','button:has-text("I agree")','button:has-text("Allow all")',
    'button:has-text("Akzeptieren")','button:has-text("Alle akzeptieren")','button:has-text("Zustimmen")',
    'button:has-text("Tout accepter")','button:has-text("Accepter")',
    'button:has-text("Aceptar")','button:has-text("Aceptar todo")',
    'button:has-text("Kabul et")','button:has-text("Tümünü kabul et")',
    'button[aria-label*="accept" i]','button[aria-label*="Akzeptieren" i]',
    '[role="dialog"] button:has-text("Accept")',
    '[id*="consent"] button', '.cookie-accept, .js-accept-all'
  ];
  for (const sel of selectors) {
    try {
      const btn = await pageLike.$(sel);
      if (btn) { await btn.click({ timeout: 1200 }); await pageLike.waitForTimeout(400); }
    } catch {}
  }
}

async function autoConsent(page) {
  await clickConsentIn(page);
  for (const f of page.frames()) {
    try { await clickConsentIn(f); } catch {}
  }
}

async function gotoWithRetry(page, url) {
  let lastErr;
  for (let i=0;i<3;i++){
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await autoConsent(page);
      // SPA render için kısa bekleme + network idle
      await page.waitForTimeout(1000);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(700);
    }
  }
  throw lastErr;
}

async function autoScrollAndLoadMore(page, { maxScrolls = MAX_SCROLLS } = {}) {
  const moreBtns = [
    'button:has-text("Load more")','button:has-text("Mehr")','button:has-text("Mehr anzeigen")',
    'button:has-text("Daha fazla")','button:has-text("Tümünü göster")','button:has-text("Weitere Anzeigen")'
  ];
  let lastHeight = 0;
  for (let i=0;i<maxScrolls;i++){
    try {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(700);
      for (const sel of moreBtns) {
        const btn = await page.$(sel).catch(()=>null);
        if (btn) { await btn.click().catch(()=>{}); await page.waitForTimeout(900); }
      }
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h <= lastHeight) break;
      lastHeight = h;
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});
    } catch {}
  }
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

async function findProductLinksAdvanced(page) {
  const set = new Set();

  // 0) Next: __NEXT_DATA__
  try {
    const nextJson = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (nextJson) {
      const obj = JSON.parse(nextJson);
      (function walk(x){
        if (!x || typeof x !== 'object') return;
        if (x.url && typeof x.url === 'string' && /^https?:\/\//i.test(x.url)) {
          if (/(\/p\/|\/product|\/produkt|\/producto|\/prodotto|\/[a-z]*-p\d+)/i.test(x.url)) set.add(x.url);
        }
        for (const k in x) walk(x[k]);
      })(obj);
    }
  } catch {}

  // 1) Nuxt: __NUXT__
  try {
    const nuxt = await page.evaluate(() => {
      try { return window.__NUXT__ || null; } catch { return null; }
    });
    if (nuxt) {
      (function walk(x){
        if (!x || typeof x !== 'object') return;
        if (x.link && typeof x.link === 'string' && /^https?:\/\//i.test(x.link)) {
          if (/(\/p\/|\/product|\/produkt|\/producto|\/prodotto|\/[a-z]*-p\d+)/i.test(x.link)) set.add(x.link);
        }
        for (const k in x) walk(x[k]);
      })(nuxt);
    }
  } catch {}

  // 2) dataLayer
  try {
    const dl = await page.evaluate(() => Array.isArray(window.dataLayer) ? window.dataLayer : null);
    if (dl) {
      for (const entry of dl) {
        if (entry && typeof entry === 'object') {
          for (const v of Object.values(entry)) {
            if (v && typeof v === 'object' && v.url && /^https?:\/\//i.test(v.url)) {
              if (/(\/p\/|\/product|\/produkt|\/producto|\/prodotto|\/[a-z]*-p\d+)/i.test(v.url)) set.add(v.url);
            }
          }
        }
      }
    }
  } catch {}

  // 3) Domain’e göre kart seçimleri
  const host = (new URL(page.url())).host.replace(/^www\./,'');
  const CARD_SELECTORS = {
    'sephora.de': ['a[href*="/p/"]'],
    'sephora.fr': ['a[href*="/p/"]'],
    'sephora.it': ['a[href*="/p/"]'],
    'sephora.es': ['a[href*="/p/"]'],
    'douglas.de': ['a.ProductTile-link, a[href*="/p/"]'],
    'douglas.it': ['a.ProductTile-link, a[href*="/p/"]'],
    'douglas.es': ['a.ProductTile-link, a[href*="/p/"]'],
    'douglas.be': ['a.ProductTile-link, a[href*="/p/"]'],
    'douglas.nl': ['a.ProductTile-link, a[href*="/p/"]'],
    'douglas.at': ['a.ProductTile-link, a[href*="/p/"]'],
    'douglas.ch': ['a.ProductTile-link, a[href*="/p/"]'],
    'flaconi.de': ['a[href*="/produkt/"], a[h]()*]()]()
