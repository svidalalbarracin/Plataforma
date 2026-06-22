/**
 * Notificaciones por email del módulo de facturación.
 *
 * Exporta tres funciones:
 * - notificarImportadasVencidas(numeros): avisa si alguna factura recién importada ya superó los DIAS_DEMORA días.
 * - notificarResumenDiario(): resumen de todas las facturas impagas vencidas (corre desde el scheduler).
 * - notificarRecurrentes(): aviso de honorarios mensuales en USD convertidos al TC oficial del día (día 1 de cada mes).
 *
 * @module facturacion/notificaciones
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const nodemailer = require('nodemailer');
const db = require('../../../core/database');
const { obtenerTipoCambio } = require('../../../core/tipoCambio');

/** Días desde la emisión a partir de los cuales una factura se considera vencida. */
const DIAS_DEMORA = Number(process.env.DIAS_DEMORA ?? 30);

/**
 * Calcula cuántos días pasaron desde una fecha ISO hasta hoy.
 * @param {string} fechaStr - Fecha en formato YYYY-MM-DD.
 * @returns {number} Días transcurridos (entero, mínimo 0).
 */
function diasDesde(fechaStr) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fecha = new Date(fechaStr + 'T00:00:00');
  return Math.floor((hoy - fecha) / 86400000);
}

/**
 * Devuelve las facturas impagas que superaron DIAS_DEMORA días.
 * @param {string[]} [soloNumeros] - Si se pasa, filtra solo esos números de factura.
 * @returns {Array<{id, numero, fecha, monto_total, cliente_nombre}>}
 */
function obtenerVencidas(soloNumeros = null) {
  const hoy = new Date().toISOString().slice(0, 10);
  let sql = `
    SELECT f.id, f.numero, f.fecha, f.monto_total, c.nombre AS cliente_nombre
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    WHERE f.estado = 'impaga'
      AND date(f.fecha, '+' || ? || ' days') < date(?)
  `;
  const params = [DIAS_DEMORA, hoy];

  if (soloNumeros?.length) {
    sql += ` AND f.numero IN (${soloNumeros.map(() => '?').join(',')})`;
    params.push(...soloNumeros);
  }

  return db.prepare(sql + ' ORDER BY f.fecha ASC').all(...params);
}

/**
 * Crea un transporter de nodemailer con las credenciales del .env.
 * Variables usadas: MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS.
 * @returns {import('nodemailer').Transporter}
 */
function crearTransporter() {
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.MAIL_PORT) || 587,
    secure: false,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });
}

/**
 * Devuelve un color en hex según los días de demora.
 * - < 60 días: azul (#2563eb)
 * - 60–89 días: naranja (#d97706)
 * - ≥ 90 días: rojo (#dc2626)
 * @param {number} dias
 * @returns {string} Color hexadecimal CSS
 */
function colorPorDias(dias) {
  if (dias >= 90) return '#dc2626';
  if (dias >= 60) return '#d97706';
  return '#2563eb';
}

/**
 * Genera el HTML de la tabla de facturas para el cuerpo del mail.
 * @param {Array<{numero, fecha, monto_total, cliente_nombre}>} facturas
 * @returns {string} HTML de la tabla con filas y fila de total
 */
function renderTabla(facturas) {
  const fmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });

  const filas = facturas.map(f => {
    const dias  = diasDesde(f.fecha);
    const color = colorPorDias(dias);
    return `
    <tr>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0">${f.cliente_nombre}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:13px">${f.numero}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px">${f.fecha}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:center">
        <span style="color:${color};font-weight:600">${dias} días</span>
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:right;font-family:monospace;font-size:13px">${fmt.format(f.monto_total)}</td>
    </tr>`;
  }).join('');

  const total = facturas.reduce((s, f) => s + f.monto_total, 0);

  return `
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:8px 14px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Cliente</th>
          <th style="padding:8px 14px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Nro. Factura</th>
          <th style="padding:8px 14px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Fecha</th>
          <th style="padding:8px 14px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Demora</th>
          <th style="padding:8px 14px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Monto total</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
      <tfoot>
        <tr style="background:#f8fafc">
          <td colspan="4" style="padding:9px 14px;font-weight:600;font-size:13px">Total</td>
          <td style="padding:9px 14px;text-align:right;font-family:monospace;font-size:13px;font-weight:700">${fmt.format(total)}</td>
        </tr>
      </tfoot>
    </table>`;
}

/**
 * Construye el HTML completo del mail con encabezado y tabla de facturas.
 * @param {{ titulo: string, subtitulo: string, descripcion: string, facturas: Array }} opts
 * @returns {string} HTML completo
 */
function buildHtml({ titulo, subtitulo, descripcion, facturas }) {
  const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a">
  <div style="max-width:660px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <h1 style="margin:0 0 6px;font-size:20px;font-weight:700">${titulo}</h1>
    <p style="margin:0 0 4px;color:#64748b;font-size:14px">${hoy} — ${subtitulo}</p>
    <p style="margin:0 0 24px;color:#94a3b8;font-size:13px">${descripcion}</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px">
    ${renderTabla(facturas)}
    <p style="margin-top:36px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px">
      Generado automáticamente · Sistema de Facturación
    </p>
  </div>
</body>
</html>`;
}

/**
 * Envía un mail de notificación de facturas vencidas.
 * Usa MAIL_USER como remitente y MAIL_TO como destinatario.
 * @param {{ asunto: string, titulo: string, subtitulo: string, descripcion: string, facturas: Array }} opts
 */
async function enviarMail({ asunto, titulo, subtitulo, descripcion, facturas }) {
  const transporter = crearTransporter();
  const html = buildHtml({ titulo, subtitulo, descripcion, facturas });
  await transporter.sendMail({
    from: `"Facturación" <${process.env.MAIL_USER}>`,
    to:   process.env.MAIL_TO,
    subject: asunto,
    html,
  });
  console.log(`  Mail enviado (${facturas.length} vencidas) → ${process.env.MAIL_TO}`);
}

/**
 * Notifica si alguna de las facturas recién importadas ya superó los DIAS_DEMORA días sin pago.
 * Se llama desde la ruta de importación inmediatamente después de guardar.
 * @param {string[]} numeros - Números de las facturas recién importadas.
 * @returns {Promise<number>} Cantidad de facturas vencidas notificadas (0 si ninguna).
 */
async function notificarImportadasVencidas(numeros) {
  if (!numeros.length) return 0;
  const vencidas = obtenerVencidas(numeros);
  if (!vencidas.length) return 0;

  console.log(`\n  ${vencidas.length} factura(s) importada(s) ya superaron los ${DIAS_DEMORA} días de demora — enviando mail...`);
  const n = vencidas.length;
  await enviarMail({
    asunto:      `⚠️ ${n} factura${n !== 1 ? 's' : ''} importada${n !== 1 ? 's' : ''} ya vencida${n !== 1 ? 's' : ''} (>${DIAS_DEMORA} días)`,
    titulo:      'Facturas importadas con pago vencido',
    subtitulo:   `${n} factura${n !== 1 ? 's' : ''} en alerta`,
    descripcion: `Las siguientes facturas fueron importadas desde ARCA y ya superaron los ${DIAS_DEMORA} días desde su emisión sin registrar pago.`,
    facturas:    vencidas,
  });
  return n;
}

/**
 * Envía el resumen diario de todas las facturas impagas vencidas.
 * Se llama desde el scheduler a la hora configurada (NOTIF_HORA).
 * @returns {Promise<number>} Cantidad de facturas notificadas (0 si ninguna).
 */
async function notificarResumenDiario() {
  const vencidas = obtenerVencidas();
  if (!vencidas.length) {
    console.log('  Sin facturas vencidas.');
    return 0;
  }
  const n = vencidas.length;
  await enviarMail({
    asunto:      `📋 Resumen: ${n} factura${n !== 1 ? 's' : ''} vencidas sin cobrar`,
    titulo:      'Resumen de cobros pendientes',
    subtitulo:   `${n} factura${n !== 1 ? 's' : ''} en alerta`,
    descripcion: `Facturas con estado <strong>impaga</strong> que superaron los ${DIAS_DEMORA} días desde su emisión.`,
    facturas:    vencidas,
  });
  return n;
}

/**
 * Envía un mail por cliente con el aviso de honorarios mensuales en pesos.
 * El monto en ARS se calcula como honorario_usd × tipo_cambio_oficial del día.
 * El concepto puede contener el placeholder [MES] que se reemplaza con el nombre del mes.
 * Se llama el día 1 de cada mes desde el scheduler.
 * @returns {Promise<number>} Cantidad de mails enviados.
 */
async function notificarRecurrentes() {
  const recurrentes = db.prepare(`
    SELECT r.honorario_usd, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit, c.concepto_facturacion
    FROM facturacion_recurrente r
    JOIN clientes c ON c.id = r.cliente_id
    WHERE r.activo = 1
    ORDER BY c.nombre ASC
  `).all();

  if (!recurrentes.length) {
    console.log('  Sin facturaciones recurrentes activas.');
    return 0;
  }

  const tipoCambio = await obtenerTipoCambio();
  const fmt    = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
  const fmtUSD = n => `USD ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
  const fmtTC  = n => new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
  const hoy    = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const mesAnio    = new Date().toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  const mesAnioCapital = mesAnio.charAt(0).toUpperCase() + mesAnio.slice(1);
  const mesNombre  = new Date().toLocaleDateString('es-AR', { month: 'long' });
  const mesCapital = mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1);

  const transporter = crearTransporter();
  let enviados = 0;

  for (const r of recurrentes) {
    const montoPesos  = Math.round(r.honorario_usd * tipoCambio * 100) / 100;
    const conceptoBase = r.concepto_facturacion
      || `Honorarios profesionales USD ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(r.honorario_usd)} mes de [MES]`;
    const concepto = conceptoBase.replace(/\[MES\]/gi, mesCapital);

    const fila = (label, valor, mono = false) => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;white-space:nowrap">${label}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600${mono ? ';font-family:monospace' : ''}">${valor}</td>
      </tr>`;

    const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a">
  <div style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:700">Facturación mensual</h1>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px">${mesAnioCapital} · ${hoy} · TC oficial: <strong>${fmt.format(tipoCambio)}</strong></p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px">
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <tbody>
        ${fila('Cliente',        r.cliente_nombre)}
        ${fila('CUIT',           r.cliente_cuit, true)}
        ${fila('Concepto',       concepto)}
        ${fila('Honorario',      fmtUSD(r.honorario_usd), true)}
        ${fila('Tipo de cambio', fmt.format(tipoCambio),  true)}
        ${fila('Monto en pesos', fmt.format(montoPesos),  true)}
      </tbody>
    </table>
    <p style="margin-top:32px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px">
      Generado automáticamente · Sistema de Facturación
    </p>
  </div>
</body>
</html>`;

    await transporter.sendMail({
      from:    `"Facturación" <${process.env.MAIL_USER}>`,
      to:      process.env.MAIL_TO,
      subject: `Facturación mensual - ${r.cliente_nombre} - ${mesAnioCapital}`,
      html,
    });

    console.log(`  [mail] ${r.cliente_nombre} · ${fmtUSD(r.honorario_usd)} · TC ${fmtTC(tipoCambio)} · ${fmt.format(montoPesos)}`);
    enviados++;
  }

  console.log(`  Avisos enviados: ${enviados} cliente(s) · TC: ${fmt.format(tipoCambio)}`);
  return enviados;
}

module.exports = { notificarImportadasVencidas, notificarResumenDiario, notificarRecurrentes };
