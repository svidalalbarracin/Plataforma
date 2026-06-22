/**
 * Scraper del Portal de Notificaciones del Poder Judicial (PJN).
 *
 * Navega a notif.pjn.gov.ar, hace login SSO si es necesario, recorre la tabla
 * de notificaciones recibidas, descarga los PDFs y persiste en la base de datos.
 *
 * Modos de operación:
 * - Automático (limite = null): recorre páginas hasta encontrar 3 duplicados consecutivos.
 * - Manual (limite > 0): procesa exactamente `limite` filas sin importar duplicados.
 *
 * @module causas/scrapers/pjn
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const URL_NOTIFICACIONES = 'https://notif.pjn.gov.ar/recibidas';
const STORAGE_DIR        = path.join(__dirname, '../../storage/pjn/notificaciones');
const FECHA_LIMITE       = '2026-06-01';

/** Selector del botón "siguiente página" del paginador de Material UI. */
const SELECTOR_SIGUIENTE = 'button[aria-label="Ir a la siguiente página del listado"]';

/** Mapa de abreviaturas de meses en español → número de mes. */
const MESES_CORTO = { ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12 };

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Verifica si una notificación ya existe en la base por número.
 * @param {string} numero
 * @returns {boolean}
 */
function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_pjn WHERE numero = ?').get(numero);
}

/**
 * Inserta una nueva notificación PJN en la base de datos.
 * @param {{ numero: string, numero_expediente: string|null, caratula: string|null, autor: string|null, fecha_envio: string|null, archivo_path: string|null }} datos
 */
function guardar({ numero, numero_expediente, caratula, autor, fecha_envio, archivo_path = null }) {
  db.prepare(`
    INSERT INTO notificaciones_pjn (numero, numero_expediente, caratula, autor, fecha_envio, archivo_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(numero, numero_expediente, caratula, autor, fecha_envio, archivo_path);
}

/**
 * Guarda o reemplaza un valor en la tabla de metadata del scraper.
 * @param {string} key   - Clave (ej: 'pjn_ultima_auto')
 * @param {string} value - Valor a guardar
 */
function guardarMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO scraper_meta (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Actualiza el archivo_path de una notificación solo si actualmente es NULL.
 * Se usa en el backfill para completar PDFs faltantes sin pisar los existentes.
 * @param {string} numero       - Número de notificación
 * @param {string} archivo_path - Ruta absoluta al PDF descargado
 */
function actualizarArchivo(numero, archivo_path) {
  db.prepare('UPDATE notificaciones_pjn SET archivo_path = ? WHERE numero = ? AND archivo_path IS NULL')
    .run(archivo_path, numero);
}

// ── Helpers de fecha ──────────────────────────────────────────────────────────

/**
 * Convierte los formatos de fecha del portal PJN a ISO (YYYY-MM-DD).
 * Soporta: dd/mm/aaaa, "03 jun", "HH:MM" (hoy).
 * @param {string|null} str
 * @returns {string|null}
 */
function isoFecha(str) {
  if (!str) return null;
  const s = str.trim();

  // dd/mm/aaaa
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;

  // "03 jun", "28 may" — día + mes abreviado en español
  const m2 = s.match(/^(\d{1,2})\s+([a-záéíóú]{3})$/i);
  if (m2) {
    const mes = MESES_CORTO[m2[2].toLowerCase()];
    if (mes) {
      const anio = new Date().getFullYear();
      return `${anio}-${String(mes).padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
    }
  }

  // Solo hora "14:05" → la notificación es de hoy
  if (/^\d{1,2}:\d{2}$/.test(s)) return new Date().toISOString().slice(0, 10);

  return s;
}

/**
 * Separa el texto de expediente del PJN en número y carátula.
 * El portal los envía como "XXXX/2023 - Carátula del caso".
 * @param {string|null} texto
 * @returns {{ numero_expediente: string|null, caratula: string|null }}
 */
function parsearExpediente(texto) {
  if (!texto) return { numero_expediente: null, caratula: null };
  const idx = texto.indexOf(' - ');
  if (idx === -1) return { numero_expediente: texto.trim(), caratula: null };
  return {
    numero_expediente: texto.slice(0, idx).trim(),
    caratula:          texto.slice(idx + 3).trim(),
  };
}

// ── Helpers de Playwright ─────────────────────────────────────────────────────

/**
 * Espera a que la SPA del PJN termine de renderizar, detectando que el body
 * ya tiene contenido real (no el texto "Iniciando..." del splash).
 * @param {import('playwright').Page} page
 * @param {number} [timeout=30000]
 */
async function esperarSPA(page, timeout = 30000) {
  await page.waitForFunction(
    () => { const t = document.body?.innerText?.trim(); return t && t !== 'Iniciando...'; },
    { timeout }
  );
}

/**
 * Realiza el login SSO en sso.pjn.gov.ar con las credenciales del .env (PJN_USUARIO / PJN_CLAVE).
 * @param {import('playwright').Page} page - Página ya en el formulario SSO
 */
async function login(page) {
  console.log('  Esperando formulario SSO...');
  await page.waitForSelector('input[name="username"]', { timeout: 15000 });
  await page.fill('input[name="username"]', process.env.PJN_USUARIO);
  await page.fill('input[name="password"]', process.env.PJN_CLAVE);
  await page.click('input[type="submit"], #kc-login, button[type="submit"]');
  console.log('  Esperando redirección post-login...');
  await page.waitForURL('**/notif.pjn.gov.ar/recibidas**', { timeout: 30000 });
  console.log('  Login OK →', page.url());
}

/**
 * Configura la cantidad de resultados por página en el selector de Material UI.
 * Si el selector no aparece, continúa con el default.
 * @param {import('playwright').Page} page
 * @param {number} [cantidad=30]
 */
async function cambiarResultadosPorPagina(page, cantidad = 30) {
  const select = page.locator('select[aria-label*="Filas por página"]');
  if ((await select.count()) === 0) {
    console.log('  Selector de resultados por página no encontrado, usando default');
    return;
  }
  await select.selectOption(String(cantidad));
  await page.waitForFunction(() => !document.querySelector('table .MuiSkeleton-root'), { timeout: 30000 });
  console.log(`  Resultados por página: ${cantidad}`);
}

/**
 * Extrae las filas visibles de la tabla de notificaciones.
 * Espera a que los skeletons de carga de MUI desaparezcan antes de parsear.
 *
 * Estructura de columnas PJN: [0] icono | [1] número | [2] expediente | [3] autor | [4] destinatario | [5] fecha | [6][7] acciones
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ rowIndex: number, numero: string, expediente: string, autor: string, destinatario: string, fecha_envio: string }>>}
 */
async function extraerFilas(page) {
  await page.waitForFunction(
    () => !document.querySelector('table .MuiSkeleton-root'),
    { timeout: 30000 }
  );

  return page.evaluate(() => {
    const limpiar = s => s.replace(/\s+/g, ' ').trim();
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach((tr, index) => {
      const celdas = [...tr.querySelectorAll('td')].map(td => limpiar(td.innerText));
      if (celdas.length >= 6 && /^\d+$/.test(celdas[1].replace(/\s/g, ''))) {
        filas.push({
          rowIndex:     index,
          numero:       celdas[1].replace(/\s/g, ''),
          expediente:   celdas[2],
          autor:        celdas[3],
          destinatario: celdas[4],
          fecha_envio:  celdas[5],
        });
      }
    });
    return filas;
  });
}

/**
 * Descarga el PDF de una notificación haciendo click en el botón de la columna Acciones.
 * Si el archivo ya existe en disco, lo devuelve sin descargar.
 *
 * @param {import('playwright').Page} page
 * @param {number} rowIndex - Índice de la fila en tbody (para ubicar el botón correcto)
 * @param {string} numero   - Número de notificación (usado como nombre de archivo)
 * @returns {Promise<string|null>} Ruta absoluta al PDF o null si falló
 */
async function descargarAdjunto(page, rowIndex, numero) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const filePath = path.join(STORAGE_DIR, `${numero}.pdf`);
  if (fs.existsSync(filePath)) return filePath;

  try {
    const fila   = page.locator('table tbody tr').nth(rowIndex);
    const btnVer = fila.locator('button[aria-label*="PDF"]');

    if ((await btnVer.count()) === 0) {
      console.log(`  [!] Sin botón de descarga en fila ${rowIndex}`);
      return null;
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      btnVer.click(),
    ]);
    await download.saveAs(filePath);
    console.log(`  [PDF] ${numero} → ${path.basename(filePath)}`);
    return filePath;

  } catch (e) {
    console.log(`  [!] Descarga fallida para ${numero}: ${e.message}`);
    return null;
  }
}

// ── Paginación ────────────────────────────────────────────────────────────────

/**
 * Verifica si existe una página siguiente habilitada en el paginador.
 * Comprueba tanto el atributo `disabled` del botón como el rango "X–Y de Z" del texto.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function hayPaginaSiguiente(page) {
  const btn = page.locator(SELECTOR_SIGUIENTE);
  if ((await btn.count()) === 0) return false;

  const inhabilitado = await btn.evaluate(el => el.disabled || el.classList.contains('Mui-disabled'));
  if (inhabilitado) return false;

  const m = await page.evaluate(() =>
    document.body.innerText.match(/(\d+)[–\-](\d+)\s+de\s+(\d+)/)
  );
  if (m && parseInt(m[2]) >= parseInt(m[3])) return false;

  return true;
}

/**
 * Navega a la siguiente página del listado y espera que cargue.
 * @param {import('playwright').Page} page
 */
async function irAPaginaSiguiente(page) {
  await page.locator(SELECTOR_SIGUIENTE).click();
  await page.waitForFunction(() => !document.querySelector('table .MuiSkeleton-root'), { timeout: 30000 });
}

// ── Función principal exportable ──────────────────────────────────────────────

/**
 * Obtiene las notificaciones nuevas del portal PJN y las persiste en la base de datos.
 *
 * - Modo automático (limite = null): para al encontrar 3 duplicados consecutivos.
 * - Modo manual (limite > 0): procesa hasta `limite` filas sin parar por duplicados.
 *
 * @param {{ headless?: boolean, limite?: number|null }} [opts]
 * @returns {Promise<number>} Cantidad de notificaciones nuevas guardadas
 */
async function obtenerNotificacionesPJN({ headless = true, limite = null } = {}) {
  const modoAuto = limite === null;
  const MAX_DUPLICADOS_CONSECUTIVOS = 3;

  console.log('\n══ Scraper PJN ═══════════════════════════════════════════════');
  if (modoAuto) {
    console.log(`  Modo: automático (para al encontrar ${MAX_DUPLICADOS_CONSECUTIVOS} duplicados consecutivos)\n`);
  } else {
    console.log(`  Modo: manual — límite de ${limite} notificación(es)\n`);
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page    = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    console.log('1. Navegando al portal...');
    await page.goto(URL_NOTIFICACIONES, { waitUntil: 'load', timeout: 60000 });
    await esperarSPA(page);
    console.log('  URL:', page.url());

    if (page.url().includes('sso.pjn.gov.ar')) {
      console.log('\n2. Login requerido (SSO)...');
      await login(page);
      await esperarSPA(page, 60000);
    } else {
      console.log('  Sesión activa, sin necesidad de login');
    }

    console.log('\n3. Esperando carga de notificaciones...');
    await page.waitForSelector('table tbody tr', { timeout: 60000 });
    console.log('  Tabla cargada');
    await cambiarResultadosPorPagina(page, 30);

    console.log('\n4. Procesando notificaciones...');

    let pagina                 = 1;
    let nuevas                 = 0;
    let examinadas             = 0;
    let duplicadosConsecutivos = 0;
    let detener                = false;

    while (!detener) {
      console.log(`\n  ── Página ${pagina} ───────────────────────────────────────`);
      const filas = await extraerFilas(page);
      console.log(`  ${filas.length} fila(s) encontradas`);

      for (const fila of filas) {
        if (!fila.numero) continue;

        if (yaExiste(fila.numero)) {
          if (modoAuto) {
            duplicadosConsecutivos++;
            console.log(`  [--] ${fila.numero}  ya existe (${duplicadosConsecutivos}/${MAX_DUPLICADOS_CONSECUTIVOS})`);
            if (duplicadosConsecutivos >= MAX_DUPLICADOS_CONSECUTIVOS) {
              console.log(`  [>>] ${MAX_DUPLICADOS_CONSECUTIVOS} duplicados consecutivos → deteniendo`);
              detener = true;
              break;
            }
            continue;
          }
          console.log(`  [--] ${fila.numero}  ya existe`);
          examinadas++;
          if (examinadas >= limite) { detener = true; break; }
          continue;
        }

        duplicadosConsecutivos = 0;

        const fechaIso = isoFecha(fila.fecha_envio);
        if (fechaIso && fechaIso < FECHA_LIMITE) {
          console.log(`  [<<] ${fila.numero} (${fechaIso}) anterior al ${FECHA_LIMITE} → deteniendo`);
          detener = true;
          break;
        }

        const { numero_expediente, caratula } = parsearExpediente(fila.expediente);
        const archivo_path = await descargarAdjunto(page, fila.rowIndex, fila.numero);

        guardar({
          numero: fila.numero,
          numero_expediente,
          caratula,
          autor:       fila.autor || null,
          fecha_envio: isoFecha(fila.fecha_envio),
          archivo_path,
        });

        console.log(`  [OK] ${fila.numero}  ${numero_expediente ?? '-'}  ${fila.fecha_envio}`);
        nuevas++;
        examinadas++;

        if (limite !== null && examinadas >= limite) {
          console.log(`  Límite de ${limite} examinadas alcanzado`);
          detener = true;
          break;
        }
      }

      if (detener) break;
      if (!(await hayPaginaSiguiente(page))) break;
      console.log('  Navegando a página siguiente...');
      await irAPaginaSiguiente(page);
      pagina++;
    }

    const ahora = new Date().toISOString();
    if (modoAuto) guardarMeta('pjn_ultima_auto', ahora);

    console.log('\n══ Resultado ═════════════════════════════════════════════════');
    console.log(`  ${nuevas} nueva(s)`);
    if (modoAuto) console.log(`  Última actualización automática: ${ahora}`);
    return nuevas;

  } finally {
    await browser.close();
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────────

/**
 * Descarga los PDFs de notificaciones PJN que están en la base pero sin archivo.
 * Navega el portal buscando cada número pendiente por todas las páginas disponibles.
 *
 * @param {{ headless?: boolean }} [opts]
 * @returns {Promise<number>} Cantidad de PDFs descargados
 */
async function backfillAdjuntosPJN({ headless = true } = {}) {
  const pendientes = new Set(
    db.prepare('SELECT numero FROM notificaciones_pjn WHERE archivo_path IS NULL').all().map(r => r.numero)
  );

  if (pendientes.size === 0) {
    console.log('  Backfill PJN: sin notificaciones pendientes');
    return 0;
  }

  console.log(`\n══ Backfill PJN — ${pendientes.size} notificación(es) sin PDF ════`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page    = await context.newPage();
  page.setDefaultTimeout(45000);

  let descargados = 0;

  try {
    await page.goto(URL_NOTIFICACIONES, { waitUntil: 'load', timeout: 60000 });
    await esperarSPA(page);

    if (page.url().includes('sso.pjn.gov.ar')) await login(page);

    await page.waitForSelector('table tbody tr', { timeout: 30000 });
    await cambiarResultadosPorPagina(page, 30);

    let pagina = 1;

    while (pendientes.size > 0) {
      console.log(`\n  ── Página ${pagina} (quedan ${pendientes.size}) ───────────────`);
      const filas = await extraerFilas(page);

      for (const fila of filas) {
        if (!pendientes.has(fila.numero)) continue;

        const archivo_path = await descargarAdjunto(page, fila.rowIndex, fila.numero);
        if (archivo_path) {
          actualizarArchivo(fila.numero, archivo_path);
          descargados++;
        }
        pendientes.delete(fila.numero);
      }

      if (pendientes.size === 0) break;
      if (!(await hayPaginaSiguiente(page))) break;
      await irAPaginaSiguiente(page);
      pagina++;
    }

    if (pendientes.size > 0) {
      console.log(`\n  [!] No encontradas en portal: ${[...pendientes].join(', ')}`);
    }

  } finally {
    await browser.close();
  }

  console.log(`\n══ Backfill completo — ${descargados} PDF(s) descargado(s) ════`);
  return descargados;
}

module.exports = { obtenerNotificacionesPJN, backfillAdjuntosPJN };

// node pjn.js [--visible]
if (require.main === module) {
  const headless = !process.argv.includes('--visible');
  obtenerNotificacionesPJN({ headless }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
