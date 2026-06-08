require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const db = require('../../../../core/database');

const URL_NOTIFICACIONES = 'https://notif.pjn.gov.ar/recibidas';

// ── Helpers ───────────────────────────────────────────────────────────────────

function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_pjn WHERE numero = ?').get(numero);
}

function guardar({ numero, numero_expediente, caratula, autor, destinatario, fecha_envio }) {
  db.prepare(`
    INSERT INTO notificaciones_pjn (numero, numero_expediente, caratula, autor, destinatario, fecha_envio)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(numero, numero_expediente, caratula, autor, destinatario, fecha_envio);
}

function isoFecha(str) {
  if (!str) return null;
  const [d, m, a] = str.trim().split('/');
  if (!d || !m || !a) return str.trim();
  return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
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

// ── Login ─────────────────────────────────────────────────────────────────────

async function login(page) {
  console.log('  Ingresando usuario...');
  await page.fill(
    'input[name="usuario"], input[id*="usuario"], input[placeholder*="suario"], input[type="text"]:first-of-type',
    process.env.PJN_USUARIO
  );
  console.log('  Ingresando contraseña...');
  await page.fill(
    'input[name="clave"], input[name="password"], input[id*="clave"], input[id*="password"], input[type="password"]',
    process.env.PJN_CLAVE
  );
  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForLoadState('load');

  if (!page.url().includes('recibidas')) {
    throw new Error(`Login fallido. URL actual: ${page.url()}`);
  }
  console.log('  Login OK');
}

// ── Cambiar resultados por página ─────────────────────────────────────────────

async function cambiarResultadosPorPagina(page, cantidad = 30) {
  const select = page.locator('select').filter({ hasText: /\b(10|20|30|50)\b/ }).first();
  if ((await select.count()) === 0) {
    console.log('  Selector de resultados por página no encontrado, usando default');
    return;
  }
  await select.selectOption(String(cantidad));
  await page.waitForLoadState('load');
  console.log(`  Resultados por página: ${cantidad}`);
}

// ── Extraer filas de la tabla ─────────────────────────────────────────────────

async function extraerFilas(page) {
  return page.evaluate(() => {
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
      // Al menos 5 columnas y la primera debe contener algún dígito (número de notif)
      if (celdas.length >= 5 && /\d/.test(celdas[0])) {
        filas.push({
          numero:       celdas[0],
          expediente:   celdas[1],
          autor:        celdas[2],
          destinatario: celdas[3],
          fecha_envio:  celdas[4],
        });
      }
    });
    return filas;
  });
}

// ── Paginación ────────────────────────────────────────────────────────────────

async function hayPaginaSiguiente(page) {
  const selector = [
    'a:has-text("Siguiente")',
    'a:has-text("siguiente")',
    'button:has-text("Siguiente")',
    'li.next:not(.disabled) a',
    '[aria-label="Next"]:not([disabled])',
    'a[rel="next"]',
  ].join(', ');
  return (await page.locator(selector).count()) > 0;
}

async function irAPaginaSiguiente(page) {
  const selector = [
    'a:has-text("Siguiente")',
    'a:has-text("siguiente")',
    'button:has-text("Siguiente")',
    'li.next:not(.disabled) a',
    '[aria-label="Next"]:not([disabled])',
    'a[rel="next"]',
  ].join(', ');
  await page.locator(selector).first().click();
  await page.waitForLoadState('load');
}

// ── Función principal exportable ──────────────────────────────────────────────

// limite: máximo de filas a examinar en total (útil para pruebas). null = sin límite.
async function obtenerNotificacionesPJN({ headless = true, limite = null } = {}) {
  console.log('\n══ Scraper PJN ═══════════════════════════════════════════════');
  if (limite) console.log(`  Modo prueba: límite de ${limite} notificación(es)\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page    = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    console.log('1. Navegando al portal...');
    await page.goto(URL_NOTIFICACIONES, { waitUntil: 'load', timeout: 60000 });
    console.log('  URL:', page.url());

    if (!page.url().includes('recibidas')) {
      console.log('\n2. Login requerido...');
      await login(page);
    } else {
      console.log('  Sesión activa, sin necesidad de login');
    }

    console.log('\n3. Configurando vista...');
    await cambiarResultadosPorPagina(page, 30);

    console.log('\n4. Procesando notificaciones...');

    let pagina     = 1;
    let nuevas     = 0;
    let omitidas   = 0;
    let examinadas = 0;
    let detener    = false;

    while (!detener) {
      console.log(`\n  ── Página ${pagina} ───────────────────────────────────────`);
      const filas = await extraerFilas(page);
      console.log(`  ${filas.length} fila(s) encontradas`);

      for (const fila of filas) {
        if (limite !== null && examinadas >= limite) { detener = true; break; }
        examinadas++;

        if (!fila.numero) continue;

        if (yaExiste(fila.numero)) {
          console.log(`  [--] ${fila.numero}  ya existe`);
          omitidas++;
          continue;
        }

        const { numero_expediente, caratula } = parsearExpediente(fila.expediente);
        guardar({
          numero: fila.numero,
          numero_expediente,
          caratula,
          autor:        fila.autor        || null,
          destinatario: fila.destinatario || null,
          fecha_envio:  isoFecha(fila.fecha_envio),
        });

        console.log(`  [OK] ${fila.numero}  ${numero_expediente ?? '-'}  ${fila.fecha_envio}`);
        nuevas++;
      }

      if (detener) break;
      if (!(await hayPaginaSiguiente(page))) break;
      console.log('  Navegando a página siguiente...');
      await irAPaginaSiguiente(page);
      pagina++;
    }

    console.log('\n══ Resultado ═════════════════════════════════════════════════');
    console.log(`  ${nuevas} nueva(s) · ${omitidas} ya existían`);
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
