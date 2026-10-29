// Chivato 🕵️ — bot de precios: revisa tiendas (todos los colores) y avisa por Telegram.
// En producción lo lanza una URL secreta de Netlify (netlify/functions/chivato.mjs).
//
//   node --env-file=.env index.js                 -> revisa y avisa (con resumen)
//   node --env-file=.env index.js --dry-run       -> muestra el mensaje, no lo envía
//   node --env-file=.env index.js --test-telegram -> envía un mensaje de prueba

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

const META_SELECTORS = [
  'meta[itemprop="price"]',
  'meta[property="product:price:amount"]',
  'meta[property="og:price:amount"]',
  '[itemprop="price"]',
];

// ---------- utilidades ----------

export const formatEur = (n) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Acepta "431,77 €", "1.049,00", "449.00", 449...
function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 0 ? raw : null;

  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.'); // formato europeo
  } else if (lastComma !== -1 && lastDot > lastComma) {
    s = s.replace(/,/g, ''); // formato inglés con miles
  } else if (lastComma === -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.049" = mil cuarenta y nueve
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- extracción de precio ----------

function collectProducts(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectProducts(n, out));
  } else if (node && typeof node === 'object') {
    const types = [].concat(node['@type'] ?? []);
    if (types.includes('Product') || types.includes('ProductGroup')) out.push(node);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') collectProducts(value, out);
    }
  }
  return out;
}

function priceFromOffers(offers) {
  for (const offer of [].concat(offers ?? [])) {
    if (!offer) continue;
    const price = parsePrice(
      offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price
    );
    if (price) {
      const available = !String(offer.availability ?? '').includes('OutOfStock');
      return { price, available };
    }
  }
  return null;
}

function fromJsonLd($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      continue;
    }
    for (const product of collectProducts(data)) {
      const result = priceFromOffers(product.offers);
      if (result) return { ...result, method: 'json-ld' };
    }
  }
  return null;
}

function fromSelectors($, selectors, method) {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el.length) continue;
    const price = parsePrice(el.attr('content') ?? el.text());
    if (price) return { price, available: true, method };
  }
  return null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: HEADERS,
    redirect: 'follow',
    // ponytail: corto a propósito, la función de Netlify tiene ~10 s en total.
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (/validateCaptcha|captcha-delivery|cf-chl|Robot Check/i.test(html)) {
    throw new Error('bloqueado (captcha / anti-bot)');
  }
  return html;
}

async function getPrice(url, selectors) {
  const $ = cheerio.load(await fetchHtml(url));
  const result =
    (selectors?.length && fromSelectors($, selectors, 'selector')) ||
    fromJsonLd($) ||
    fromSelectors($, META_SELECTORS, 'meta');
  if (!result) throw new Error('no se encontró el precio en la página');
  return result;
}

// Revisa todos los colores de todas las tiendas en paralelo.
// offers: cada color con stock, del más barato al más caro.
export async function checkProduct(product) {
  const jobs = product.stores.flatMap((store) =>
    Object.entries(store.colors).map(([color, url]) => ({ store, color, url }))
  );
  const results = await Promise.allSettled(
    jobs.map(({ store, url }) => getPrice(url, store.selectors))
  );

  const offers = [];
  const failed = new Map(); // tienda -> último error
  results.forEach((r, i) => {
    const { store, color, url } = jobs[i];
    if (r.status === 'rejected') {
      console.error(`[${store.name} ${color}] ERROR ${r.reason.message}`);
      failed.set(store.name, r.reason.message);
      return;
    }
    const { price, available, method } = r.value;
    console.log(`[${store.name} ${color}] ${formatEur(price)}${available ? '' : ' (sin stock)'} via ${method}`);
    if (available) offers.push({ store, color, url, price });
  });

  offers.sort((a, b) => a.price - b.price);
  // Una tienda solo cuenta como fallo si no sacamos ningún color.
  const errors = [...failed].filter(([name]) => !offers.some((o) => o.store.name === name));
  return { offers, errors };
}

const link = ({ color, url }) => `<a href="${escapeHtml(url)}">${escapeHtml(color)}</a>`;

// Agrupa por tienda: "ShopDutyFree — 406,90 €: Plata · Azul" (cada color es un enlace).
function offerLines(offers) {
  const byStore = Map.groupBy(offers, (o) => o.store.name);
  return [...byStore].map(([name, list]) => {
    const byPrice = Map.groupBy(list, (o) => o.price);
    const prices = [...byPrice].map(([price, l]) => `  ${formatEur(price)}: ${l.map(link).join(' · ')}`);
    return `🏬 <b>${escapeHtml(name)}</b>\n${prices.join('\n')}`;
  });
}

// Devuelve el texto a enviar, o null si no hay que avisar.
// summary = true -> si nada baja del objetivo, avisa igualmente ("no hay precio objetivo").
export async function buildReport(config, { summary }) {
  const parts = [];

  for (const product of config.products) {
    const { offers, errors } = await checkProduct(product);
    const hits = offers.filter((o) => o.price <= product.targetPrice);
    const title = `<b>${escapeHtml(product.name)}</b> (objetivo ${formatEur(product.targetPrice)})`;

    if (hits.length) {
      parts.push(`📉 ${title}\n\n${offerLines(hits).join('\n\n')}`);
    } else if (summary) {
      const cheapest = offers[0]
        ? `\nMás barato ahora:\n${offerLines(offers.filter((o) => o.price === offers[0].price)).join('\n')}`
        : '';
      const failedLine = errors.length
        ? `\n\n⚠️ Sin datos: ${errors.map(([n, e]) => `${escapeHtml(n)} (${escapeHtml(e)})`).join(', ')}`
        : '';
      parts.push(`😴 ${title}: no hay precio objetivo.${cheapest}${failedLine}`);
    }
  }

  return parts.length ? `🕵️ Chivato\n\n${parts.join('\n\n')}` : null;
}

// ---------- Telegram ----------

export async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
  }
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    }
  );
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

// ---------- CLI ----------

async function main() {
  if (process.argv.includes('--test-telegram')) {
    await sendTelegram('🕵️ Chivato conectado. Te avisaré cuando algo baje de precio.');
    console.log('Mensaje de prueba enviado.');
    return;
  }

  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const report = await buildReport(config, { summary: true });
  if (process.argv.includes('--dry-run')) {
    console.log(`\n--- mensaje ---\n${report ?? '(nada que enviar)'}`);
  } else if (report) {
    await sendTelegram(report);
  }
}

// Solo se ejecuta como CLI; Netlify importa las funciones de arriba.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
