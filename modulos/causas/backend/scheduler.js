/**
 * Scheduler del módulo de causas.
 *
 * Al iniciar la plataforma ejecuta PJN + TAD en paralelo (y SICNEA si es sábado),
 * luego envía un mail con las novedades encontradas. Repite PJN + TAD cada
 * CAUSAS_INTERVALO_MIN minutos. SICNEA solo corre cuando la plataforma arranca
 * un sábado — no tiene intervalo periódico.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { obtenerNotificacionesPJN }    = require('./scrapers/pjn');
const { obtenerNotificacionesTAD }    = require('./scrapers/tad');
const { obtenerNotificacionesSICNEA } = require('./scrapers/sicnea');
const { notificarNotificacionesDiarias, notificarAvisoPendientes } = require('./notificaciones');
const { inferirTodos }                = require('./inferirCliente');

/** Intervalo de polling para PJN y TAD, en minutos (default 30). */
const INTERVALO_MIN = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

/**
 * Corre PJN y TAD en paralelo, luego notifica por mail si hay novedades.
 * Los errores de cada scraper se loguean de forma independiente para que
 * un fallo en uno no impida al otro ni al envío del mail.
 */
async function ejecutarCiclo() {
  await Promise.all([
    obtenerNotificacionesPJN().catch(err =>
      console.error(`[${new Date().toISOString()}] [causas/pjn] Error:`, err.message)
    ),
    obtenerNotificacionesTAD().catch(err =>
      console.error(`[${new Date().toISOString()}] [causas/tad] Error:`, err.message)
    ),
  ]);

  try {
    const r = await inferirTodos();
    if (r.vinculadas > 0) {
      console.log(`[causas-scheduler] Inferencia: ${r.vinculadas} causa(s) vinculada(s) a cliente (${r.nuevosClientes} nuevo(s))`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/inferir] Error:`, err.message);
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
    const r = await inferirTodos();
    if (r.vinculadas > 0) {
      console.log(`[causas-scheduler] Inferencia SICNEA: ${r.vinculadas} causa(s) vinculada(s) a cliente`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/sicnea] Error:`, err.message);
  }
}

/**
 * Programa el aviso diario de pendientes a las 9:00hs.
 * Calcula el delay hasta la próxima 9am y repite cada 24hs.
 */
/**
 * Programa el resumen diario de notificaciones a las 18:00hs.
 */
function programarResumenDiario() {
  const ahora = new Date();
  const proximas18 = new Date(ahora);
  proximas18.setHours(18, 0, 0, 0);
  if (proximas18 <= ahora) proximas18.setDate(proximas18.getDate() + 1);

  const delay = proximas18 - ahora;
  console.log(`[causas-scheduler] Resumen diario: próximo envío a las 18:00 (en ${Math.round(delay / 60000)} min)`);

  setTimeout(() => {
    notificarNotificacionesDiarias().catch(err =>
      console.error(`[${new Date().toISOString()}] [causas/mail-diario] Error:`, err.message)
    );
    setInterval(() => {
      notificarNotificacionesDiarias().catch(err =>
        console.error(`[${new Date().toISOString()}] [causas/mail-diario] Error:`, err.message)
      );
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

function programarAvisoDiario() {
  const ahora = new Date();
  const proximas9 = new Date(ahora);
  proximas9.setHours(9, 0, 0, 0);
  if (proximas9 <= ahora) proximas9.setDate(proximas9.getDate() + 1);

  const delay = proximas9 - ahora;
  console.log(`[causas-scheduler] Aviso pendientes: próximo envío a las 09:00 (en ${Math.round(delay / 60000)} min)`);

  setTimeout(() => {
    notificarAvisoPendientes().catch(err =>
      console.error(`[${new Date().toISOString()}] [causas/aviso-pendientes] Error:`, err.message)
    );
    setInterval(() => {
      notificarAvisoPendientes().catch(err =>
        console.error(`[${new Date().toISOString()}] [causas/aviso-pendientes] Error:`, err.message)
      );
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

console.log(`[causas-scheduler] Iniciado. Intervalo PJN+TAD: cada ${INTERVALO_MIN} min. SICNEA: solo sábados al iniciar.`);

ejecutarCiclo();
ejecutarSICNEA();
programarResumenDiario();
programarAvisoDiario();

setInterval(ejecutarCiclo, INTERVALO_MIN * 60 * 1000);
