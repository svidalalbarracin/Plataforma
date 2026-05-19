require('dotenv').config();
const db = require('../database');
const { consultarUltimoComprobante, consultarComprobante } = require('./wsfev1');

// Formato: PPPP-TTT-NNNNNNNN  (punto de venta, tipo, número)
function formatNumero(puntoVenta, tipo, numero) {
  return `${String(puntoVenta).padStart(4, '0')}-${String(tipo).padStart(3, '0')}-${String(numero).padStart(8, '0')}`;
}

function afipFechaToISO(fecha) {
  const s = String(fecha);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function obtenerOCrearCliente(cuit) {
  const cuitStr = String(cuit);
  let cliente = db.prepare('SELECT id FROM clientes WHERE cuit = ?').get(cuitStr);
  if (!cliente) {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO clientes (nombre, cuit) VALUES (?, ?)'
    ).run(cuitStr, cuitStr);
    cliente = { id: lastInsertRowid };
    console.log(`  Nuevo cliente creado para CUIT ${cuitStr}`);
  }
  return cliente.id;
}

async function importarPorTipo(pv, tc) {
  console.log(`\n── Tipo ${tc} ──────────────────────────────`);

  const ultimo = await consultarUltimoComprobante(pv, tc);
  console.log(`Último comprobante en ARCA: ${ultimo}`);

  if (ultimo === 0) {
    console.log('Sin comprobantes para este tipo.');
    return { importadas: 0, errores: 0 };
  }

  // Arrancar desde el siguiente al último ya importado para este PV+tipo
  const prefijo = `${String(pv).padStart(4, '0')}-${String(tc).padStart(3, '0')}-`;
  const row = db.prepare(
    `SELECT MAX(CAST(SUBSTR(numero, 10) AS INTEGER)) AS ultimo FROM facturas WHERE numero LIKE ?`
  ).get(prefijo + '%');
  const desde = (row?.ultimo ?? 0) + 1;

  if (desde > ultimo) {
    console.log(`Ya actualizado (último local: ${desde - 1}, último en ARCA: ${ultimo}).`);
    return { importadas: 0, errores: 0 };
  }

  console.log(`Importando del ${desde} al ${ultimo} (${ultimo - desde + 1} nuevos).`);
  let importadas = 0, errores = 0;

  for (let nro = desde; nro <= ultimo; nro++) {
    const numero = formatNumero(pv, tc, nro);

    try {
      const comp      = await consultarComprobante(pv, tc, nro);
      const fecha     = afipFechaToISO(comp.CbteFch);
      const total     = Number(comp.ImpTotal) || 0;
      const montoNeto = Math.round((total / 1.21) * 100) / 100;
      const iva       = Math.round((total - montoNeto) * 100) / 100;
      const clienteId = obtenerOCrearCliente(comp.DocNro);

      db.prepare(`
        INSERT INTO facturas (cliente_id, numero, fecha, monto, iva, monto_neto, monto_total, estado)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'impaga')
      `).run(clienteId, numero, fecha, montoNeto, iva, montoNeto, total);

      console.log(`  [OK] ${numero}  ${fecha}  $${total}`);
      importadas++;
    } catch (e) {
      console.error(`  [ERR] ${numero}: ${e.message}`);
      errores++;
    }
  }

  console.log(`Resultado: ${importadas} importadas · ${errores} errores`);
  return { importadas, errores };
}

async function importarFacturas(puntosVenta, tiposComprobante) {
  // Acepta número/array o lee PUNTOS_VENTA del .env
  let pvs;
  if (puntosVenta != null) {
    pvs = Array.isArray(puntosVenta) ? puntosVenta : [puntosVenta];
  } else {
    pvs = (process.env.PUNTOS_VENTA || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  }

  let tipos;
  if (tiposComprobante != null) {
    tipos = Array.isArray(tiposComprobante) ? tiposComprobante : [tiposComprobante];
  } else {
    tipos = (process.env.TIPO_COMPROBANTE || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  }

  if (pvs.length === 0 || tipos.length === 0) {
    throw new Error('Se requieren PUNTOS_VENTA y al menos un TIPO_COMPROBANTE en .env');
  }

  console.log(`\nImportando desde ARCA — Puntos de venta: ${pvs.join(', ')}`);
  console.log(`Tipos de comprobante: ${tipos.join(', ')}\n`);

  const totales = { importadas: 0, errores: 0 };

  for (const pv of pvs) {
    for (const tc of tipos) {
      const res = await importarPorTipo(pv, tc);
      totales.importadas += res.importadas;
      totales.errores    += res.errores;
    }
  }

  console.log(`\n══ Total ═══════════════════════════════════`);
  console.log(`${totales.importadas} importadas · ${totales.errores} errores\n`);
  return totales;
}

if (require.main === module) {
  importarFacturas().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { importarFacturas };
