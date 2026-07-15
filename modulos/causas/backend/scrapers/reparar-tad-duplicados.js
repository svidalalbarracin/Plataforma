/**
 * Script puntual de reparación.
 *
 * Busca notificaciones TAD cuyo `archivo_path` quedó pisado por otra
 * notificación del mismo trámite y fecha (bug de colisión de nombre de
 * archivo, corregido en tad.js) y vuelve a descargar el PDF correcto para
 * cada una desde el portal, guardándolo con el nuevo esquema de nombres
 * (que ya incluye el mensaje y no vuelve a colisionar).
 *
 * No es parte del scheduler ni del scraper normal — se corre a mano cuando
 * se detecta o se sospecha un caso de este tipo.
 *
 * Uso: node reparar-tad-duplicados.js [--visible]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
const { chromium } = require('playwright');
const db = require('../../../../core/database');
const {
  login, irANotificaciones, mostrar10, extraerFilasNotif, descargarNotif, isoFecha,
} = require('./tad');

/**
 * Busca notificaciones cuyo archivo_path esté repetido en 2 o más filas.
 * @returns {Array<{id:number, fecha:string, mensaje:string, numero_tramite:string, archivo_path:string}>}
 */
function buscarDuplicados() {
  return db.prepare(`
    SELECT n.id, n.fecha, n.mensaje, n.numero_tramite, n.archivo_path
    FROM notificaciones_tad n
    JOIN (
      SELECT archivo_path FROM notificaciones_tad
      WHERE archivo_path IS NOT NULL
      GROUP BY archivo_path HAVING COUNT(*) > 1
    ) dup ON n.archivo_path = dup.archivo_path
    ORDER BY n.archivo_path, n.id
  `).all();
}

function actualizarArchivoPath(id, archivo_path) {
  db.prepare('UPDATE notificaciones_tad SET archivo_path = ? WHERE id = ?').run(archivo_path, id);
}

/**
 * Intenta avanzar a la página siguiente del listado, probando varios
 * selectores comunes de paginador (no se conoce de antemano cuál usa TAD).
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true si pudo avanzar, false si no hay más páginas
 */
async function siguientePagina(page) {
  const candidatos = [
    '.pagination .page-item:not(.disabled) a[aria-label*="Next" i]',
    '.pagination li:not(.disabled) a:has-text(">")',
    'a:has-text("Siguiente")',
    'a:has-text("»")',
  ];
  for (const sel of candidatos) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        await new Promise(r => setTimeout(r, 2500));
        return true;
      }
    } catch { /* probar siguiente selector */ }
  }
  return false;
}

/**
 * Recorre el listado de Notificaciones de TAD buscando cada fila objetivo
 * (por trámite + fecha + mensaje) y vuelve a descargar su PDF.
 * @param {{ headless?: boolean }} [opts]
 */
async function main({ headless = true } = {}) {
  const pendientes = buscarDuplicados();
  if (!pendientes.length) {
    console.log('No se encontraron notificaciones con archivo_path duplicado.');
    return;
  }

  console.log(`Encontradas ${pendientes.length} notificaciones afectadas:`);
  pendientes.forEach(p => console.log(`  id=${p.id} | ${p.numero_tramite} | ${p.fecha} | "${p.mensaje}"`));

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(60000);

  let reparadas = 0;
  const restantes = [...pendientes];
  const noEncontradas = [];

  try {
    console.log('\nLogin ARCA...');
    const page = await login(context);

    console.log('Navegando a notificaciones...');
    await irANotificaciones(page);
    await mostrar10(page);

    let paginasRecorridas = 0;
    const MAX_PAGINAS = 20; // salvaguarda contra loop infinito

    while (restantes.length && paginasRecorridas < MAX_PAGINAS) {
      const filas = (await extraerFilasNotif(page))
        .map(f => ({ ...f, fecha: isoFecha(f.fecha), numero_tramite: f.numero_tramite?.trim() }));

      for (let i = restantes.length - 1; i >= 0; i--) {
        const objetivo = restantes[i];
        const idx = filas.findIndex(f =>
          f.numero_tramite === objetivo.numero_tramite &&
          f.fecha === objetivo.fecha &&
          f.mensaje === objetivo.mensaje
        );
        if (idx === -1) continue;

        console.log(`Descargando de nuevo: id=${objetivo.id} (${objetivo.numero_tramite} | ${objetivo.mensaje})`);
        const nuevoPath = await descargarNotif(page, idx, objetivo.numero_tramite, objetivo.fecha, objetivo.mensaje);
        if (nuevoPath) {
          actualizarArchivoPath(objetivo.id, nuevoPath);
          reparadas++;
          console.log(`  OK -> ${nuevoPath}`);
        } else {
          console.log(`  Fallo la descarga para id=${objetivo.id}`);
        }
        restantes.splice(i, 1);
      }

      if (!restantes.length) break;
      paginasRecorridas++;
      const avanzo = await siguientePagina(page);
      if (!avanzo) break;
    }

    noEncontradas.push(...restantes);
  } finally {
    await browser.close();
  }

  console.log(`\nReparadas: ${reparadas}/${pendientes.length}`);
  if (noEncontradas.length) {
    console.log('No encontradas en el portal (revisar manualmente):');
    noEncontradas.forEach(p => console.log(`  id=${p.id} | ${p.numero_tramite} | ${p.fecha} | "${p.mensaje}"`));
  }
}

module.exports = { main, buscarDuplicados };

// node reparar-tad-duplicados.js [--visible]
if (require.main === module) {
  const headless = !process.argv.includes('--visible');
  main({ headless }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
