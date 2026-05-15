require('dotenv').config();
const Database  = require('better-sqlite3');
const path      = require('path');
const { consultarUltimoComprobante, consultarComprobante } = require('./wsfev1');

const db = new Database(path.join(__dirname, '../../database/facturacion.db'));

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
    ).run(`Cliente CUIT ${cuitStr}`, cuitStr);
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
    return { importadas: 0, omitidas: 0, errores: 0 };
  }

  let importadas = 0, omitidas = 0, errores = 0;

  for (let nro = 1; nro <= ultimo; nro++) {
    const numero = formatNumero(pv, tc, nro);

    if (db.prepare('SELECT id FROM facturas WHERE numero = ?').get(numero)) {
      omitidas++;
      continue;
    }

    try {
      const comp      = await consultarComprobante(pv, tc, nro);
      const fecha     = afipFechaToISO(comp.CbteFch);
      const monto     = Number(comp.ImpNeto)  || 0;
      const iva       = Number(comp.ImpIVA)   || 0;
      const total     = Number(comp.ImpTotal) || 0;
      const clienteId = obtenerOCrearCliente(comp.DocNro);

      db.prepare(`
        INSERT INTO facturas (cliente_id, numero, fecha, monto, iva, monto_total, estado)
        VALUES (?, ?, ?, ?, ?, ?, 'impaga')
      `).run(clienteId, numero, fecha, monto, iva, total);

      console.log(`  [OK] ${numero}  ${fecha}  $${total}`);
      importadas++;
    } catch (e) {
      console.error(`  [ERR] ${formatNumero(pv, tc, nro)}: ${e.message}`);
      errores++;
    }
  }

  console.log(`Resultado: ${importadas} importadas · ${omitidas} ya existían · ${errores} errores`);
  return { importadas, omitidas, errores };
}

async function importarFacturas(puntoVenta, tiposComprobante) {
  const pv = puntoVenta ?? Number(process.env.PUNTO_VENTA);

  // Acepta un número, un array, o la variable de entorno separada por comas
  let tipos;
  if (tiposComprobante != null) {
    tipos = Array.isArray(tiposComprobante) ? tiposComprobante : [tiposComprobante];
  } else {
    const raw = process.env.TIPO_COMPROBANTE || '';
    tipos = raw.split(',').map(s => Number(s.trim())).filter(Boolean);
  }

  if (!pv || tipos.length === 0) {
    throw new Error('Se requieren PUNTO_VENTA y al menos un TIPO_COMPROBANTE en .env');
  }

  console.log(`\nImportando desde ARCA — Punto de venta: ${pv}`);
  console.log(`Tipos de comprobante: ${tipos.join(', ')}\n`);

  const totales = { importadas: 0, omitidas: 0, errores: 0 };

  for (const tc of tipos) {
    const res = await importarPorTipo(pv, tc);
    totales.importadas += res.importadas;
    totales.omitidas   += res.omitidas;
    totales.errores    += res.errores;
  }

  console.log(`\n══ Total ═══════════════════════════════════`);
  console.log(`${totales.importadas} importadas · ${totales.omitidas} ya existían · ${totales.errores} errores\n`);
  return totales;
}

if (require.main === module) {
  importarFacturas().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { importarFacturas };
