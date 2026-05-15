require('dotenv').config();
const nodemailer  = require('nodemailer');
const Database    = require('better-sqlite3');
const path        = require('path');

const db = new Database(
  path.join(__dirname, '..', 'database', 'facturacion.db'),
  { readonly: true }
);

const UMBRALES = [30, 60, 90];

function diasDesde(fechaStr) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fecha = new Date(fechaStr + 'T00:00:00');
  return Math.floor((hoy - fecha) / 86400000);
}

function crearTransporter() {
  return nodemailer.createTransport({
    host:   process.env.MAIL_HOST || 'smtp.gmail.com',
    port:   Number(process.env.MAIL_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });
}

function renderSeccion(dias, facturas) {
  if (facturas.length === 0) return '';

  const fmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });

  const colores = { 30: '#2563eb', 60: '#d97706', 90: '#dc2626' };
  const color   = colores[dias];

  const filas = facturas.map(f => `
    <tr>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0">${f.cliente_nombre}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:13px">${f.numero}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:right;font-family:monospace;font-size:13px">${fmt.format(f.monto_total)}</td>
    </tr>`).join('');

  return `
    <h3 style="margin:28px 0 10px;font-size:15px;color:${color}">
      ${dias} días sin pago (${facturas.length} factura${facturas.length !== 1 ? 's' : ''})
    </h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:8px 14px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Cliente</th>
          <th style="padding:8px 14px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Nro. Factura</th>
          <th style="padding:8px 14px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Monto total</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;
}

async function enviarNotificaciones() {
  const facturas = db.prepare(`
    SELECT f.*, c.nombre AS cliente_nombre
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    WHERE f.estado = 'impaga'
    ORDER BY f.fecha ASC
  `).all();

  const grupos = {};
  UMBRALES.forEach(u => { grupos[u] = []; });

  for (const f of facturas) {
    const dias = diasDesde(f.fecha);
    if (grupos[dias] !== undefined) grupos[dias].push(f);
  }

  const total = UMBRALES.reduce((s, u) => s + grupos[u].length, 0);

  if (total === 0) {
    console.log(`[${new Date().toISOString()}] Sin facturas en umbrales 30/60/90 días. No se envía mail.`);
    return;
  }

  const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <h1 style="margin:0 0 6px;font-size:20px;font-weight:700">Resumen de cobros pendientes</h1>
    <p style="margin:0 0 4px;color:#64748b;font-size:14px">${hoy} — ${total} factura${total !== 1 ? 's' : ''} en alerta</p>
    <p style="margin:0 0 24px;color:#94a3b8;font-size:13px">Facturas con estado <strong>impaga</strong> que cumplen exactamente 30, 60 o 90 días hoy.</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 4px">
    ${UMBRALES.slice().reverse().map(u => renderSeccion(u, grupos[u])).join('')}
    <p style="margin-top:36px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px">
      Generado automáticamente · Sistema de Facturación
    </p>
  </div>
</body>
</html>`;

  const transporter = crearTransporter();
  await transporter.sendMail({
    from:    `"Facturación" <${process.env.MAIL_USER}>`,
    to:      process.env.MAIL_TO,
    subject: `[Facturación] ${total} factura${total !== 1 ? 's' : ''} en alerta de cobro — ${hoy}`,
    html,
  });

  console.log(`[${new Date().toISOString()}] Mail enviado a ${process.env.MAIL_TO} — ${total} factura(s) en alerta.`);
}

if (require.main === module) {
  enviarNotificaciones().catch(err => {
    console.error('Error al enviar notificaciones:', err.message);
    process.exit(1);
  });
}

module.exports = { enviarNotificaciones };
