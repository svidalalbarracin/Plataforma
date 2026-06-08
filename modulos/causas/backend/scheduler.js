require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { obtenerNotificacionesPJN } = require('./scrapers/pjn');

const INTERVALO_MIN = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

async function ejecutarScrapers() {
  console.log(`[${new Date().toISOString()}] [causas] Ejecutando scrapers de notificaciones...`);
  try {
    const nuevas = await obtenerNotificacionesPJN();
    console.log(`[${new Date().toISOString()}] [causas] PJN: ${nuevas} notificación(es) nueva(s)`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas] Error PJN:`, err.message);
  }
}

console.log(`[causas-scheduler] Iniciado. Intervalo: cada ${INTERVALO_MIN} min.`);

// Ejecutar al iniciar
ejecutarScrapers();

// Luego cada INTERVALO_MIN minutos
setInterval(ejecutarScrapers, INTERVALO_MIN * 60 * 1000);
