// Netlify la lanza sola por el nombre del archivo tras cada deploy correcto.
import settings from '../../config.json' with { type: 'json' };
import { sendTelegram, escapeHtml, formatEur } from '../../index.js';

export const handler = async () => {
  const products = settings.products
    .map((p) => `• ${escapeHtml(p.name)} (objetivo ${formatEur(p.targetPrice)}, ${p.stores.length} tiendas)`)
    .join('\n');
  await sendTelegram(`🕵️ Chivato desplegado ✅ Revisaré precios cada día.\n\n${products}`);
  return { statusCode: 200 };
};
