require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { consultarUltimoComprobante, consultarComprobante } = require('./wsfev1');

const LIMITE = 5;

const NOMBRES_TIPO = {
  1: 'Factura A', 2: 'Nota Débito A', 3: 'Nota Crédito A',
  6: 'Factura B', 7: 'Nota Débito B', 8: 'Nota Crédito B',
  19: 'Factura E', 201: 'FCE MiPyMEs A',
};

async function probar() {
  const pvs   = (process.env.PUNTOS_VENTA || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  const tipos = (process.env.TIPO_COMPROBANTE || '').split(',').map(s => Number(s.trim())).filter(Boolean);

  console.log(`\nCUIT: ${process.env.CUIT}`);
  console.log(`Puntos de venta: ${pvs.join(', ')}`);
  console.log(`Tipos a consultar: ${tipos.join(', ')}\n`);

  for (const pv of pvs) {
  for (const tc of tipos) {
    const nombre = NOMBRES_TIPO[tc] || `Tipo ${tc}`;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`PV ${pv} — Tipo ${tc} — ${nombre}`);
    console.log('─'.repeat(50));

    let ultimo;
    try {
      ultimo = await consultarUltimoComprobante(pv, tc);
    } catch (e) {
      console.log(`  ERROR al consultar último: ${e.message}`);
      continue;
    }

    console.log(`Último autorizado: ${ultimo}`);

    if (ultimo === 0) {
      console.log('Sin comprobantes para este tipo.');
      continue;
    }

    const desde = Math.max(1, ultimo - LIMITE + 1);
    console.log(`Trayendo del ${desde} al ${ultimo}:\n`);

    for (let nro = desde; nro <= ultimo; nro++) {
      try {
        const c = await consultarComprobante(pv, tc, nro);
        console.log(`  #${String(nro).padStart(8, '0')}`);
        console.log(`    Fecha:       ${c.CbteFch}`);
        console.log(`    CAE:         ${c.CodAutorizacion}`);
        console.log(`    Vto CAE:     ${c.FchVtoPago ?? c.FchVto ?? '—'}`);
        console.log(`    DocTipo:     ${c.DocTipo}  DocNro: ${c.DocNro}`);
        console.log(`    Moneda:      ${c.MonId}  Cotiz: ${c.MonCotiz}`);
        console.log(`    Imp Neto:    ${c.ImpNeto}`);
        console.log(`    Imp IVA:     ${c.ImpIVA}`);
        console.log(`    Imp Op Ex:   ${c.ImpOpEx}`);
        console.log(`    Imp Total:   ${c.ImpTotal}`);
        console.log(`    Concepto:    ${c.Concepto}`);
        console.log(`    Estado:      ${c.Resultado}`);
        const ignorar = new Set(['CbteFch','CodAutorizacion','FchVtoPago','FchVto','DocTipo','DocNro',
          'MonId','MonCotiz','ImpNeto','ImpIVA','ImpOpEx','ImpTotal','Concepto','Resultado',
          'CbteDesde','CbteHasta','CbteTipo','PtoVta','FchProceso','EmisionTipo','Observaciones']);
        const extras = Object.entries(c).filter(([k,v]) => !ignorar.has(k) && v != null && v !== '' && v !== 0);
        if (extras.length) {
          console.log(`    Campos extra:`);
          extras.forEach(([k,v]) => console.log(`      ${k}: ${JSON.stringify(v)}`));
        }
        console.log('');
      } catch (e) {
        console.log(`  #${String(nro).padStart(8, '0')}  ERROR: ${e.message}\n`);
      }
    }
  }
  } // fin loop pvs

  console.log('\n' + '═'.repeat(50));
  console.log('Prueba finalizada.');
}

probar().catch(e => {
  console.error('\nError fatal:', e.message);
  process.exit(1);
});
