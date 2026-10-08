/**
 * Scraper de Trámites a Distancia (TAD).
 *
 * Hace login en tramitesadistancia.gob.ar vía ARCA (clave fiscal), navega a la
 * sección de Notificaciones, recorre el listado paginado descargando las
 * notificaciones nuevas y los documentos externos asociados a trámites que
 * tengan notificación.
 *
 * @module causas/scrapers/tad
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const DIR_NOTIF    = path.join(__dirname, '../../storage/tad/notificaciones');
const DIR_DOCS     = path.join(__dirname, '../../storage/tad/documentos_externos');
const FECHA_LIMITE = '2026-06-01';
// Tope de seguridad del recorrido paginado (50 filas por página → 1000 filas)
const MAX_PAGINAS  = 20;
fs.mkdirSync(DIR_NOTIF, { recursive: true });
fs.mkdirSync(DIR_DOCS,  { recursive: true });

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Cuenta cuántas notificaciones TAD ya están guardadas con esta misma
 * combinación de trámite/fecha/mensaje. No es un booleano de "existe" porque
 * un mismo trámite puede recibir dos notificaciones distintas el mismo día
 * con el mensaje idéntico (el portal no expone ningún otro dato que las
 * distinga) — el llamador compara este conteo contra cuántas veces aparece
 * la misma tupla en la tanda que se está scrapeando para saber si a esta
 * ocurrencia puntual todavía le falta guardarse.
 * @param {string} numero_tramite
 * @param {string|null} fecha
 * @param {string|null} mensaje
 * @returns {number}
 */
function contarNotifExistentes(numero_tramite, fecha, mensaje) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM notificaciones_tad WHERE numero_tramite = ? AND fecha IS ? AND mensaje IS ?'
  ).get(numero_tramite, fecha, mensaje).n;
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
}

/**
 * Elige cuántas filas mostrar por página en el `<select>` del listado activo
 * (el portal ofrece 5, 10, 50 y "Todos"; arranca en 5). Si no encuentra el
 * selector, continúa con el default — la paginación con irAPaginaSiguiente()
 * cubre el resto igual, solo que con más clicks.
 * @param {import('playwright').Page} page
 * @param {number} [cantidad=50]
 */
async function mostrarPorPagina(page, cantidad = 50) {
  try {
    const select = page.locator(`select:visible:has(option[value="${cantidad}"])`).first();
    if (await select.isVisible({ timeout: 5000 })) {
      await select.selectOption(String(cantidad));
      await new Promise(r => setTimeout(r, 2000));
      // Cambiar el tamaño no vuelve a la página 1 (si estaba en la 3, queda
      // en la 3 con el nuevo tamaño) — se fuerza para no saltear filas.
      const pagina1 = page.locator('ul.ng2-pagination:visible li:not(.current) a').filter({ hasText: /^\s*page\s+1\s*$/ });
      if (await pagina1.count()) {
        await pagina1.first().click();
        await new Promise(r => setTimeout(r, 1500));
      }
      await page.waitForSelector('table tbody tr', { timeout: 20000 });
    }
  } catch { /* default pagination */ }
}

/**
 * Avanza a la página siguiente del paginador del listado activo
 * (`ng2-pagination`). Espera a que cambie el número de página actual antes de
 * volver, para no leer la tabla vieja.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} false si ya estaba en la última página
 */
async function irAPaginaSiguiente(page) {
  const paginador = page.locator('ul.ng2-pagination:visible').first();
  if (!(await paginador.count())) return false;

  const siguiente = paginador.locator('li.pagination-next:not(.disabled) a');
  if (!(await siguiente.count())) return false;

  const actual = async () => (await paginador.locator('li.current').innerText()).replace(/\D/g, '');
  const antes = await actual();
  await siguiente.first().click();
  await page.waitForFunction(
    prev => {
      const li = [...document.querySelectorAll('ul.ng2-pagination li.current')].find(e => e.offsetParent);
      return li && li.innerText.replace(/\D/g, '') !== prev;
    },
    antes, { timeout: 20000 }
  );
  await new Promise(r => setTimeout(r, 1500));
  await page.waitForSelector('table tbody tr', { timeout: 20000 });
  return true;
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
 * El nombre del archivo incluye el mensaje (además de trámite y fecha) porque
 * un mismo trámite puede recibir más de una notificación el mismo día (ej.
 * "Alta Interviniente" y "Notificación Traslado inicial"); sin el mensaje,
 * ambas colisionan en el mismo path y la segunda descarga pisa el PDF de la
 * primera en disco. Si además dos notificaciones distintas comparten
 * trámite, fecha Y mensaje (el portal no da otro dato para diferenciarlas),
 * el nombre generado sigue siendo el mismo — en ese caso se agrega un
 * sufijo numérico para no pisar el PDF ya descargado.
 *
 * @param {import('playwright').Page} page
 * @param {number} rowIndex       - Índice de la fila en tbody
 * @param {string} numero_tramite - Número de trámite (para el nombre del archivo)
 * @param {string|null} fecha     - Fecha en formato ISO (para el nombre del archivo)
 * @param {string|null} mensaje   - Mensaje de la notificación (para el nombre del archivo)
 * @returns {Promise<string|null>} Ruta absoluta al PDF o null si falló
 */
async function descargarNotif(page, rowIndex, numero_tramite, fecha, mensaje) {
  const row = page.locator('table tbody tr').nth(rowIndex);
  const btn = row.locator('.acciones a, a:has(i.fa-download)').first();

  const numLimpio     = (numero_tramite || 'sin-numero').replace(/[/\\:*?"<>|]/g, '-');
  const fechaLimpia   = (fecha          || 'sin-fecha'  ).replace(/[/\\:*?"<>|]/g, '-');
  const mensajeLimpio = mensaje ? '_' + mensaje.replace(/[/\\:*?"<>|]/g, '-').slice(0, 40) : '';
  let destino = path.join(DIR_NOTIF, `${numLimpio}_${fechaLimpia}${mensajeLimpio}.pdf`);
  for (let n = 2; fs.existsSync(destino); n++) {
    destino = path.join(DIR_NOTIF, `${numLimpio}_${fechaLimpia}${mensajeLimpio}_${n}.pdf`);
  }

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      btn.click(),
    ]);
    await download.saveAs(destino);
    return destino;
  } catch (e) {
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
    } catch (e) { /* PDF no disponible */ }
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
 * Recorre las notificaciones y documentos externos de TAD (todas las páginas
 * que haga falta) y persiste los nuevos en la base de datos.
 *
 * Solo descarga documentos externos si el número de trámite tiene
 * una notificación asociada en la misma ejecución.
 *
 * @param {{ headless?: boolean }} [opts]
 * @returns {Promise<{ nuevasNotif: number, nuevosDocs: number }>}
 */
async function obtenerNotificacionesTAD({ headless = true } = {}) {
  const paso = texto => {
    process.stdout.write(`  [TAD] ${texto}`.padEnd(55) + ' ');
    return () => process.stdout.write('OK!\n');
  };

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(60000);

  let nuevasNotif = 0, nuevosDocs = 0;

  try {
    let ok = paso('Login ARCA...');
    const page = await login(context);
    ok();

    ok = paso('Navegando a notificaciones...');
    await irANotificaciones(page);
    await mostrarPorPagina(page);
    ok();

    // El listado está paginado (y ordenado de más nuevo a más viejo): se
    // recorre página por página hasta la primera fila anterior a FECHA_LIMITE.
    // No hay corte por duplicados a propósito: las ya guardadas solo se
    // comparan contra la base (no se descargan), así que recorrerlas cuesta
    // casi nada — y cualquier hueco de más abajo se recupera solo. Con el corte
    // por duplicados, las notificaciones perdidas cuando el scraper no
    // paginaba (solo leía la primera página) no se recuperaban nunca: cortaba
    // en las primeras filas, que ya estaban en la base.
    ok = paso('Procesando notificaciones...');
    const tramitesNotif = new Set();
    const vistosEnEstaCorrida = new Map(); // clave trámite|fecha|mensaje -> veces vista en esta tanda
    let fechaMasVieja = null;              // la más vieja recorrida — acota la búsqueda de documentos externos
    let cortar = false;

    for (let pagina = 1; pagina <= MAX_PAGINAS && !cortar; pagina++) {
      if (pagina > 1 && !(await irAPaginaSiguiente(page))) break;

      // `i` es el índice dentro de la página actual: es el que usa descargarNotif()
      const filasNotif = (await extraerFilasNotif(page))
        .map((f, i) => ({ ...f, i, fecha: isoFecha(f.fecha), numero_tramite: f.numero_tramite?.trim() }))
        .filter(f => f.numero_tramite);

      for (const f of filasNotif) {
        if (f.fecha && f.fecha < FECHA_LIMITE) { cortar = true; break; }

        tramitesNotif.add(f.numero_tramite);
        if (f.fecha && (!fechaMasVieja || f.fecha < fechaMasVieja)) fechaMasVieja = f.fecha;

        const clave = `${f.numero_tramite}|${f.fecha}|${f.mensaje}`;
        const ocurrencia = (vistosEnEstaCorrida.get(clave) || 0) + 1;
        vistosEnEstaCorrida.set(clave, ocurrencia);

        // Ya guardada si esta ocurrencia (1ª, 2ª...) tiene su par entre las
        // que ya existen en la base para esta misma tupla — así una segunda
        // notificación idéntica en trámite/fecha/mensaje sí se guarda.
        if (ocurrencia <= contarNotifExistentes(f.numero_tramite, f.fecha, f.mensaje)) continue;

        const archivePath = await descargarNotif(page, f.i, f.numero_tramite, f.fecha, f.mensaje);
        guardarNotif({ ...f, archivo_path: archivePath });
        nuevasNotif++;
      }
    }
    ok();

    // Mismo recorrido paginado. Corta cuando una página entera ya es más vieja
    // que la notificación más vieja recorrida arriba (o que FECHA_LIMITE):
    // de ahí para atrás no puede haber documentos de los trámites que importan.
    ok = paso('Procesando documentos externos...');
    await irAPestanaInterna(page, 'Documentos Externos');
    await mostrarPorPagina(page);

    const corteDocs = fechaMasVieja && fechaMasVieja > FECHA_LIMITE ? fechaMasVieja : FECHA_LIMITE;

    for (let pagina = 1; pagina <= MAX_PAGINAS && tramitesNotif.size; pagina++) {
      if (pagina > 1 && !(await irAPaginaSiguiente(page))) break;

      const todasFilasDocs = (await extraerFilasDocs(page))
        .map((f, i) => ({ ...f, i, fecha_envio: isoFecha(f.fecha_envio), numero_tramite: f.numero_tramite?.trim() }));

      for (const f of todasFilasDocs) {
        if (!f.numero_tramite || !tramitesNotif.has(f.numero_tramite)) continue;
        if (f.fecha_envio && f.fecha_envio < FECHA_LIMITE) continue;
        if (docExiste(f.numero_tramite, f.fecha_envio)) continue;

        const rutas = await descargarDocsDelOjo(page, f.i, f.numero_tramite, f.fecha_envio);
        guardarDoc({ fecha_envio: f.fecha_envio, nombre: f.nombre, numero_tramite: f.numero_tramite, motivo: f.motivo, archivos_paths: rutas });
        nuevosDocs++;
      }

      const fechas = todasFilasDocs.map(f => f.fecha_envio).filter(Boolean);
      if (fechas.length && fechas.every(fe => fe < corteDocs)) break;
    }
    ok();

    const resumen = nuevasNotif > 0 || nuevosDocs > 0
      ? `${nuevasNotif} notif. nueva(s)${nuevosDocs > 0 ? ` · ${nuevosDocs} doc(s)` : ''}`
      : 'Sin novedades';
    console.log(`  [TAD] ${resumen}`);
    return { nuevasNotif, nuevosDocs };

  } finally {
    await browser.close();
  }
}

module.exports = {
  obtenerNotificacionesTAD,
  // Exportadas para reuso desde scripts puntuales de mantenimiento (ver reparar-tad-duplicados.js)
  login, irANotificaciones, mostrarPorPagina, irAPaginaSiguiente, extraerFilasNotif, descargarNotif, isoFecha,
};

// node tad.js [--visible]
if (require.main === module) {
  const headless = !process.argv.includes('--visible');
  obtenerNotificacionesTAD({ headless }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
