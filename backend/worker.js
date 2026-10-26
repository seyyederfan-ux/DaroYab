/**
 * DaroYab Backend — Cloudflare Worker
 * ------------------------------------
 * GET /api/medicines?q={query}&category={cat}
 *  - Fetches live prices from irc.fda.gov.ir (TTAC/NFI public search endpoint)
 *  - Normalizes into the frontend MEDICINES schema (Rial → Toman ÷10)
 *  - Edge-cached 10 min; CORS: *
 * GET /api/health
 */

const FDA_SEARCH_URL = 'https://irc.fda.gov.ir/Home/DrugSearch';
const FDA_API_URL = 'https://irc.fda.gov.ir/api/Drug/SearchDrug';
const CACHE_TTL = 600; // seconds

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const CATEGORY_KEYWORDS = {
  antibiotic: ['آزیترومایسین', 'آموکسی', 'سفت', 'سفال', 'سیپروفلوکساسین', 'azi', 'amo', 'cef', 'cipro'],
  analgesic: ['استامینوفن', 'ژلوفن', 'ایبوپروفن', 'دیکلوفناک', 'ناپروکسن', 'ترامادول', 'acet', 'ibu', 'diclo', 'tram'],
  cardio: ['لوزارتان', 'آتورواستاتین', 'آملودیپین', 'کاپتوپریل', 'متوپرولول', 'losar', 'ator', 'amlo', 'capto'],
  gastro: ['متفورمین', 'امپرازول', 'پنتوپرازول', 'رانیتیدین', 'متوکلوپرامید', 'met', 'ome', 'pantop'],
  supplement: ['ویتامین', 'd3', 'مولتی', 'کلسیم', 'آهن', 'fero', 'vit', 'cal'],
};

// ---------- helpers ----------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/** Rials → Tomans. TTAC prices are always in Rial. */
function rialToToman(rial) {
  const n = parseFloat(String(rial).replace(/[^\d.]/g, ''));
  if (!isFinite(n)) return 0;
  return Math.round(n / 10);
}

function guessCategory(faName = '', enName = '') {
  const fa = faName.toLowerCase();
  const en = enName.toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some((k) => fa.includes(k) || en.includes(k))) return cat;
  }
  return 'analgesic'; // safe default bucket
}

function guessForm(faName = '', formCode = '') {
  const f = faName || '';
  if (/قوطی|شربت|سوسپانسیون|قطره|شیشه/.test(f)) return { form: 'syrup', formLabel: 'شربت/سوسپانسیون خوراکی' };
  if (/ویال|آمپول|تزریقی|پودر/.test(f)) return { form: 'ampoule', formLabel: 'ویال/آمپول تزریقی' };
  if (/کپسول|ژل/.test(f)) return { form: 'capsule', formLabel: 'کپسول خوراکی' };
  return { form: 'tablet', formLabel: 'قرص خوراکی' };
}

function packDesc(faName = '') {
  return faName || 'جعبه کامل';
}
function unitDesc(form) {
  if (form === 'syrup') return 'هر شیشه کامل';
  if (form === 'ampoule') return 'هر عدد ویال';
  return 'هر عدد';
}

/** Rx detection: insulin, cardiac, antibiotic & injectables are Rx-only in Iran. */
function isRxRequired(faName = '', enName = '') {
  const t = (faName + ' ' + enName).toLowerCase();
  return !(/استامینوفن|acetaminophen|ژلوفن|ibuprofen|ستیریزین|cetirizine|دیفن|diphen|ویتامین|vitamin|lozenges|قرص جوشان/).test(t);
}

function normalizeToSchema(raw, idx) {
  // TTAC search returns records like:
  // { Cn: Persian name, En: english name, Manufacture: company, Gtin: IRC/barcode, Price: rial, ... }
  const faName = raw.Cn || raw.FaName || raw.name || raw.drugName || '';
  const enName = raw.En || raw.EnName || raw.engName || raw.englishName || '';
  const ircCode = String(raw.Gtin || raw.IRC || raw.ircCode || raw.barcode || '').trim() || '0000000000000000';
  const packPriceRial = parseFloat(raw.Price ?? raw.price ?? raw.ConsumerPrice ?? raw.TomanPrice ?? 0);
  const { form, formLabel } = guessForm(faName, raw.Form);
  const packPrice = rialToToman(packPriceRial);

  // unit price: pack count if available, else price == unit
  const packCount = parseInt(raw.PackageCount || raw.packCount || raw.NumInPack || 0, 10);
  const unitPrice = packCount > 0 ? Math.round(packPrice / packCount) : packPrice;

  const rxRequired = isRxRequired(faName, enName);
  const insuranceRate = rxRequired ? 0.7 : 0.0;

  return {
    id: idx + 1,
    faName,
    enName: enName || faName,
    category: guessCategory(faName, enName),
    form,
    formLabel,
    manufacturer: raw.Manufacture || raw.manufacturer || raw.Company || 'نامشخص',
    packPrice,
    unitPrice,
    packDesc: packDesc(faName),
    unitDesc: unitDesc(form),
    insuranceRate,
    rxRequired,
    ircCode,
    priceTrend: 'stable',
    trendText: 'بدون تغییر نرخ',
  };
}

/** Fetch + scrape the FDA/TTAC endpoint. Multiple strategies with fallbacks. */
async function scrapeFda(query) {
  const strategies = [
    // 1) JSON API (preferred)
    {
      url: `${FDA_API_URL}?term=${encodeURIComponent(query)}&pageSize=50&pageIndex=0`,
      headers: { Accept: 'application/json' },
      parse: async (res) => {
        const d = await res.json().catch(() => null);
        const rows = Array.isArray(d) ? d : (d?.Data || d?.data || d?.rows || d?.Rows || []);
        return rows;
      },
    },
    // 2) MVC search POST-style GET (HTML scrape fallback)
    {
      url: `${FDA_SEARCH_URL}?searchTerm=${encodeURIComponent(query)}`,
      headers: { Accept: 'text/html' },
      parse: async (res) => {
        const html = await res.text();
        // crude row extraction from the results table
        const rows = [];
        const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let m;
        while ((m = trRe.exec(html)) !== null) {
          const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((t) =>
            t[1].replace(/<[^>]+>/g, '').trim()
          );
          if (tds.length >= 4) {
            rows.push({ Cn: tds[0], En: tds[1], Manufacture: tds[2], Price: tds[3], Gtin: tds[4] || '' });
          }
        }
        return rows;
      },
    },
  ];

  for (const strat of strategies) {
    try {
      const res = await fetch(strat.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
          ...strat.headers,
        },
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const rows = await strat.parse(res);
      if (Array.isArray(rows) && rows.length > 0) return rows;
    } catch {
      /* try next strategy */
    }
  }
  return [];
}

// ---------- worker entry ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'daroyab-api', time: new Date().toISOString() });
    }

    if (url.pathname !== '/api/medicines') {
      return json({ error: 'Not found. Use /api/medicines?q=&category=' }, 404);
    }

    const q = (url.searchParams.get('q') || '').trim();
    const category = (url.searchParams.get('category') || 'all').trim().toLowerCase();

    const cacheKey = new Request(`https://cache.daroyab.internal/medicines?q=${encodeURIComponent(q)}&cat=${category}`, request);
    const cache = caches.default;

    let cached = await cache.match(cacheKey);
    if (cached) return cached;

    const rawRows = await scrapeFda(q);
    let medicines = rawRows.map(normalizeToSchema).filter((m) => m.faName && m.packPrice > 0);

    if (category && category !== 'all') {
      medicines = medicines.filter((m) => m.category === category);
    }

    // de-duplicate by ircCode
    const seen = new Set();
    medicines = medicines.filter((m) => {
      if (seen.has(m.ircCode)) return false;
      seen.add(m.ircCode);
      return true;
    });

    const body = json(
      { ok: true, source: rawRows.length ? 'live' : 'empty', count: medicines.length, medicines },
      200,
      { 'Cache-Control': `public, max-age=${CACHE_TTL}` }
    );

    if (medicines.length) ctx.waitUntil(cache.put(cacheKey, body.clone()));
    return body;
  },
};
