/**
 * Notificaciones por email del módulo de causas.
 *
 * Exporta notificarNotificacionesSinLeer() (todo lo sin revisar, desde 18hs) y
 * notificarAvisoPendientes() (pendientes de hoy o vencidos, desde 8hs). El
 * scheduler decide cuándo llamarlas — ver modulos/causas/backend/scheduler.js.
 *
 * @module causas/notificaciones
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env'), quiet: true });
const nodemailer = require('nodemailer');
const db = require('../../../core/database');

function crearTransporter() {
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.MAIL_PORT) || 587,
    secure: false,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });
}

function seccionPJN(notifs) {
  if (!notifs.length) return '';
  const filas = notifs.map(n => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:12px">${n.numero}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${n.numero_expediente || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${n.caratula || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${n.autor || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;white-space:nowrap">${n.fecha_envio || '—'}</td>
    </tr>`).join('');

  return `
    <h2 style="margin:24px 0 10px;font-size:15px;font-weight:700;color:#1e293b">
      Poder Judicial (PJN) &nbsp;·&nbsp; <span style="color:#2563eb">${notifs.length} nueva(s)</span>
    </h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Número</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Expediente</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Carátula</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Autor</th>
          <th style="padding:7px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Fecha</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;
}

function seccionTAD(notifs) {
  if (!notifs.length) return '';
  const filas = notifs.map(n => {
    const msg = n.mensaje
      ? (n.mensaje.length > 80 ? n.mensaje.slice(0, 80) + '…' : n.mensaje)
      : '—';
    return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;white-space:nowrap">${n.fecha || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${n.nombre || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:12px">${n.numero_tramite}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b">${msg}</td>
    </tr>`;
  }).join('');

  return `
    <h2 style="margin:24px 0 10px;font-size:15px;font-weight:700;color:#1e293b">
      Trámites a Distancia (TAD) &nbsp;·&nbsp; <span style="color:#2563eb">${notifs.length} nueva(s)</span>
    </h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:7px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Fecha</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Trámite</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Nro. trámite</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Mensaje</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;
}

// `titulo` es parámetro porque la tabla notificaciones_sicnea guarda los dos
// sistemas (columna `sistema`): antes el encabezado decía "SICNEA Abogados"
// fijo, así que al reincorporarse el aduanero sus notificaciones aparecían
// listadas bajo el cartel equivocado. Se llama una vez por sistema.
function seccionSICNEA(notifs, titulo) {
  if (!notifs.length) return '';
  const filas = notifs.map(n => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:12px">${n.numero}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${n.razon_social || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${n.aduana || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${n.motivo || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;white-space:nowrap">${n.fecha_alta || '—'}</td>
    </tr>`).join('');

  return `
    <h2 style="margin:24px 0 10px;font-size:15px;font-weight:700;color:#1e293b">
      ${titulo} &nbsp;·&nbsp; <span style="color:#2563eb">${notifs.length} nueva(s)</span>
    </h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Cédula</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Razón social</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Aduana</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Motivo</th>
          <th style="padding:7px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Fecha alta</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;
}

/**
 * Busca pendientes con fecha_aviso hoy o vencida (y no completados) y envía
 * un mail resumen. El scheduler la llama desde las 8hs — incluye vencidos
 * para que un aviso perdido por la plataforma apagada no se pierda del todo.
 *
 * @returns {Promise<number>} Cantidad de pendientes notificados (0 si ninguno).
 */
async function notificarAvisoPendientes() {
  const hoy  = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(
    'SELECT * FROM pendientes WHERE fecha_aviso <= ? AND completado = 0'
  ).all(hoy);

  if (!rows.length) {
    console.log('  [causas/aviso-pendientes] Sin pendientes para avisar');
    return 0;
  }

  console.log(`  [causas/aviso-pendientes] ${rows.length} pendiente(s) — enviando mail...`);

  const fechaLarga = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const filas = rows.map(p => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:12px">${p.numero_expediente || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${p.caratula || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${p.descripcion}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;white-space:nowrap">${p.fecha_limite}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <h1 style="margin:0 0 6px;font-size:20px;font-weight:700">Pendientes</h1>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px">${fechaLarga} &nbsp;·&nbsp; ${rows.length} pendiente(s) de hoy o vencidos</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px">
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Expediente</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Carátula</th>
          <th style="padding:7px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Acción</th>
          <th style="padding:7px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Vencimiento</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="margin-top:36px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px">
      Generado automáticamente &nbsp;·&nbsp; Sistema de Causas
    </p>
  </div>
</body>
</html>`;

  const transporter = crearTransporter();
  await transporter.sendMail({
    from:    `"Causas" <${process.env.MAIL_USER}>`,
    to:      process.env.MAIL_TO,
    subject: `Pendientes (${rows.length}) - ${fechaLarga}`,
    html,
  });
  transporter.close();

  console.log(`  [causas/aviso-pendientes] Enviado → ${process.env.MAIL_TO}`);
  return rows.length;
}

/**
 * Consulta PJN, TAD y SICNEA para notificaciones sin leer, sin importar la
 * fecha, y envía un único mail resumen si hay alguna. Es un recordatorio de
 * lo que falta revisar, no un resumen del día — el scheduler la llama desde
 * las 18hs.
 *
 * @returns {Promise<number>} Total de notificaciones enviadas (0 si ninguna).
 */
async function notificarNotificacionesSinLeer() {
  const pjn    = db.prepare('SELECT * FROM notificaciones_pjn    WHERE leida = 0').all();
  const tad    = db.prepare('SELECT * FROM notificaciones_tad    WHERE leida = 0').all();
  const sicnea = db.prepare('SELECT * FROM notificaciones_sicnea WHERE leida = 0').all();

  // Se reparte por sistema para que cada uno vaya bajo su propio encabezado.
  // El corte es por 'aduanero' y no por 'abogados' a propósito: así cualquier
  // fila con `sistema` inesperado cae en abogados (que es el DEFAULT de la
  // columna, y lo que tienen todas las filas viejas) en vez de desaparecer
  // del mail sin que nadie se entere.
  const sicneaAduanero = sicnea.filter(n => n.sistema === 'aduanero');
  const sicneaAbogados = sicnea.filter(n => n.sistema !== 'aduanero');

  const total = pjn.length + tad.length + sicnea.length;
  if (total === 0) {
    console.log('  [causas/mail-sin-leer] Sin notificaciones pendientes de revisión');
    return 0;
  }

  const partes = [];
  if (pjn.length)    partes.push(`PJN: ${pjn.length}`);
  if (tad.length)    partes.push(`TAD: ${tad.length}`);
  if (sicnea.length) partes.push(`SICNEA: ${sicnea.length}`);

  console.log(`  [causas/mail-sin-leer] ${total} sin leer (${partes.join(', ')}) — enviando...`);

  const hoyStr = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <h1 style="margin:0 0 6px;font-size:20px;font-weight:700">Notificaciones sin leer</h1>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px">${hoyStr} &nbsp;·&nbsp; ${partes.join(' &nbsp;·&nbsp; ')}</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 4px">
    ${seccionPJN(pjn)}
    ${seccionTAD(tad)}
    ${seccionSICNEA(sicneaAbogados, 'SICNEA Abogados')}
    ${seccionSICNEA(sicneaAduanero, 'SICNEA Aduanero')}
    <p style="margin-top:36px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px">
      Generado automáticamente &nbsp;·&nbsp; Sistema de Causas
    </p>
  </div>
</body>
</html>`;

  const transporter = crearTransporter();
  await transporter.sendMail({
    from:    `"Causas" <${process.env.MAIL_USER}>`,
    to:      process.env.MAIL_TO,
    subject: `Notificaciones sin leer (${total}) — ${partes.join(', ')}`,
    html,
  });
  transporter.close();

  console.log(`  [causas/mail-sin-leer] Enviado → ${process.env.MAIL_TO}`);
  return total;
}

module.exports = { notificarNotificacionesSinLeer, notificarAvisoPendientes };
