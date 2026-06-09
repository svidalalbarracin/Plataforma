require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const URL_NOTIFICACIONES = 'https://notif.pjn.gov.ar/recibidas';
const STORAGE_DIR = path.join(__dirname, '../../storage/pjn/notificaciones');

// ── Helpers ───────────────────────────────────────────────────────────────────

function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_pjn WHERE numero = ?').get(numero);
}

function guardar({ numero, numero_expediente, caratula, autor, fecha_envio, archivo_path = null }) {
  db.prepare(`
    INSERT INTO notificaciones_pjn (numero, numero_expediente, caratula, autor, fecha_envio, archivo_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(numero, numero_expediente, caratula, autor, fecha_envio, archivo_path);
}

function guardarMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO scraper_meta (key, value) VALUES (?, ?)').run(key, value);
}

const MESES_CORTO = { ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12 };

function isoFecha(str) {
  if (!str) return null;
  const s = str.trim();

  // dd/mm/aaaa
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;

  // "03 jun", "28 may" — PJN usa día + mes abreviado en español
  const m2 = s.match(/^(\d{1,2})\s+([a-záéíóú]{3})$/i);
  if (m2) {
    const mes = MESES_CORTO[m2[2].toLowerCase()];
    if (mes) {
      const anio = new Date().getFullYear();
      return `${anio}-${String(mes).padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
    }
  }

  // Solo hora "14:05" → notificación de hoy
  if (/^\d{1,2}:\d{2}$/.test(s)) return new Date().toISOString().slice(0, 10);

  return s;
}

function parsearExpediente(texto) {
  if (!texto) return { numero_expediente: null, caratula: null };
  const idx = texto.indexOf(' - ');
  if (idx === -1) return { numero_expediente: texto.trim(), caratula: null };
  return {
    numero_expediente: texto.slice(0, idx).trim(),
    caratula:          texto.slice(idx + 3).trim(),
  };
}

// ── Esperar a que la SPA termine de renderizar ────────────────────────────────

async function esperarSPA(page, timeout = 30000) {
  await page.waitForFunction(
    () => { const t = document.body?.innerText?.trim(); return t && t !== 'Iniciando...'; },
    { timeout }
  );
}

// ── Login (SSO Keycloak en sso.pjn.gov.ar) ───────────────────────────────────

async function login(page) {
  console.log('  Esperando formulario SSO...');
  await page.waitForSelector('input[name="username"]', { timeout: 15000 });

  console.log('  Ingresando usuario...');
  await page.fill('input[name="username"]', process.env.PJN_USUARIO);

  console.log('  Ingresando contraseña...');
  await page.fill('input[name="password"]', process.env.PJN_CLAVE);

  await page.click('input[type="submit"], #kc-login, button[type="submit"]');

  console.log('  Esperando redirección post-login...');
  await page.waitForURL('**/notif.pjn.gov.ar/recibidas**', { timeout: 30000 });
  console.log('  Login OK →', page.url());
}

// ── Cambiar resultados por página ─────────────────────────────────────────────

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

// ── Extraer filas de la tabla ─────────────────────────────────────────────────

async function extraerFilas(page) {
  await page.waitForFunction(
    () => !document.querySelector('table .MuiSkeleton-root'),
    { timeout: 30000 }
  );

  return page.evaluate(() => {
    const limpiar = s => s.replace(/\s+/g, ' ').trim();
    const filas = [];

    // Estructura PJN (8 columnas):
    // [0] icono | [1] número | [2] expediente | [3] autor | [4] destinatario | [5] fecha | [6][7] acciones
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

// ── Descargar adjunto de una fila ─────────────────────────────────────────────

async function descargarAdjunto(page, rowIndex, numero) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const filePath = path.join(STORAGE_DIR, `${numero}.pdf`);
  if (fs.existsSync(filePath)) return filePath;

  try {
    const fila = page.locator('table tbody tr').nth(rowIndex);

    // Selectores para botón de descarga en MUI/React
    const selectores = [
      '[aria-label*="escargar"]',
      '[title*="escargar"]',
      '[aria-label*="ownload"]',
      'a[href*=".pdf"]',
    ];

    let clickTarget = null;
    for (const sel of selectores) {
      const el = fila.locator(sel);
      if ((await el.count()) > 0) { clickTarget = el.first(); break; }
    }

    if (!clickTarget) {
      // Fallback: último link o último botón de la fila
      const links = fila.locator('a');
      const btns  = fila.locator('button');
      const linkCount = await links.count();
      const btnCount  = await btns.count();
      if (linkCount > 0)       clickTarget = links.last();
      else if (btnCount > 0)   clickTarget = btns.last();
      else { console.log(`  [!] Sin botón de descarga en fila ${rowIndex}`); return null; }
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      clickTarget.click(),
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

const SELECTOR_SIGUIENTE = 'button[aria-label="Ir a la siguiente página del listado"]';

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

async function irAPaginaSiguiente(page) {
  await page.locator(SELECTOR_SIGUIENTE).click();
  await page.waitForFunction(() => !document.querySelector('table .MuiSkeleton-root'), { timeout: 30000 });
}

// ── Función principal exportable ──────────────────────────────────────────────

// limite: número máximo de filas a guardar (solo modo manual). null = modo automático.
// Modo automático: para al encontrar 3 notificaciones consecutivas ya registradas.
// Modo manual (limite != null): recorre hasta guardar `limite` filas sin parar por duplicados.
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
    } else {
      console.log('  Sesión activa, sin necesidad de login');
    }

    console.log('\n3. Esperando carga de notificaciones...');
    await page.waitForSelector('table tbody tr', { timeout: 30000 });
    console.log('  Tabla cargada');
    await cambiarResultadosPorPagina(page, 30);

    console.log('\n4. Procesando notificaciones...');

    let pagina                = 1;
    let nuevas                = 0;
    let examinadas            = 0;
    let duplicadosConsecutivos = 0;
    let detener               = false;

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

        // Notificación nueva: resetear contador y descargar adjunto
        duplicadosConsecutivos = 0;

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

module.exports = { obtenerNotificacionesPJN };

// Ejecución directa: node pjn.js
if (require.main === module) {
  obtenerNotificacionesPJN({ headless: false }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
