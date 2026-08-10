/**
 * Scheduler del módulo de causas.
 *
 * Al iniciar la plataforma ejecuta PJN + TAD en paralelo (y SICNEA si es sábado),
 * luego repite PJN + TAD cada CAUSAS_INTERVALO_MIN minutos. SICNEA solo corre
 * cuando la plataforma arranca un sábado — no tiene intervalo periódico.
 *
 * Los mails de aviso (pendientes desde las 8hs, notificaciones sin leer desde
 * las 18hs) no usan cron: se chequean al final de cada ciclo (al iniciar y
 * cada CAUSAS_INTERVALO_MIN minutos) y se envían la primera vez del día que
 * la hora ya pasó. Como esta plataforma no corre 24/7 (depende de que la
 * computadora esté prendida), un cron con hora fija se pierde el aviso entero
 * si el proceso no está vivo en ese minuto exacto; este chequeo lo manda apenas
 * la plataforma vuelve a arrancar.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env'), quiet: true });
const db = require('../../../core/database');
const { obtenerNotificacionesPJN }    = require('./scrapers/pjn');
const { obtenerNotificacionesTAD }    = require('./scrapers/tad');
const { obtenerNotificacionesSICNEA } = require('./scrapers/sicnea');
const { notificarNotificacionesSinLeer, notificarAvisoPendientes } = require('./notificaciones');
const { inferirTodos, autoCrearCausas, vincularNotificacionesPendientes } = require('./inferirCliente');
const { sincronizarBackup } = require('./sync-backup');

/** Intervalo de polling para PJN y TAD, en minutos (default 30). */
const INTERVALO_MIN = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

/** Fecha ('YYYY-MM-DD') y hora (0-23) actuales en Argentina. */
function fechaHoraArg() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const valor = tipo => partes.find(p => p.type === tipo).value;
  return { fecha: `${valor('year')}-${valor('month')}-${valor('day')}`, hora: parseInt(valor('hour'), 10) % 24 };
}

function ultimoEnvio(key) {
  return db.prepare('SELECT value FROM scraper_meta WHERE key = ?').get(key)?.value ?? null;
}

function marcarEnviado(key, fecha) {
  db.prepare('INSERT OR REPLACE INTO scraper_meta (key, value) VALUES (?, ?)').run(key, fecha);
}

/**
 * Envía el mail de pendientes (desde las 8hs) y el de notificaciones sin leer
 * (desde las 18hs) si todavía no se enviaron hoy. Marca "enviado" solo cuando
 * efectivamente hubo algo que mandar, para que un chequeo en 0 no bloquee un
 * envío más tarde si aparece algo nuevo ese mismo día.
 */
async function chequearMailsHorarios() {
  const { fecha, hora } = fechaHoraArg();

  // Empuja el snapshot al repo de backup y chequea si el aviso de hoy ya
  // salió por ese lado (PC apagada a la hora que correspondía) — evita
  // duplicar el mail cuando la plataforma se prende más tarde ese mismo día.
  // Ver modulos/causas/backend/sync-backup.js.
  let sync = null;
  try {
    sync = await sincronizarBackup(fecha);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/sync-backup] Error:`, err.message);
  }

  if (hora >= 8 && ultimoEnvio('pendientes_ultimo_envio') !== fecha && !sync?.pendientesYaEnviado) {
    try {
      const n = await notificarAvisoPendientes();
      if (n > 0) marcarEnviado('pendientes_ultimo_envio', fecha);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [causas/aviso-pendientes] Error:`, err.message);
    }
  }

  if (hora >= 18 && ultimoEnvio('notificaciones_ultimo_envio') !== fecha && !sync?.notificacionesYaEnviado) {
    try {
      const n = await notificarNotificacionesSinLeer();
      if (n > 0) marcarEnviado('notificaciones_ultimo_envio', fecha);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [causas/mail-sin-leer] Error:`, err.message);
    }
  }
}

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

  await chequearMailsHorarios();
}

/**
 * Corre SICNEA Abogados. Solo dispara automáticamente sábado o domingo:
 * entre semana, obtenerNotificacionesSICNEA() igual puede correr (se
 * adapta solo, filtrando a NOTIFICADA), pero ese disparo es manual vía el
 * botón "Poner SICNEA al día" (routes/notificaciones.js), no por este
 * scheduler.
 *
 * SICNEA II (aduanero) se sacó de la plataforma el 2026-08-10 — va a tener
 * su propio scraper aparte más adelante, no se llama desde acá.
 */
async function ejecutarSICNEA() {
  const dia = new Date().getDay();
  if (dia !== 6 && dia !== 0) return; // corrida automática: solo sábado (6) o domingo (0)
  console.log(`[causas-scheduler] ${dia === 6 ? 'Sábado' : 'Domingo'} — ejecutando SICNEA...`);

  await obtenerNotificacionesSICNEA().catch(err =>
    console.error(`[${new Date().toISOString()}] [causas/sicnea] Error:`, err.message)
  );

  try {
    autoCrearCausas();
    vincularNotificacionesPendientes();
    const r = await inferirTodos();
    if (r.vinculadas > 0) {
      console.log(`[causas-scheduler] Inferencia SICNEA: ${r.vinculadas} causa(s) vinculada(s) a cliente`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [causas/sicnea-inferir] Error:`, err.message);
  }
}

console.log(`[causas-scheduler] Iniciado. Intervalo PJN+TAD: cada ${INTERVALO_MIN} min. SICNEA: solo sábados al iniciar. Pendientes: desde 8hs ARG | Notificaciones sin leer: desde 18hs ARG (chequeo por ciclo).`);

const primerCiclo  = ejecutarCiclo();
const primerSICNEA = ejecutarSICNEA();

setInterval(ejecutarCiclo, INTERVALO_MIN * 60 * 1000);

module.exports = { primerCiclo };
