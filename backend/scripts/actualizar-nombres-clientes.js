/**
 * Recorre los PDFs en storage/facturas/, extrae el nombre del cliente de cada uno
 * y actualiza el campo `nombre` en la tabla `clientes` cuando el nombre actual
 * es solo el CUIT (es decir, no fue completado en importaciones anteriores).
 *
 * Uso: node backend/scripts/actualizar-nombres-clientes.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const db = require('../database');

const PDF_DIR = path.join(__dirname, '../../storage/facturas');

async function extraerNombreDesedePDF(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);
    const idx = text.indexOf('Apellido y Nombre');
    if (idx === -1) return null;
    const sector = text.slice(idx, idx + 600);

    const m = sector.match(/\d{11}([A-ZÁÉÍÓÚÜÑ][^\n]+)/);
    if (m) return m[1].trim();

    const skip = /^(Apellido y Nombre|Domicilio|CUIT:|Condición|Ingresos|Fecha de |Punto de|Razón Social:|Comp\. Nro)|\d{2}\/\d{2}\/\d{4}|^\d+$/;
    for (const linea of sector.split('\n').map(l => l.trim()).filter(Boolean)) {
      if (!skip.test(linea)) return linea;
    }
  } catch (e) {
    console.warn(`  [warn] ${path.basename(pdfPath)}: ${e.message}`);
  }
  return null;
}

async function main() {
  const pdfs = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf')).sort();
  console.log(`Procesando ${pdfs.length} PDFs en ${PDF_DIR}...\n`);

  let actualizados = 0, sinCambio = 0, sinNombre = 0;

  for (const archivo of pdfs) {
    const numero = archivo.replace('.pdf', '');
    const factura = db.prepare(`
      SELECT f.id, f.cliente_id, c.nombre, c.cuit
      FROM facturas f JOIN clientes c ON c.id = f.cliente_id
      WHERE f.numero = ?
    `).get(numero);

    if (!factura) {
      console.log(`  [skip] ${numero} — factura no encontrada en DB`);
      continue;
    }

    const nombre = await extraerNombreDesedePDF(path.join(PDF_DIR, archivo));

    if (!nombre) {
      console.log(`  [?]    ${numero} — no se pudo extraer nombre`);
      sinNombre++;
      continue;
    }

    if (factura.nombre !== factura.cuit && factura.nombre === nombre) {
      sinCambio++;
      continue;
    }

    if (factura.nombre === factura.cuit || factura.nombre !== nombre) {
      db.prepare('UPDATE clientes SET nombre = ? WHERE id = ?').run(nombre, factura.cliente_id);
      console.log(`  [OK]   ${numero}  "${factura.nombre}" → "${nombre}"`);
      actualizados++;
    }
  }

  console.log(`\n══ Resultado ════════════════════════════════`);
  console.log(`  ${actualizados} clientes actualizados`);
  console.log(`  ${sinCambio} sin cambio`);
  console.log(`  ${sinNombre} PDFs sin nombre extraído`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
