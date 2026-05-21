require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const cron = require('node-cron');
const { notificarResumenDiario, notificarRecurrentes } = require('./notificaciones');

const HORA = process.env.NOTIF_HORA || '9';
const expr = `0 ${HORA} * * *`;

console.log(`[scheduler] Iniciado. Notificaciones diarias: ${HORA}:00 AM | Honorarios recurrentes: 8:00 AM día 1 de cada mes.`);

// Resumen diario de facturas impagás vencidas
cron.schedule(expr, async () => {
  console.log(`[${new Date().toISOString()}] Ejecutando chequeo de notificaciones...`);
  try {
    await notificarResumenDiario();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en notificaciones:`, err.message);
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

// Avisos de honorarios recurrentes — día 1 de cada mes a las 8:00 AM
cron.schedule('0 8 1 * *', async () => {
  console.log(`[${new Date().toISOString()}] Enviando avisos de facturación recurrente...`);
  try {
    await notificarRecurrentes();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en avisos recurrentes:`, err.message);
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });
