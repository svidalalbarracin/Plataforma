// Script de migración: limpia el campo nombre de clientes auto-creados.
// Los importadores guardaban "CUIT 30685849751" o "Cliente CUIT 30685849751"
// como nombre. Este script deja solo el número CUIT como nombre temporal
// para que el usuario complete el nombre real desde la app.
//
// Uso: node backend/scripts/migrar-clientes.js

require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const db = require('../../../../core/database');

const PATRONES = [
  /^(CUIT|CUIL|DNI)\s+(\d+)$/i,
  /^Cliente\s+(CUIT|CUIL|DNI)\s+(\d+)$/i,
];

const clientes = db.prepare('SELECT id, nombre, cuit FROM clientes').all();
let corregidos = 0;

for (const c of clientes) {
  let nuevoNombre = null;

  for (const patron of PATRONES) {
    const m = c.nombre.match(patron);
    if (m) {
      // Usa el número del nombre (coincide con cuit pero lo dejamos explícito)
      nuevoNombre = c.cuit;
      break;
    }
  }

  if (nuevoNombre && nuevoNombre !== c.nombre) {
    db.prepare('UPDATE clientes SET nombre = ? WHERE id = ?').run(nuevoNombre, c.id);
    console.log(`  [OK] id=${c.id}  "${c.nombre}" → "${nuevoNombre}"`);
    corregidos++;
  }
}

console.log(`\nMigración completada: ${corregidos} cliente(s) corregido(s) de ${clientes.length} total.`);
if (corregidos > 0) {
  console.log('\nRecordá completar los nombres reales desde la sección Clientes de la app.');
}
