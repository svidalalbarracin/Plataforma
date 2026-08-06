/**
 * Sincronización con el repo privado de backup de avisos
 * (github.com/svidalalbarracin/plataforma-avisos-backup).
 *
 * Empuja un snapshot mínimo (pendientes no completados + notificaciones sin
 * leer, sin datos de clientes/facturación/documentos) para que un workflow
 * de GitHub Actions pueda mandar el mail de aviso si la PC del estudio
 * estuvo apagada a la hora que correspondía. Ver CLAUDE.md sección Mails.
 *
 * El snapshot lleva TODOS los pendientes no completados (no solo los de
 * hoy) para que el chequeo remoto pueda decidir por sí mismo qué está
 * vencido según su propia fecha, aunque el snapshot tenga unos días de
 * antigüedad por la PC haber estado apagada.
 *
 * @module causas/sync-backup
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env'), quiet: true });
const https = require('https');
const db = require('../../../core/database');

const REPO = 'svidalalbarracin/plataforma-avisos-backup';
const RUTA_ARCHIVO = 'snapshot.json';

function apiRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${RUTA_ARCHIVO}`,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.SYNC_REPO_TOKEN}`,
        'User-Agent': 'plataforma-scheduler',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function leerSnapshotRemoto() {
  const { status, body } = await apiRequest('GET');
  if (status !== 200) throw new Error(`No se pudo leer snapshot remoto (status ${status}): ${JSON.stringify(body)}`);
  const contenido = Buffer.from(body.content, 'base64').toString('utf8');
  return { sha: body.sha, data: JSON.parse(contenido) };
}

function armarSnapshotLocal(envios) {
  const pendientes = db.prepare(`
    SELECT descripcion, fecha_limite, fecha_aviso, numero_expediente, caratula
    FROM pendientes WHERE completado = 0
  `).all();

  const pjn = db.prepare(`
    SELECT numero, numero_expediente, caratula, autor, fecha_envio
    FROM notificaciones_pjn WHERE leida = 0
  `).all();

  const tad = db.prepare(`
    SELECT fecha, nombre, numero_tramite, mensaje
    FROM notificaciones_tad WHERE leida = 0
  `).all();

  const sicnea = db.prepare(`
    SELECT numero, razon_social, aduana, motivo, fecha_alta
    FROM notificaciones_sicnea WHERE leida = 0
  `).all();

  return {
    actualizado_at: new Date().toISOString(),
    pendientes,
    notificaciones: { pjn, tad, sicnea },
    envios,
  };
}

function ultimoEnvioLocal(key) {
  return db.prepare('SELECT value FROM scraper_meta WHERE key = ?').get(key)?.value ?? null;
}

function marcarEnvioLocal(key, fecha) {
  db.prepare('INSERT OR REPLACE INTO scraper_meta (key, value) VALUES (?, ?)').run(key, fecha);
}

/**
 * Empuja el snapshot actual al repo de backup y devuelve si el aviso de
 * pendientes/notificaciones de HOY ya salió por cualquiera de los dos
 * lados (local o el workflow remoto) — para que el scheduler no lo
 * duplique, y para que quede asentado localmente si lo mandó el remoto.
 *
 * Si SYNC_REPO_TOKEN no está configurado, no hace nada (feature opcional).
 *
 * @param {string} hoy - Fecha de HOY en horario argentino ('YYYY-MM-DD'),
 *   calculada por el caller (scheduler.js/fechaHoraArg) — se recibe en vez
 *   de recalcularla acá para no arriesgar un desfasaje de un día cerca de
 *   la medianoche entre el cálculo en UTC y el de horario argentino.
 * @returns {Promise<{ pendientesYaEnviado: boolean, notificacionesYaEnviado: boolean } | null>}
 */
async function sincronizarBackup(hoy) {
  if (!process.env.SYNC_REPO_TOKEN) return null;

  const remoto = await leerSnapshotRemoto();
  const remotoEnvios = remoto.data.envios || {};

  const localPend  = ultimoEnvioLocal('pendientes_ultimo_envio');
  const localNotif = ultimoEnvioLocal('notificaciones_ultimo_envio');

  const mergedPend = (localPend === hoy || remotoEnvios.pendientes_ultimo_envio === hoy)
    ? hoy
    : (remotoEnvios.pendientes_ultimo_envio || localPend || null);
  const mergedNotif = (localNotif === hoy || remotoEnvios.notificaciones_ultimo_envio === hoy)
    ? hoy
    : (remotoEnvios.notificaciones_ultimo_envio || localNotif || null);

  // Si el remoto ya mandó hoy y acá todavía no lo sabíamos, dejarlo asentado.
  if (mergedPend === hoy && localPend !== hoy)   marcarEnvioLocal('pendientes_ultimo_envio', hoy);
  if (mergedNotif === hoy && localNotif !== hoy) marcarEnvioLocal('notificaciones_ultimo_envio', hoy);

  const snapshot = armarSnapshotLocal({
    pendientes_ultimo_envio: mergedPend,
    notificaciones_ultimo_envio: mergedNotif,
  });

  const contenidoB64 = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n').toString('base64');
  const put = await apiRequest('PUT', {
    message: `sync: actualizar snapshot ${new Date().toISOString()}`,
    content: contenidoB64,
    sha: remoto.sha,
  });
  if (put.status !== 200) {
    throw new Error(`No se pudo actualizar snapshot remoto (status ${put.status}): ${JSON.stringify(put.body)}`);
  }

  return {
    pendientesYaEnviado:     mergedPend === hoy,
    notificacionesYaEnviado: mergedNotif === hoy,
  };
}

module.exports = { sincronizarBackup };
