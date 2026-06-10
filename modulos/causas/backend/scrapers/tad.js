/**
 * Scraper de Trámites a Distancia (TAD).
 *
 * Hace login en tramitesadistancia.gob.ar vía ARCA (clave fiscal), navega a la
 * sección de Notificaciones, descarga las últimas 10 notificaciones y los
 * documentos externos asociados a trámites que tengan notificación.
 *
 * @module causas/scrapers/tad
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const DIR_NOTIF = path.join(__dirname, '../../storage/tad/notificaciones');
const DIR_DOCS  = path.join(__dirname, '../../storage/tad/documentos_externos');
fs.mkdirSync(DIR_NOTIF, { recursive: true });
fs.mkdirSync(DIR_DOCS,  { recursive: true });

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Verifica si una notificación TAD ya existe por número de trámite y fecha.
 * @param {string} numero_tramite
 * @param {string|null} fecha
 * @returns {boolean}
 */
function notifExiste(numero_tramite, fecha) {
  return !!db.prepare(
    'SELECT id FROM notificaciones_tad WHERE numero_tramite = ? AND fecha = ?'
  ).get(numero_tramite, fecha);
}

/**
 * Verifica si un documento externo TAD ya existe por número de trámite y fecha de envío.
 * @param {string} numero_tramite
 * @param {string|null} fecha_envio
 * @returns {boolean}
 */
function docExiste(numero_tramite, fecha_envio) {
  return !!db.prepare(
    'SELECT id FROM documentos_externos_tad WHERE numero_tramite = ? AND fecha_envio = ?'
  ).get(numero_tramite, fecha_envio);
}

/**
 * Inserta una notificación TAD en la base de datos.
 * @param {{ fecha: string|null, nombre: string|null, mensaje: string|null, numero_tramite: string, archivo_path: string|null }} datos
 */
function guardarNotif({ fecha, nombre, mensaje, numero_tramite, archivo_path }) {
  db.prepare(`
    INSERT INTO notificaciones_tad (fecha, nombre, mensaje, numero_tramite, archivo_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(fecha, nombre, mensaje, numero_tramite, archivo_path);
}

/**
 * Inserta un documento externo TAD en la base de datos.
 * `archivos_paths` se serializa como JSON array de rutas absolutas.
 * @param {{ fecha_envio: string|null, nombre: string|null, numero_tramite: string, motivo: string|null, archivos_paths: string[] }} datos
 */
function guardarDoc({ fecha_envio, nombre, numero_tramite, motivo, archivos_paths }) {
  db.prepare(`
    INSERT INTO documentos_externos_tad (fecha_envio, nombre, numero_tramite, motivo, archivos_paths)
    VALUES (?, ?, ?, ?, ?)
  `).run(fecha_envio, nombre, numero_tramite, motivo, JSON.stringify(archivos_paths));
}

/**
 * Convierte fechas en formato dd/mm/aaaa o ISO a YYYY-MM-DD.
 * @param {string|null} str
 * @returns {string|null}
 */
function isoFecha(str) {
  if (!str) return null;
  const s = str.trim();
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s || null;
}

// ── Login ─────────────────────────────────────────────────────────────────────

/**
 * Abre una nueva pestaña, navega a TAD, abre el modal de login,
 * selecciona ARCA y completa el formulario de clave fiscal.
 * Usa CUIT y CLAVE_FISCAL del .env.
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>} Página de TAD ya autenticada
 */
async function login(context) {
  const page = await context.newPage();

  await page.goto('https://tramitesadistancia.gob.ar/', { waitUntil: 'load', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  await page.locator('button.btn.btn-primary[data-bs-target="#loginModal"]').click();
  await page.waitForSelector('[data-auth-name="ARCA"]', { timeout: 10000 });
  await page.locator('[data-auth-name="ARCA"]').click();

  await page.waitForSelector('[id="F1:username"]', { timeout: 30000 });
  await page.fill('[id="F1:username"]', process.env.CUIT);
  await page.click('[id="F1:btnSiguiente"]');
  await page.waitForSelector('[id="F1:password"]', { timeout: 30000 });
  await page.fill('[id="F1:password"]', process.env.CLAVE_FISCAL);
  await page.click('[id="F1:btnIngresar"]');

  await page.waitForURL(url => url.href.includes('tramitesadistancia.gob.ar'), { timeout: 60000, waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 3000));

  console.log('  Login OK');
  return page;
}

// ── Navegación ────────────────────────────────────────────────────────────────

/**
 * Hace click en el link de "notificaciones" del menú y espera que cargue la tabla.
 * @param {import('playwright').Page} page
 */
async function irANotificaciones(page) {
  await page.waitForSelector('a[href*="notificaciones"]', { timeout: 20000 });
  await page.locator('a[href*="notificaciones"]').first().click();
  await new Promise(r => setTimeout(r, 4000));
  await page.waitForSelector('table tbody tr', { timeout: 20000 });
  console.log('  Página Notificaciones cargada');
}

/**
 * Cambia a una pestaña interna del listado (ej: "Documentos Externos") usando los tabs de Bootstrap.
 * @param {import('playwright').Page} page
 * @param {string} nombre - Texto visible de la pestaña
 */
async function irAPestanaInterna(page, nombre) {
  await page.locator(`a[data-toggle="tab"]:has-text("${nombre}")`).click();
  await new Promise(r => setTimeout(r, 3000));
  await page.waitForSelector('table tbody tr', { timeout: 20000 });
  console.log(`  Pestaña "${nombre}" activa`);
}

/**
 * Intenta configurar 10 resultados por página en el paginador del listado.
 * Si no encuentra el selector, continúa con el default.
 * @param {import('playwright').Page} page
 */
async function mostrar10(page) {
  try {
    const btn = page.locator('a:has-text("10"), button:has-text("10")').filter({ hasText: /^10$/ }).first();
    if (await btn.isVisible({ timeout: 5000 })) {
      await btn.click();
      await new Promise(r => setTimeout(r, 2000));
      console.log('  Mostrando 10 por página');
    }
  } catch {
    console.log('  No se encontró selector de 10 — usando default');
  }
}

// ── Extracción de datos ───────────────────────────────────────────────────────

/**
 * Extrae las filas de la tabla de Notificaciones.
 * Columnas esperadas: [0] fecha | [1] nombre | [2] mensaje | [3] número de trámite
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ fecha: string|null, nombre: string|null, mensaje: string|null, numero_tramite: string|null }>>}
 */
async function extraerFilasNotif(page) {
  return page.evaluate(() => {
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim());
      if (celdas.length >= 4) {
        filas.push({
          fecha:          celdas[0] || null,
          nombre:         celdas[1] || null,
          mensaje:        celdas[2] || null,
          numero_tramite: celdas[3] || null,
        });
      }
    });
    return filas;
  });
}

/**
 * Extrae las filas de la tabla de Documentos Externos.
 * Columnas esperadas: [0] fecha envío | [1] nombre | [2] número de trámite | [3] motivo
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ fecha_envio: string|null, nombre: string|null, numero_tramite: string|null, motivo: string|null }>>}
 */
async function extraerFilasDocs(page) {
  return page.evaluate(() => {
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim());
      if (celdas.length >= 4) {
        filas.push({
          fecha_envio:    celdas[0] || null,
          nombre:         celdas[1] || null,
          numero_tramite: celdas[2] || null,
          motivo:         celdas[3] || null,
        });
      }
    });
    return filas;
  });
}

// ── Descargas ─────────────────────────────────────────────────────────────────

/**
 * Descarga el PDF de una notificación desde la columna Acciones.
 *
 * @param {import('playwright').Page} page
 * @param {number} rowIndex       - Índice de la fila en tbody
 * @param {string} numero_tramite - Número de trámite (para el nombre del archivo)
 * @param {string|null} fecha     - Fecha en formato ISO (para el nombre del archivo)
 * @returns {Promise<string|null>} Ruta absoluta al PDF o null si falló
 */
async function descargarNotif(page, rowIndex, numero_tramite, fecha) {
  const row = page.locator('table tbody tr').nth(rowIndex);
  const btn = row.locator('.acciones a, a:has(i.fa-download)').first();

  const numLimpio   = (numero_tramite || 'sin-numero').replace(/[/\\:*?"<>|]/g, '-');
  const fechaLimpia = (fecha         || 'sin-fecha'  ).replace(/[/\\:*?"<>|]/g, '-');
  const destino     = path.join(DIR_NOTIF, `${numLimpio}_${fechaLimpia}.pdf`);

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      btn.click(),
    ]);
    await download.saveAs(destino);
    console.log(`    Descargado: ${path.basename(destino)}`);
    return destino;
  } catch (e) {
    console.log(`    Descarga fallida (${e.message.split('\n')[0]})`);
    return null;
  }
}

/**
 * Abre el modal del ojo de una fila de Documentos Externos y descarga todos los PDFs del modal.
 * Cierra el modal al terminar.
 *
 * @param {import('playwright').Page} page
 * @param {number} rowIndex       - Índice de la fila en tbody
 * @param {string} numero_tramite - Para el nombre de los archivos
 * @param {string|null} fecha_envio
 * @returns {Promise<string[]>} Rutas absolutas de los PDFs descargados
 */
async function descargarDocsDelOjo(page, rowIndex, numero_tramite, fecha_envio) {
  const row    = page.locator('table tbody tr').nth(rowIndex);
  const btnOjo = row.locator('.acciones a, a:has(i.fa-eye), a:has(i.fa-search)').first();

  await btnOjo.click();
  await new Promise(r => setTimeout(r, 2000));
  await page.waitForSelector('[role="dialog"] table tbody tr, .modal table tbody tr, .modal-body table tbody tr', { timeout: 15000 });

  const filasDocs   = await page.locator('[role="dialog"] table tbody tr, .modal table tbody tr, .modal-body table tbody tr').all();
  const rutas       = [];
  const numLimpio   = (numero_tramite || 'sin-numero').replace(/[/\\:*?"<>|]/g, '-');
  const fechaLimpia = (fecha_envio   || 'sin-fecha'  ).replace(/[/\\:*?"<>|]/g, '-');

  for (let i = 0; i < filasDocs.length; i++) {
    const btnDesc = filasDocs[i].locator('a, button').last();
    const destino = path.join(DIR_DOCS, `${numLimpio}_${fechaLimpia}_${i + 1}.pdf`);
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        btnDesc.click(),
      ]);
      await download.saveAs(destino);
      rutas.push(destino);
      console.log(`    PDF ${i + 1}: ${path.basename(destino)}`);
    } catch (e) {
      console.log(`    PDF ${i + 1} fallido: ${e.message.split('\n')[0]}`);
    }
  }

  // Cerrar el modal antes de continuar
  try {
    await page.locator('[role="dialog"] button[aria-label*="cerrar"], [role="dialog"] button[aria-label*="close"], [role="dialog"] .modal-close, button.close').first().click({ timeout: 5000 });
  } catch {
    await page.keyboard.press('Escape');
  }
  await new Promise(r => setTimeout(r, 1000));

  return rutas;
}

// ── Función principal exportable ──────────────────────────────────────────────

/**
 * Obtiene las últimas 10 notificaciones y documentos externos de TAD
 * y persiste los nuevos en la base de datos.
 *
 * Solo descarga documentos externos si el número de trámite tiene
 * una notificación asociada en la misma ejecución.
 *
 * @param {{ headless?: boolean }} [opts]
 * @returns {Promise<{ nuevasNotif: number, nuevosDocs: number }>}
 */
async function obtenerNotificacionesTAD({ headless = true } = {}) {
  console.log('\n══ Scraper TAD ═══════════════════════════════════════════════');

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(60000);

  let nuevasNotif = 0;
  let nuevosDocs  = 0;

  try {
    console.log('\n1. Login TAD con ARCA...');
    const page = await login(context);

    console.log('\n2. Navegando a Notificaciones...');
    await irANotificaciones(page);
    await mostrar10(page);

    // ── Parte 1: Notificaciones ───────────────────────────────────────────────

    console.log('\n3. Extrayendo notificaciones (primeras 10)...');
    const filasNotif = (await extraerFilasNotif(page))
      .slice(0, 10)
      .map(f => ({ ...f, fecha: isoFecha(f.fecha), numero_tramite: f.numero_tramite?.trim() }))
      .filter(f => f.numero_tramite);

    console.log(`  ${filasNotif.length} fila(s) encontradas`);

    // Acumula los trámites vistos para filtrar documentos externos luego
    const tramitesNotif = new Set();

    for (let i = 0; i < filasNotif.length; i++) {
      const f = filasNotif[i];
      tramitesNotif.add(f.numero_tramite);

      if (notifExiste(f.numero_tramite, f.fecha)) {
        console.log(`  [=]  ${f.numero_tramite} ya existe`);
        continue;
      }

      console.log(`  [+]  ${f.numero_tramite}  ${f.fecha ?? ''}`);
      const archivePath = await descargarNotif(page, i, f.numero_tramite, f.fecha);
      guardarNotif({ ...f, archivo_path: archivePath });
      nuevasNotif++;
    }

    // ── Parte 2: Documentos Externos ─────────────────────────────────────────
    // Solo se descargan documentos de trámites que tienen notificación,
    // para evitar descargar documentos sin contexto.

    console.log('\n4. Cambiando a Documentos Externos...');
    await irAPestanaInterna(page, 'Documentos Externos');
    await mostrar10(page);

    console.log('\n5. Extrayendo documentos externos...');
    const todasFilasDocs = await extraerFilasDocs(page);
    const filasDocs = todasFilasDocs
      .map(f => ({ ...f, fecha_envio: isoFecha(f.fecha_envio), numero_tramite: f.numero_tramite?.trim() }))
      .filter(f => f.numero_tramite && tramitesNotif.has(f.numero_tramite));

    console.log(`  ${todasFilasDocs.length} entradas totales → ${filasDocs.length} con notificación asociada`);

    for (const f of filasDocs) {
      if (docExiste(f.numero_tramite, f.fecha_envio)) {
        console.log(`  [=]  ${f.numero_tramite} doc ya existe`);
        continue;
      }

      // El índice real en la tabla puede diferir del índice filtrado
      const idx = todasFilasDocs.findIndex(
        r => r.numero_tramite?.trim() === f.numero_tramite && isoFecha(r.fecha_envio) === f.fecha_envio
      );

      console.log(`  [+]  ${f.numero_tramite}  ${f.fecha_envio ?? ''}`);
      const rutas = await descargarDocsDelOjo(page, idx, f.numero_tramite, f.fecha_envio);
      guardarDoc({ fecha_envio: f.fecha_envio, nombre: f.nombre, numero_tramite: f.numero_tramite, motivo: f.motivo, archivos_paths: rutas });
      nuevosDocs++;
    }

    console.log('\n══ Resultado ═════════════════════════════════════════════════');
    console.log(`  Notificaciones nuevas:       ${nuevasNotif}`);
    console.log(`  Documentos externos nuevos:  ${nuevosDocs}`);
    return { nuevasNotif, nuevosDocs };

  } finally {
    await browser.close();
  }
}

module.exports = { obtenerNotificacionesTAD };

// node tad.js [--visible]
if (require.main === module) {
  const headless = !process.argv.includes('--visible');
  obtenerNotificacionesTAD({ headless }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
