// Tests sin red: se sustituye fetch por páginas HTML de ejemplo.
// Ejecutar: pnpm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePrice, checkProduct, buildReport } from '../index.js';

const PAGES = {
  'https://jsonld.test/plata': `<script type="application/ld+json">
    {"@type":"Product","offers":{"price":"369.90","availability":"https://schema.org/InStock"}}</script>`,
  'https://jsonld.test/azul': `<script type="application/ld+json">
    {"@graph":[{"@type":"Product","offers":[{"price":"399,00","availability":"https://schema.org/InStock"}]}]}</script>`,
  'https://jsonld.test/rosa': `<script type="application/ld+json">
    {"@type":"Product","offers":{"price":"300","availability":"https://schema.org/OutOfStock"}}</script>`,
  'https://meta.test/x': `<meta itemprop="price" content="1.049,00">`,
  'https://amazon.test/dp': `<div id="corePrice_feature_div"><span class="a-offscreen">49,99 €</span></div>`,
  'https://captcha.test/x': `<form action="/errors/validateCaptcha"></form>`,
  'https://vacia.test/x': `<html><body>sin precio</body></html>`,
};

beforeEach(() => {
  globalThis.fetch = async (url) => {
    const html = PAGES[url];
    return html == null
      ? new Response('no', { status: 404 })
      : new Response(html, { status: 200 });
  };
});

test('parsePrice entiende formatos europeos e ingleses', () => {
  assert.equal(parsePrice('431,77 €'), 431.77);
  assert.equal(parsePrice('1.049,00'), 1049);
  assert.equal(parsePrice('1.049'), 1049);
  assert.equal(parsePrice('1,049.50'), 1049.5);
  assert.equal(parsePrice('449.00'), 449);
  assert.equal(parsePrice(449), 449);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('gratis'), null);
  assert.equal(parsePrice(0), null);
});

test('checkProduct: JSON-LD, meta, selectores, sin stock y errores', async () => {
  const { offers, errors } = await checkProduct({
    name: 'X',
    targetPrice: 400,
    stores: [
      { name: 'A', colors: { Plata: 'https://jsonld.test/plata', Azul: 'https://jsonld.test/azul', Rosa: 'https://jsonld.test/rosa' } },
      { name: 'B', colors: { Negro: 'https://meta.test/x' } },
      { name: 'Amazon', selectors: ['#corePrice_feature_div .a-offscreen'], colors: { Blanco: 'https://amazon.test/dp' } },
      { name: 'Bloqueada', colors: { X: 'https://captcha.test/x' } },
      { name: 'Vacía', colors: { X: 'https://vacia.test/x' } },
      { name: 'Caída', colors: { X: 'https://caida.test/x' } },
    ],
  });

  // Rosa está sin stock -> no aparece. Ordenado de barato a caro.
  assert.deepEqual(
    offers.map((o) => [o.store.name, o.color, o.price]),
    [['Amazon', 'Blanco', 49.99], ['A', 'Plata', 369.9], ['A', 'Azul', 399], ['B', 'Negro', 1049]]
  );
  assert.deepEqual(Object.fromEntries(errors), {
    Bloqueada: 'bloqueado (captcha / anti-bot)',
    'Vacía': 'no se encontró el precio en la página',
    'Caída': 'HTTP 404',
  });
});

test('buildReport avisa solo si algo baja del objetivo', async () => {
  const config = {
    products: [{ name: 'iPad', targetPrice: 380, stores: [{ name: 'A', colors: { Plata: 'https://jsonld.test/plata', Azul: 'https://jsonld.test/azul' } }] }],
  };
  const report = await buildReport(config, { summary: false });
  assert.match(report, /📉/);
  assert.match(report, /Plata/);
  assert.doesNotMatch(report, /Azul/); // 399 > 380

  config.products[0].targetPrice = 100;
  assert.equal(await buildReport(config, { summary: false }), null);
  assert.match(await buildReport(config, { summary: true }), /😴.*no hay precio objetivo/);
});

test('config.json es válido', async () => {
  const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  assert.ok(config.products.length > 0);
  for (const p of config.products) {
    assert.equal(typeof p.name, 'string', 'producto sin nombre');
    assert.ok(p.targetPrice > 0, `${p.name}: targetPrice inválido`);
    assert.ok(p.stores.length > 0, `${p.name}: sin tiendas`);
    for (const s of p.stores) {
      assert.ok(Object.keys(s.colors).length > 0, `${p.name} / ${s.name}: sin colores`);
      for (const url of Object.values(s.colors)) new URL(url); // lanza si la URL está mal
    }
  }
});
