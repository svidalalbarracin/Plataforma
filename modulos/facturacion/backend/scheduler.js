require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const cron = require('node-cron');
const { notificarResumenDiario } = require('./notificaciones');

const HORA = process.env.NOTIF_HORA || '9';
const expr = `0 ${HORA} * * *`;

console.log(`[scheduler] Iniciado. Notificaciones programadas para las ${HORA}:00 AM (America/Argentina/Buenos_Aires).`);
console.log(`[scheduler] Expresión cron: ${expr}`);

cron.schedule(expr, async () => {
  console.log(`[${new Date().toISOString()}] Ejecutando chequeo de notificaciones...`);
  try {
    await notificarResumenDiario();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en notificaciones:`, err.message);
  }
}, {
  timezone: 'America/Argentina/Buenos_Aires',
});
