require('dotenv').config();
const Database  = require('better-sqlite3');
const path      = require('path');
const { consultarUltimoComprobante, consultarComprobante } = require('./wsfev1');

const db = new Database(path.join(__dirname, '../../database/facturacion.db'));

function formatNumero(puntoVenta, numero) {
  return `${String(puntoVenta).padStart(4, '0')}-${String(numero).padStart(8, '0')}`;
}

function afipFechaToISO(fecha) {
  // AFIP devuelve fechas como YYYYMMDD
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

async function importarFacturas(puntoVenta, tipoComprobante) {
  const pv = puntoVenta      ?? Number(process.env.PUNTO_VENTA);
  const tc = tipoComprobante ?? Number(process.env.TIPO_COMPROBANTE);

  if (!pv || !tc) {
    throw new Error('Se requieren PUNTO_VENTA y TIPO_COMPROBANTE (en .env o como parámetros)');
  }

  console.log(`\nConsultando comprobantes — Punto de venta: ${pv}, Tipo: ${tc}`);

  const ultimo = await consultarUltimoComprobante(pv, tc);
  console.log(`Último comprobante en ARCA: ${ultimo}`);

  if (ultimo === 0) {
    console.log('No hay comprobantes para importar.');
    return { importadas: 0, omitidas: 0, errores: 0 };
  }

  let importadas = 0;
  let omitidas   = 0;
  let errores    = 0;

  for (let nro = 1; nro <= ultimo; nro++) {
    const numero = formatNumero(pv, nro);

    const existe = db.prepare('SELECT id FROM facturas WHERE numero = ?').get(numero);
    if (existe) {
      omitidas++;
      continue;
    }

    try {
      const comp = await consultarComprobante(pv, tc, nro);

      const fecha     = afipFechaToISO(comp.CbteFch);
      const monto     = Number(comp.ImpNeto)   || 0;
      const iva       = Number(comp.ImpIVA)    || 0;
      const total     = Number(comp.ImpTotal)  || 0;
      const clienteId = obtenerOCrearCliente(comp.DocNro);

      db.prepare(`
        INSERT INTO facturas (cliente_id, numero, fecha, monto, iva, monto_total, estado)
        VALUES (?, ?, ?, ?, ?, ?, 'impaga')
      `).run(clienteId, numero, fecha, monto, iva, total);

      console.log(`  [OK] ${numero}  ${fecha}  $${total}`);
      importadas++;
    } catch (e) {
      console.error(`  [ERR] ${numero}: ${e.message}`);
      errores++;
    }
  }

  console.log(`\nResultado: ${importadas} importadas · ${omitidas} ya existían · ${errores} errores\n`);
  return { importadas, omitidas, errores };
}

if (require.main === module) {
  importarFacturas().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { importarFacturas };
