// URL secreta para el cron externo (cron-job.org o similar):
//   /api/check?key=CHIVATO_KEY             -> avisa solo si algo baja del objetivo
//   /api/check?key=CHIVATO_KEY&resumen=1   -> además avisa "no hay precio objetivo"
// Usa resumen=1 en UNA sola llamada al día.
import settings from '../../config.json' with { type: 'json' };
import { buildReport, sendTelegram } from '../../index.js';

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const key = process.env.CHIVATO_KEY;
  if (!key || params.get('key') !== key) return new Response('Not found', { status: 404 });

  const report = await buildReport(settings, { summary: params.get('resumen') === '1' });
  if (report) await sendTelegram(report);
  return new Response(report ? 'enviado' : 'nada que avisar');
};

export const config = { path: '/api/check' };
