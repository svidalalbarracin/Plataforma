/**
 * Notificaciones por email del módulo de causas.
 *
 * Exporta notificarNuevasCausas(desde), que consulta las tres tablas de
 * notificaciones (PJN, TAD, SICNEA) para registros insertados a partir de
 * `desde` y envía un mail resumen si hay novedades.
 *
 * @module causas/notificaciones
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const nodemailer = require('nodemailer');
const db = require('../../../core/database');

/**
 * Devuelve la fecha/hora actual en formato SQLite ('YYYY-MM-DD HH:MM:SS', UTC).
 * Usar esta función para generar el timestamp `desde` antes de correr los scrapers,
 * ya que SQLite almacena created_at con datetime('now') en ese mismo formato.
 * @returns {string}
 */
function ahoraSQL() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

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

function seccionSICNEA(notifs) {
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
      SICNEA Abogados &nbsp;·&nbsp; <span style="color:#2563eb">${notifs.length} nueva(s)</span>
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
 * Consulta PJN, TAD y SICNEA para notificaciones insertadas desde `desde`
 * y envía un mail resumen si hay novedades. No lanza errores — los loguea.
 *
 * @param {string} desde - Timestamp en formato SQLite ('YYYY-MM-DD HH:MM:SS', UTC).
 *                         Usar ahoraSQL() antes de correr los scrapers.
 * @returns {Promise<number>} Total de notificaciones nuevas enviadas por mail (0 si ninguna).
 */
async function notificarNuevasCausas(desde) {
  const pjn    = db.prepare('SELECT * FROM notificaciones_pjn    WHERE created_at >= ?').all(desde);
  const tad    = db.prepare('SELECT * FROM notificaciones_tad    WHERE created_at >= ?').all(desde);
  const sicnea = db.prepare('SELECT * FROM notificaciones_sicnea WHERE created_at >= ?').all(desde);

  const total = pjn.length + tad.length + sicnea.length;
  if (total === 0) return 0;

  const partes = [];
  if (pjn.length)    partes.push(`PJN: ${pjn.length}`);
  if (tad.length)    partes.push(`TAD: ${tad.length}`);
  if (sicnea.length) partes.push(`SICNEA: ${sicnea.length}`);

  console.log(`  [causas/mail] ${total} nueva(s) (${partes.join(', ')}) — enviando...`);

  const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <h1 style="margin:0 0 6px;font-size:20px;font-weight:700">Nuevas notificaciones</h1>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px">${hoy} &nbsp;·&nbsp; ${partes.join(' &nbsp;·&nbsp; ')}</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 4px">
    ${seccionPJN(pjn)}
    ${seccionTAD(tad)}
    ${seccionSICNEA(sicnea)}
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
    subject: `Nuevas notificaciones (${total}) — ${partes.join(', ')}`,
    html,
  });

  console.log(`  [causas/mail] Enviado → ${process.env.MAIL_TO}`);
  return total;
}

module.exports = { notificarNuevasCausas, ahoraSQL };
