/**
 * Scheduler del módulo de causas.
 *
 * Al iniciar la plataforma ejecuta PJN + TAD en paralelo (y SICNEA si es sábado),
 * luego repite PJN + TAD cada CAUSAS_INTERVALO_MIN minutos. SICNEA solo corre
 * cuando la plataforma arranca un sábado — no tiene intervalo periódico.
 * Mails de hora fija (resumen diario 18hs, aviso de pendientes 9hs) vía node-cron.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env'), quiet: true });
const cron = require('node-cron');
const { obtenerNotificacionesPJN }    = require('./scrapers/pjn');
const { obtenerNotificacionesTAD }    = require('./scrapers/tad');
const { obtenerNotificacionesSICNEA } = require('./scrapers/sicnea');
const { notificarNotificacionesDiarias, notificarAvisoPendientes } = require('./notificaciones');
const { inferirTodos, autoCrearCausas, vincularNotificacionesPendientes } = require('./inferirCliente');

/** Intervalo de polling para PJN y TAD, en minutos (default 30). */
const INTERVALO_MIN = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

/**
 * Corre PJN y luego TAD en serie, para evitar contención de recursos con
 * los tres Chromium simultáneos (ARCA + PJN + TAD) al iniciar la plataforma.
 * Los errores de cada scraper se loguean de forma independiente para que
 * un fallo en uno no impida al otro ni al envío del mail.
 */
async function ejecutarCiclo() {
  await obtenerNotificacionesPJN().catch(err =>
    console.error(`[${new Date().toISOString()}] [causas/pjn] Error:`, err.message)
  );
  await obtenerNotificacionesTAD().catch(err =>
    console.error(`[${new Date().toISOString()}] [causas/tad] Error:`, err.message)
  );

  try {
    const nuevas = autoCrearCausas();
    const totalNuevas = nuevas.pjn + nuevas.tad + nuevas.sicnea;
    if (totalNuevas > 0) {
      console.log(`[causas-scheduler] Auto-causas: ${totalNuevas} causa(s) creada(s) (PJN:${nuevas.pjn}, TAD:${nuevas.tad}, SICNEA:${nuevas.sicnea})`);
    }
    const vinc = vincularNotificacionesPendientes();
    const totalVinc = vinc.pjn + vinc.tad + vinc.sicnea;
    if (totalVinc > 0) {
      console.log(`[causas-scheduler] Vinculación: ${totalVinc} notificación(es) → causa (PJN:${vinc.pjn}, TAD:${vinc.tad}, SICNEA:${vinc.sicnea})`);
    }
    const r = await inferirTodos();
    if (r.vinculadas > 0) {
      console.log(`[causas-scheduler] Inferencia: ${r.vinculadas} causa(s) vinculada(s) a cliente (${r.nuevosClientes} nuevo(s))`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/inferir] Error:`, err.message);
  }
}

async function ejecutarSICNEA() {
  const dia = new Date().getDay();
  if (dia !== 6 && dia !== 0) return; // solo sábado (6) o domingo (0)
  console.log(`[causas-scheduler] ${dia === 6 ? 'Sábado' : 'Domingo'} — ejecutando SICNEA...`);
  try {
    await obtenerNotificacionesSICNEA();
    autoCrearCausas();
    vincularNotificacionesPendientes();
    const r = await inferirTodos();
    if (r.vinculadas > 0) {
      console.log(`[causas-scheduler] Inferencia SICNEA: ${r.vinculadas} causa(s) vinculada(s) a cliente`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/sicnea] Error:`, err.message);
  }
}

/** Resumen diario de notificaciones: todos los días a las 18:00 ARG. */
cron.schedule('0 18 * * *', async () => {
  try {
    await notificarNotificacionesDiarias();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/mail-diario] Error:`, err.message);
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

/** Aviso de pendientes del día: todos los días a las 9:00 ARG. */
cron.schedule('0 9 * * *', async () => {
  try {
    await notificarAvisoPendientes();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/aviso-pendientes] Error:`, err.message);
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

console.log(`[causas-scheduler] Iniciado. Intervalo PJN+TAD: cada ${INTERVALO_MIN} min. SICNEA: solo sábados al iniciar. Resumen diario: 18:00 ARG | Aviso pendientes: 9:00 ARG.`);

const primerCiclo  = ejecutarCiclo();
const primerSICNEA = ejecutarSICNEA();

setInterval(ejecutarCiclo, INTERVALO_MIN * 60 * 1000);

module.exports = { primerCiclo };
