/**
 * Elimina las facturas importadas desde ARCA que no emitió el titular del .env.
 *
 * Pasó cuando al abogado le agregaron otra representación en Comprobantes en
 * línea (Instituto Argentino de Estudios Aduaneros) y el scraper entró a la
 * equivocada: importó comprobantes de otro emisor y creó clientes que en
 * realidad son receptores de ese otro emisor. Se corre después de cada
 * importación desde el botón "Buscar nuevas facturas" (POST /api/importar).
 *
 * El emisor se detecta leyendo el CUIT de cabecera en el PDF de cada factura
 * (no por número ni por tipo). Se borran:
 * - las facturas cuyo CUIT emisor ≠ CUIT del .env (si alguna tiene pagos, se
 *   saltea y se avisa),
 * - los clientes que quedan sin facturas y que no tienen nada cargado a mano
 *   (contacto, honorarios, recurrente ni causas vinculadas),
 * - los PDFs, que se mueven a la carpeta de backup en vez de borrarse.
 *
 * Solo si hay algo para borrar, antes guarda una copia de la DB en
 * database/backups/<fecha>/.
 *
 * Uso manual:
 *   node modulos/facturacion/backend/arca/limpieza.js            ← solo muestra qué haría
 *   node modulos/facturacion/backend/arca/limpieza.js --aplicar  ← backup + borra
 *
 * @module facturacion/arca/limpieza
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
const path     = require('path');
const fs       = require('fs');
const pdfParse = require('pdf-parse');
const db       = require('../../../../core/database');

const PDF_DIR    = path.join(__dirname, '../../storage/facturas');
const BACKUP_DIR = path.join(__dirname, '../../../../database/backups');

/**
 * Devuelve el CUIT del emisor: el primer renglón del PDF que es solo un número de 11 dígitos
 * (el CUIT del receptor viene pegado al nombre o precedido de "CUIT:").
 * @param {string} pdfPath
 * @returns {Promise<string|null>}
 */
async function cuitEmisor(pdfPath) {
  const { text } = await pdfParse(fs.readFileSync(pdfPath));
  return text.match(/^\s*(\d{11})\s*$/m)?.[1] ?? null;
}

/**
 * Indica si un cliente se puede borrar: sin facturas y sin nada cargado a mano.
 * @param {number} id
 * @returns {boolean}
 */
function clienteBorrable(id) {
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!c) return false;
  const cargadoAMano = c.email || c.telefono || c.anticipo_usd || c.honorario_exito_usd || c.concepto_facturacion;
  return !cargadoAMano
    && !db.prepare('SELECT 1 FROM facturas WHERE cliente_id = ?').get(id)
    && !db.prepare('SELECT 1 FROM facturacion_recurrente WHERE cliente_id = ?').get(id)
    && !db.prepare('SELECT 1 FROM causa_cliente WHERE cliente_id = ?').get(id);
}

/**
 * Busca (y si `aplicar`, borra) las facturas de otro emisor.
 * @param {{ aplicar?: boolean }} [opts]
 * @returns {Promise<{ revisadas: number, borradas: string[], clientesBorrados: number,
 *   conPagos: string[], sinDeterminar: string[], backup: string|null }>}
 *   `borradas` son los números de factura (en modo prueba, los que se borrarían).
 */
async function limpiarFacturasOtroEmisor({ aplicar = false } = {}) {
  const cuit = String(process.env.CUIT || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(cuit)) throw new Error('CUIT del .env vacío o inválido');

  const facturas = db.prepare(`
    SELECT f.id, f.numero, f.fecha, f.tipo, f.monto_total, f.pdf_path, f.cliente_id, c.nombre
    FROM facturas f JOIN clientes c ON c.id = f.cliente_id ORDER BY f.numero
  `).all();

  const ajenas = [], sinDeterminar = [];
  for (const f of facturas) {
    const pdf = f.pdf_path && path.join(PDF_DIR, f.pdf_path);
    if (!pdf || !fs.existsSync(pdf)) { sinDeterminar.push({ ...f, motivo: 'sin PDF' }); continue; }
    const emisor = await cuitEmisor(pdf).catch(() => null);
    if (!emisor)              sinDeterminar.push({ ...f, motivo: 'no se pudo leer el CUIT emisor' });
    else if (emisor !== cuit) ajenas.push({ ...f, emisor, pdf });
  }

  const conPagos = ajenas.filter(f => db.prepare('SELECT 1 FROM pagos WHERE factura_id = ?').get(f.id));
  const aBorrar  = ajenas.filter(f => !conPagos.includes(f));

  for (const f of aBorrar)       console.log(`  [limpieza] ${aplicar ? 'borrar' : 'borraría'} ${f.numero}  ${f.fecha}  ${f.tipo ?? ''}  $${f.monto_total}  ${f.nombre}  (emisor ${f.emisor})`);
  for (const f of conPagos)      console.log(`  [limpieza] SALTEADA, tiene pagos: ${f.numero}  ${f.nombre}`);
  for (const f of sinDeterminar) console.log(`  [limpieza] sin determinar (${f.motivo}): ${f.numero}  ${f.nombre}`);

  const resultado = {
    revisadas:        facturas.length,
    borradas:         aBorrar.map(f => f.numero),
    clientesBorrados: 0,
    conPagos:         conPagos.map(f => f.numero),
    sinDeterminar:    sinDeterminar.map(f => f.numero),
    backup:           null,
  };
  if (!aplicar || aBorrar.length === 0) return resultado;

  const sello  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dirBak = path.join(BACKUP_DIR, sello);
  fs.mkdirSync(path.join(dirBak, 'facturas'), { recursive: true });
  await db.backup(path.join(dirBak, 'facturacion.db'));

  const clientesTocados = [...new Set(aBorrar.map(f => f.cliente_id))];
  let clientesBorrados = [];
  db.transaction(() => {
    const del = db.prepare('DELETE FROM facturas WHERE id = ?');
    for (const f of aBorrar) del.run(f.id);
    clientesBorrados = clientesTocados.filter(clienteBorrable);
    const delC = db.prepare('DELETE FROM clientes WHERE id = ?');
    for (const id of clientesBorrados) delC.run(id);
  })();

  for (const f of aBorrar) fs.renameSync(f.pdf, path.join(dirBak, 'facturas', path.basename(f.pdf)));

  resultado.clientesBorrados = clientesBorrados.length;
  resultado.backup = path.relative(path.join(__dirname, '../../../..'), dirBak);
  console.log(`  [limpieza] Borradas ${aBorrar.length} facturas y ${clientesBorrados.length} clientes de otro emisor. Backup en ${resultado.backup}`);
  return resultado;
}

module.exports = { limpiarFacturasOtroEmisor };

// Ejecución directa: node limpieza.js [--aplicar]
if (require.main === module) {
  const aplicar = process.argv.includes('--aplicar');
  limpiarFacturasOtroEmisor({ aplicar })
    .then(r => {
      console.log(`Facturas revisadas: ${r.revisadas} · de otro emisor: ${r.borradas.length + r.conPagos.length}`);
      if (!aplicar && r.borradas.length) console.log('Modo prueba: no se borró nada. Correr con --aplicar para ejecutar.');
    })
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}
