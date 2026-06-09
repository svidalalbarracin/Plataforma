require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { obtenerNotificacionesPJN }    = require('./scrapers/pjn');
const { obtenerNotificacionesSICNEA } = require('./scrapers/sicnea');

const INTERVALO_MIN = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

async function ejecutarPJN() {
  try {
    await obtenerNotificacionesPJN();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/pjn] Error:`, err.message);
  }
}

async function ejecutarSICNEA() {
  // Solo corre los sábados (getDay() === 6)
  if (new Date().getDay() !== 6) return;
  console.log('[causas-scheduler] Sábado — ejecutando SICNEA...');
  try {
    await obtenerNotificacionesSICNEA();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/sicnea] Error:`, err.message);
  }
}

console.log(`[causas-scheduler] Iniciado. Intervalo PJN: cada ${INTERVALO_MIN} min. SICNEA: solo sábados al iniciar.`);

// Al iniciar: PJN siempre + SICNEA solo si es sábado
ejecutarPJN();
ejecutarSICNEA();

// PJN cada INTERVALO_MIN minutos
setInterval(ejecutarPJN, INTERVALO_MIN * 60 * 1000);
