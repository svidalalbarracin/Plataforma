require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const db = require('../../../../core/database');

// ── Helpers ───────────────────────────────────────────────────────────────────

function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_sicnea WHERE numero = ?').get(numero);
}

function guardar({ numero, aduana, dependencia, razon_social, motivo, documento_ref, fecha_alta, estado }) {
  db.prepare(`
    INSERT INTO notificaciones_sicnea (numero, aduana, dependencia, razon_social, motivo, documento_ref, fecha_alta, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(numero, aduana, dependencia, razon_social, motivo, documento_ref, fecha_alta, estado);
}

function guardarMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO scraper_meta (key, value) VALUES (?, ?)').run(key, value);
}

function isoFecha(str) {
  if (!str) return null;
  const s = str.trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s || null;
}

// Extrae el valor de un campo de un popup AFIP buscando etiquetas conocidas
// en tablas de dos columnas (label | valor)
function extraerCampo(texto, etiquetas) {
  for (const etiq of etiquetas) {
    const re = new RegExp(etiq + '[:\\s]*([^\\n\\r]{1,120})', 'i');
    const m = texto.match(re);
    if (m) return m[1].trim() || null;
  }
  return null;
}

// ── Login AFIP / Clave Fiscal ─────────────────────────────────────────────────

async function login(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  console.log('  Navegando a afip.gob.ar...');
  await page.goto('https://www.afip.gob.ar/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  let authPage;
  try {
    [authPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 20000 }),
      page.locator('a:has-text("Ingresar con Clave Fiscal"), a:has-text("ingresar")').first().click(),
    ]);
  } catch {
    console.log('  Fallback: navegando directo al login...');
    await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', { waitUntil: 'networkidle', timeout: 60000 });
    authPage = page;
  }

  authPage.setDefaultTimeout(60000);
  await authPage.waitForLoadState('networkidle');

  console.log('  Ingresando CUIT...');
  await authPage.fill('[id="F1:username"]', process.env.CUIT);
  await authPage.click('[id="F1:btnSiguiente"]');
  await authPage.waitForLoadState('networkidle');

  console.log('  Ingresando clave fiscal...');
  await authPage.fill('[id="F1:password"]', process.env.CLAVE_FISCAL);
  await authPage.click('[id="F1:btnIngresar"]');
  await authPage.waitForLoadState('networkidle');

  if (!authPage.url().includes('portalcf')) {
    throw new Error(`Login fallido. URL actual: ${authPage.url()}`);
  }
  console.log('  Login OK →', authPage.url());
  return authPage;
}

// ── Abrir SICNEA Abogados (abre popup desde el portal) ───────────────────────

async function abrirSICNEA(context, portalPage) {
  console.log('  Buscando "SICNEA Abogados" en el portal...');

  const [sicneaPopup] = await Promise.all([
    context.waitForEvent('page', { timeout: 30000 }),
    portalPage.locator('text=SICNEA Abogados').first().click(),
  ]);

  sicneaPopup.setDefaultTimeout(90000);
  await sicneaPopup.waitForLoadState('networkidle', { timeout: 90000 });
  console.log('  Popup SICNEA abierto:', sicneaPopup.url());
  return sicneaPopup;
}

// ── Ingresar con el usuario ───────────────────────────────────────────────────

async function ingresarConUsuario(context, sicneaPopup) {
  console.log('  Haciendo click en "Ingresar"...');

  // Puede abrir otro popup o navegar en el mismo
  let targetPage;
  try {
    [targetPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15000 }),
      sicneaPopup.locator('a:has-text("Ingresar"), button:has-text("Ingresar"), input[value*="ngresar"]').first().click(),
    ]);
    targetPage.setDefaultTimeout(90000);
    await targetPage.waitForLoadState('networkidle', { timeout: 90000 });
  } catch {
    // No abrió nuevo popup — navegó en la misma página
    await sicneaPopup.locator('a:has-text("Ingresar"), button:has-text("Ingresar"), input[value*="ngresar"]').first().click({ timeout: 30000 });
    await sicneaPopup.waitForLoadState('networkidle', { timeout: 90000 });
    targetPage = sicneaPopup;
  }

  console.log('  Dentro de SICNEA:', targetPage.url());
  return targetPage;
}

// ── Navegar a Consultas (hover sobre el menú) ─────────────────────────────────

async function irAConsultas(page) {
  console.log('  Abriendo menú...');

  // Pasar el mouse por encima del ítem de menú que contiene "Consultas"
  const menuContenedor = page.locator([
    'nav li:has(a:has-text("Consultas"))',
    'ul li:has(a:has-text("Consultas"))',
    '[class*="menu"] li:has(a:has-text("Consultas"))',
    'td:has(a:has-text("Consultas"))',
  ].join(', ')).first();

  if (await menuContenedor.count() > 0) {
    await menuContenedor.hover({ timeout: 15000 });
    await page.waitForTimeout(800);
  }

  console.log('  Haciendo click en "Consultas"...');
  await page.locator('a:has-text("Consultas")').first().click({ timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 90000 });
  console.log('  En Consultas:', page.url());
}

// ── Buscar con filtros vacíos ─────────────────────────────────────────────────

async function buscar(page) {
  console.log('  Ejecutando búsqueda con filtros vacíos...');

  await page.locator([
    'input[type="submit"][value*="uscar"]',
    'button:has-text("Buscar")',
    'input[value="Buscar"]',
    'a:has-text("Buscar")',
  ].join(', ')).first().click({ timeout: 30000 });

  // SICNEA es lento — esperar con timeout generoso
  await page.waitForLoadState('networkidle', { timeout: 120000 });
  console.log('  Búsqueda completada');
}

// ── Extraer filas visibles de la tabla ───────────────────────────────────────

async function extraerFilas(page) {
  await page.waitForSelector('table tbody tr', { timeout: 60000 });

  return page.evaluate(() => {
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
      // Necesitamos al menos número, motivo, fecha, estado; ignorar filas vacías/header
      if (celdas.length >= 4 && celdas[0]) {
        filas.push({
          numero:      celdas[0],
          motivo:      celdas[1] || null,
          fecha_notif: celdas[2] || null,
          estado:      celdas[3] || null,
        });
      }
    });
    return filas;
  });
}

// ── Extraer detalle desde el popup "Ver" ─────────────────────────────────────

async function extraerDetalle(page, context, numero) {
  // Buscar el botón/link "Ver" en la fila que corresponde al número
  const verBtn = page.locator([
    `tr:has-text("${numero}") a:has-text("Ver")`,
    `tr:has-text("${numero}") button:has-text("Ver")`,
    `tr:has-text("${numero}") input[value="Ver"]`,
  ].join(', ')).first();

  let detallePage;
  let esPopup = false;

  try {
    [detallePage] = await Promise.all([
      context.waitForEvent('page', { timeout: 20000 }),
      verBtn.click(),
    ]);
    esPopup = true;
    detallePage.setDefaultTimeout(90000);
    await detallePage.waitForLoadState('networkidle', { timeout: 90000 });
  } catch {
    // No abrió popup — puede navegar en la misma página
    await verBtn.click({ timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 90000 });
    detallePage = page;
  }

  const texto = await detallePage.evaluate(() => document.body.innerText);

  const detalle = {
    numero:       extraerCampoLocal('número|numero|nro\\.?\\s*notif', texto),
    aduana:       extraerCampoLocal('aduana', texto),
    dependencia:  extraerCampoLocal('dependencia', texto),
    razon_social: extraerCampoLocal('razón social|razon social|denominación|razón', texto),
    motivo:       extraerCampoLocal('motivo', texto),
    documento_ref:extraerCampoLocal('documento ref|doc\\.?\\s*ref|documento', texto),
    fecha_alta:   extraerCampoLocal('fecha de alta|fecha alta', texto),
    estado:       extraerCampoLocal('estado', texto),
  };

  function extraerCampoLocal(patron, txt) {
    const re = new RegExp('(?:' + patron + ')[:\\s]+([^\\n\\r]{1,120})', 'i');
    const m = txt.match(re);
    return m ? m[1].trim() || null : null;
  }

  if (esPopup) {
    await detallePage.close();
  }

  return detalle;
}

// ── Paginación ────────────────────────────────────────────────────────────────

const SELECTOR_SIGUIENTE_SICNEA = [
  'a:has-text("Siguiente")',
  'button:has-text("Siguiente")',
  'input[value="Siguiente"]',
  'a[rel="next"]',
].join(', ');

async function hayPaginaSiguiente(page) {
  const btn = page.locator(SELECTOR_SIGUIENTE_SICNEA);
  if ((await btn.count()) === 0) return false;
  const inhabilitado = await btn.first().evaluate(el =>
    el.disabled ||
    el.classList.contains('disabled') ||
    el.getAttribute('disabled') !== null
  ).catch(() => false);
  return !inhabilitado;
}

async function irAPaginaSiguiente(page) {
  await page.locator(SELECTOR_SIGUIENTE_SICNEA).first().click({ timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 120000 });
}

// ── Función principal exportable ──────────────────────────────────────────────

async function obtenerNotificacionesSICNEA({ headless = true, limite = null } = {}) {
  const modoAuto = limite === null;

  console.log('\n══ Scraper SICNEA ════════════════════════════════════════════');
  if (modoAuto) {
    console.log('  Modo: automático (para al encontrar la última registrada)\n');
  } else {
    console.log(`  Modo: manual — límite de ${limite} notificación(es)\n`);
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  context.setDefaultTimeout(90000);

  try {
    console.log('1. Login en ARCA...');
    const portalPage = await login(context);

    console.log('\n2. Abriendo SICNEA Abogados...');
    const sicneaPopup = await abrirSICNEA(context, portalPage);

    console.log('\n3. Ingresando con el usuario...');
    const sicneaPage = await ingresarConUsuario(context, sicneaPopup);

    console.log('\n4. Navegando a Consultas...');
    await irAConsultas(sicneaPage);

    console.log('\n5. Buscando notificaciones...');
    await buscar(sicneaPage);

    console.log('\n6. Procesando notificaciones...');

    let pagina    = 1;
    let nuevas    = 0;
    let examinadas = 0;
    let detener   = false;

    while (!detener) {
      console.log(`\n  ── Página ${pagina} ───────────────────────────────────────`);
      const filas = await extraerFilas(sicneaPage);
      console.log(`  ${filas.length} fila(s) encontradas`);

      for (const fila of filas) {
        const numero = fila.numero?.trim();
        if (!numero) continue;

        if (yaExiste(numero)) {
          if (modoAuto) {
            console.log(`  [>>] ${numero}  última registrada → deteniendo`);
            detener = true;
            break;
          }
          console.log(`  [--] ${numero}  ya existe`);
          examinadas++;
          if (examinadas >= limite) { detener = true; break; }
          continue;
        }

        console.log(`  [→]  ${numero}  abriendo detalle...`);
        let detalle = {};
        try {
          detalle = await extraerDetalle(sicneaPage, context, numero);
        } catch (e) {
          console.warn(`  [warn] No se pudo obtener detalle de ${numero}: ${e.message}`);
        }

        guardar({
          numero,
          aduana:        detalle.aduana        || null,
          dependencia:   detalle.dependencia   || null,
          razon_social:  detalle.razon_social  || null,
          motivo:        detalle.motivo        || fila.motivo || null,
          documento_ref: detalle.documento_ref || null,
          fecha_alta:    isoFecha(detalle.fecha_alta),
          estado:        detalle.estado        || fila.estado || null,
        });

        console.log(`  [OK] ${numero}  ${detalle.aduana ?? '-'}  ${fila.fecha_notif ?? '-'}`);
        nuevas++;
        examinadas++;

        if (!modoAuto && examinadas >= limite) {
          console.log(`  Límite de ${limite} examinadas alcanzado`);
          detener = true;
          break;
        }
      }

      if (detener) break;
      if (!(await hayPaginaSiguiente(sicneaPage))) break;
      console.log('  Navegando a página siguiente...');
      await irAPaginaSiguiente(sicneaPage);
      pagina++;
    }

    const ahora = new Date().toISOString();
    if (modoAuto) guardarMeta('sicnea_ultima_auto', ahora);

    console.log('\n══ Resultado ═════════════════════════════════════════════════');
    console.log(`  ${nuevas} nueva(s)`);
    if (modoAuto) console.log(`  Última actualización automática: ${ahora}`);
    return nuevas;

  } finally {
    await browser.close();
  }
}

module.exports = { obtenerNotificacionesSICNEA };

// Ejecución directa: node sicnea.js
if (require.main === module) {
  obtenerNotificacionesSICNEA({ headless: false }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
