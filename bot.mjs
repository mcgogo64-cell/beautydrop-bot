// bot.mjs — BeautyDrop scraper (serversız, günlük JSON üretir)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import pLimit from 'p-limit';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === CLI options ===
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.split('=');
  return [k.replace(/^--/, ''), v === undefined ? true : v];
}));
const HEADLESS = args.headless !== undefined ? args.headless !== 'false' : true;
const MAX_PER_PAGE = Number(args.maxPerPage || 48);
const CONCURRENCY = Number(args.concurrency || 3);

// === Paths ===
const FEEDS_TXT = path.join(__dirname, 'feeds', 'beautydrop-feeds.txt');
const DATA_DIR  = path.join(__dirname, 'data');

// === Helpers ===
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function todayStr() { return new Date().toISOString().slice(0,10); }
function normSpace(s='') { return s.replace(/\s+/g,' ').trim(); }
function toNumberMaybe(s='') {
  const x = s.replace(/\s/g,'')
             .replace(/[^0-9,.\-]/g,'')
             .replace(',', '.');
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}
function detectCurrency(text='') {
  const t = text.toLowerCase();
  if (/[\u20ba]|try/.test(t)) return 'TRY';
  if (/\u20ac|eur/.test(t)) return 'EUR';
  if (/zł|pln/.test(t)) return 'PLN';
  if (/lei|ron/.test(t)) return 'RON';
  return null;
}
// Çok dilli erkek ürünü dışlama (başlık/açıklama üzerinde)
const MEN_NEG = new RegExp(
  '\\b(' + [
    'erkek','erkekler için','men','male','for men','his','him',
    'herren','für herren','männer',
    'homme','pour homme','masculin',
    'uomo','per uomo','maschile',
    'hombre','para hombre','masculino',
    'heren','mannen','voor heren',
    'męskie','dla mężczyzn',
    'bărbați','pentru bărbați',
    'мужские','для мужчин'
  ].join('|') + ')\\b', 'i'
);

// === 1) FEEDS TXT PARSER ===
function parseFeedsTxt(txt) {
  const lines = txt.split('\n');
  const out = [];
  let country = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const mCountry = line.match(/^\[([A-Z]{2})\]$/);
    if (mCountry) { country = mCountry[1]; continue; }
    const parts = line.split('|');
    if (parts.length >= 2 && country) {
      const name = normSpace(parts[0]);
      const url = normSpace(parts.slice(1).join('|'));
      out.push({ country, name, url });
    }
  }
  return out;
}

// === 2) DOMAIN-BAZLI SELECTOR OVERRIDES ===
const OVERRIDES = [
  { hostRe: /douglas\./, card: ['.product-tile','article','.product','.product-item'], title: ['.product-title','[class*=title]','a[title]','h3'], price: ['[class*=price]','.price','[data-test*=price]'], image: ['img'] },
  { hostRe: /flaconi\./, card: ['article','.product-card','.ProductTile'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] },
  { hostRe: /sephora\./, card: ['article','[data-comp*="ProductCard"]','.product-card'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] },
  { hostRe: /notino\./,  card: ['.product','.product-item','article'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] },
  { hostRe: /rossmann\./, card: ['article','.product','.product-tile'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] },
  { hostRe: /hebe\./,     card: ['article','.product','.product-tile'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] },
  { hostRe: /marionnaud\./,card: ['article','.product','.product-item'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] },
  { hostRe: /parfumdreams\./,card: ['article','.product','.product-item'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] },
  { hostRe: /watsons\./,  card: ['article','.product','.product-item','.product-card'], title: ['h3','[class*="title"]','a[title]'], price: ['[class*=price]','.price'], image: ['img'] }
];
const FALLBACK = { card: ['article','.product','.product-item','.product-card','.tile','.c-product','.sc-product-card','.ProductTile'],
                   title: ['h3','h2','[class*=title]','a[title]','a'],
                   price: ['[class*=price]','.price','[data-test*=price]','[data-testid*=price]','[class*=discount]'],
                   image: ['img'] };

function pickSelectors(hostname) {
  const o = OVERRIDES.find(x => x.hostRe.test(hostname));
  return {
    card: (o?.card || FALLBACK.card),
    title: (o?.title || FALLBACK.title),
    price: (o?.price || FALLBACK.price),
    image: (o?.image || FALLBACK.image),
  };
}

// === 3) SCRAPERS ===
function isLikelyRSS(url) {
  return /\/rss|\.xml(\?|$)/i.test(url);
}

async function fetchRSS(url, meta) {
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`RSS fetch failed ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const j = parser.parse(xml);
  const items = j?.rss?.channel?.item || j?.feed?.entry || [];
  return (items || []).slice(0, MAX_PER_PAGE).map(it => {
    const title = normSpace(it.title?.['#text'] || it.title || '');
    const link = it.link?.href || it.link || it.guid || url;
    const desc = normSpace(it.description || it.summary || '');
    const price = toNumberMaybe(desc);
    const currency = detectCurrency(desc) || null;
    return sanitizeDeal({
      title, productUrl: String(link), description: desc,
      priceCurrent: price, currency, imageUrl: null, ...meta
    });
  });
}

async function fetchHTML(url, meta, browser) {
  const u = new URL(url);
  const sel = pickSelectors(u.hostname);
  const page = await browser.newPage();
  await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const deals = await page.evaluate(({ sel, MAX_PER_PAGE }) => {
    function pick(el, arr) {
      for (const s of arr) {
        const f = el.querySelector(s);
        if (f && f.textContent) return f.textContent;
      }
      return '';
    }
    function pickAttr(el, arr) {
      for (const s of arr) {
        const f = el.querySelector(s);
        if (f && (f.getAttribute('src') || f.getAttribute('data-src'))) {
          return f.getAttribute('src') || f.getAttribute('data-src');
        }
      }
      return null;
    }
    const cards = [];
    const cardNodes = document.querySelectorAll(sel.card.join(','));
    for (const el of cardNodes) {
      const t = pick(el, sel.title);
      const p = pick(el, sel.price);
      let a = el.querySelector('a[href]');
      const href = a ? a.getAttribute('href') : null;
      const img = pickAttr(el, sel.image);
      if (t && href) cards.push({ t, p, href, img });
      if (cards.length >= MAX_PER_PAGE) break;
    }
    return cards;
  }, { sel, MAX_PER_PAGE });

  await page.close();

  return deals.map(d => {
    let productUrl = d.href;
    try { if (productUrl && productUrl.startsWith('/')) productUrl = new URL(url).origin + productUrl; } catch {}
    const currency = detectCurrency(d.p) || detectCurrency(new URL(url).hostname);
    const priceCurrent = toNumberMaybe(d.p);
    return sanitizeDeal({
      title: normSpace(d.t),
      productUrl,
      imageUrl: d.img || null,
      priceCurrent, currency,
      description: null,
      ...meta
    });
  });
}

// Temizleme + erkek ürünlerini eleme
function sanitizeDeal(deal) {
  const title = normSpace(deal.title || '');
  const description = normSpace(deal.description || '');
  const haystack = (title + ' ' + description).toLowerCase();
  if (MEN_NEG.test(haystack)) return null;
  return {
    title,
    productUrl: deal.productUrl,
    imageUrl: deal.imageUrl || null,
    priceCurrent: deal.priceCurrent ?? null,
    currency: deal.currency || null,
    merchant: deal.merchant,
    country: deal.country,
    sourceUrl: deal.sourceUrl,
    scrapedAt: new Date().toISOString()
  };
}

// === 4) MAIN ===
async function main() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(FEEDS_TXT)) {
    console.error(`Feeds file yok: ${FEEDS_TXT}`);
    process.exit(1);
  }
  const feedsTxt = fs.readFileSync(FEEDS_TXT, 'utf-8');
  const entries = parseFeedsTxt(feedsTxt);

  const browser = await chromium.launch({ headless: HEADLESS });
  const limit = pLimit(CONCURRENCY);

  const tasks = entries.map(({ country, name, url }) => limit(async () => {
    const meta = { country, merchant: name, sourceUrl: url };
    try {
      if (isLikelyRSS(url)) {
        return await fetchRSS(url, meta);
      } else {
        return await fetchHTML(url, meta, browser);
      }
    } catch (e) {
      console.warn(`WARN: ${name} (${url}) -> ${e.message}`);
      return [];
    }
  }));

  const resultsNested = await Promise.all(tasks);
  await browser.close();

  let deals = resultsNested.flat().filter(Boolean);

  const seen = new Set();
  deals = deals.filter(d => {
    const key = (d.title || '') + '|' + (d.productUrl || '');
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  const fileDaily  = path.join(DATA_DIR, `deals-${todayStr()}.json`);
  const fileLatest = path.join(DATA_DIR, `deals-latest.json`);
  fs.writeFileSync(fileDaily, JSON.stringify(deals, null, 2), 'utf-8');
  fs.writeFileSync(fileLatest, JSON.stringify(deals, null, 2), 'utf-8');

  console.log(`OK • ${deals.length} kayıt → ${fileDaily}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
