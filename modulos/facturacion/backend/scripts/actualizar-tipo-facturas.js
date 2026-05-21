/**
 * Recorre los PDFs en storage/facturas/, extrae el tipo de comprobante de cada uno
 * y actualiza el campo `tipo` en la tabla `facturas` donde aún es NULL.
 *
 * Uso: node backend/scripts/actualizar-tipo-facturas.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const db = require('../../../../core/database');

const PDF_DIR = path.join(__dirname, '../../storage/facturas');

function extraerTipoDesdePDF(text) {
  // FCE debe chequearse antes que la letra suelta porque el PDF puede tener "FACTURA\nA" después del encabezado FCE
  if (/FACTURA DE CR[EÉ]DITO ELECTR[OÓ]NICA|FCE/i.test(text)) return 'FCE';
  const m = text.match(/\bFACTURA\b[\s\n]+([A-C])\b/);
  if (m) return m[1];
  return null;
}

async function main() {
  const pdfs = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf')).sort();
  console.log(`Procesando ${pdfs.length} PDFs en ${PDF_DIR}...\n`);

  let actualizadas = 0, sinCambio = 0, sinTipo = 0, noEncontradas = 0;

  for (const archivo of pdfs) {
    const numero = archivo.replace('.pdf', '');
    const factura = db.prepare('SELECT id, tipo FROM facturas WHERE numero = ?').get(numero);

    if (!factura) {
      console.log(`  [skip] ${numero} — no encontrada en DB`);
      noEncontradas++;
      continue;
    }

    if (factura.tipo !== null && factura.tipo !== '') {
      sinCambio++;
      continue;
    }

    let tipo = null;
    try {
      const buf = fs.readFileSync(path.join(PDF_DIR, archivo));
      const { text } = await pdfParse(buf);
      tipo = extraerTipoDesdePDF(text);
    } catch (e) {
      console.warn(`  [warn] ${numero}: ${e.message}`);
    }

    if (!tipo) {
      console.log(`  [?]    ${numero} — tipo no detectado`);
      sinTipo++;
      continue;
    }

    db.prepare('UPDATE facturas SET tipo = ? WHERE id = ?').run(tipo, factura.id);
    console.log(`  [OK]   ${numero}  → ${tipo}`);
    actualizadas++;
  }

  console.log(`\n══ Resultado ════════════════════════════════`);
  console.log(`  ${actualizadas} facturas actualizadas`);
  console.log(`  ${sinCambio} ya tenían tipo`);
  console.log(`  ${sinTipo} sin tipo detectado`);
  console.log(`  ${noEncontradas} PDFs sin factura en DB`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
