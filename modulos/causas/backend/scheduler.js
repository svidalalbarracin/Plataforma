/**
 * Scheduler del módulo de causas.
 *
 * Al iniciar la plataforma ejecuta PJN, TAD y (si es sábado) SICNEA.
 * Luego repite PJN y TAD cada CAUSAS_INTERVALO_MIN minutos.
 * SICNEA solo corre cuando la plataforma arranca un sábado — no tiene intervalo periódico.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { obtenerNotificacionesPJN }    = require('./scrapers/pjn');
const { obtenerNotificacionesTAD }    = require('./scrapers/tad');
const { obtenerNotificacionesSICNEA } = require('./scrapers/sicnea');

/** Intervalo de polling para PJN y TAD, en minutos (default 30). */
const INTERVALO_MIN = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

/**
 * Ejecuta el scraper del Poder Judicial (PJN).
 * Los errores se loguean pero no detienen el scheduler.
 */
async function ejecutarPJN() {
  try {
    await obtenerNotificacionesPJN();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/pjn] Error:`, err.message);
  }
}

/**
 * Ejecuta el scraper de Trámites a Distancia (TAD).
 * Los errores se loguean pero no detienen el scheduler.
 */
async function ejecutarTAD() {
  try {
    await obtenerNotificacionesTAD();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/tad] Error:`, err.message);
  }
}

/**
 * Ejecuta el scraper de SICNEA Abogados, pero solo si el día actual es sábado.
 * La práctica del estudio es abrir las notificaciones aduaneras los sábados
 * para que queden registradas el lunes siguiente y así los plazos no corran antes.
 */
async function ejecutarSICNEA() {
  if (new Date().getDay() !== 6) return;
  console.log('[causas-scheduler] Sábado — ejecutando SICNEA...');
  try {
    await obtenerNotificacionesSICNEA();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/sicnea] Error:`, err.message);
  }
}

console.log(`[causas-scheduler] Iniciado. Intervalo PJN+TAD: cada ${INTERVALO_MIN} min. SICNEA: solo sábados al iniciar.`);

// Ejecución inmediata al arrancar la plataforma
ejecutarPJN();
ejecutarTAD();
ejecutarSICNEA();

// Polling periódico
setInterval(ejecutarPJN, INTERVALO_MIN * 60 * 1000);
setInterval(ejecutarTAD, INTERVALO_MIN * 60 * 1000);
