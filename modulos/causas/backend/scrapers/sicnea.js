/**
 * Scraper de SICNEA — en reestructuración (agosto 2026).
 *
 * Se está reescribiendo desde cero, dividido en 3 partes. El código viejo
 * queda de referencia en sicnea.legacy.js (no se usa en la app) hasta que
 * esta reescritura esté completa, momento en el que ese archivo se borra.
 *
 * Mecánica de SICNEA que rige el diseño (confirmada por el usuario, 2026-08-06):
 * - Una notificación llega un día hábil y queda ESTADO=RECIBIDA, visible en
 *   el apartado "Ver notificaciones" del portal.
 * - Se notifica automáticamente a las 00:00 del lunes de la semana siguiente
 *   (pasa a ESTADO=NOTIFICADA y ahí es cuando corren los días hábiles).
 * - Abrir la notificación en "Ver notificaciones" ANTES de esa transición
 *   automática solo es seguro sábado o domingo — al ser días no hábiles, no
 *   cambia el ESTADO. Entre semana, abrirla SÍ cambiaría el ESTADO antes de
 *   tiempo. Por eso el scraper de esta sección solo puede correr fin de semana.
 * - Una vez NOTIFICADA, la notificación pasa al apartado "Consulta".
 *
 * Partes planeadas:
 * 1. Scraper de "Ver notificaciones" para SICNEA Abogados — SOLO sábado o
 *    domingo. (esto — por ahora solo hasta abrir el apartado, sin extraer nada)
 * 2. (a definir)
 * 3. (a definir)
 *
 * Ambos sistemas (SICNEA Abogados y SICNEA II — Gestión de Comunicación y
 * Notificación Electrónica Aduanera) son el mismo portal por dentro, así que
 * gran parte del código se comparte; se guardan en la misma tabla
 * notificaciones_sicnea, distinguidos por la columna `sistema`
 * ('abogados' | 'aduanero').
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
const { chromium } = require('playwright');

// ── Login AFIP ────────────────────────────────────────────────────────────────
// Igual que en sicnea.legacy.js — compartido por cualquier sistema SICNEA.

async function login(context) {
  const page = await context.newPage();
  await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('[id="F1:username"]', process.env.CUIT);
  await page.click('[id="F1:btnSiguiente"]');
  await page.waitForLoadState('networkidle');
  await page.fill('[id="F1:password"]', process.env.CLAVE_FISCAL);
  await page.click('[id="F1:btnIngresar"]');
  await page.waitForLoadState('networkidle');
  if (!page.url().includes('portalcf')) throw new Error(`Login fallido. URL: ${page.url()}`);
  return page;
}

// ── Apertura de SICNEA Abogados ──────────────────────────────────────────────
// Igual que en sicnea.legacy.js.
//
// Flujo:
//   ARCA portal → click "SICNEA Abogados"
//   → popup 1: mgenEntrada.aspx (página intermedia, se ignora)
//   → popup 2: mgenEntradaUsuarioExterno.aspx (ventana real, tiene botón "Ingresar")
//   → click "Ingresar" → carga el sistema principal de SICNEA

async function abrirSICNEAAbogados(context, portalPage) {
  const popups = [];
  context.on('page', p => popups.push(p));

  await portalPage.locator('text=SICNEA Abogados').first().click();

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (popups.length >= 2) break;
  }

  const sicneaPage = popups.find(p => !p.url().includes('mgenEntrada.aspx')) ?? popups[popups.length - 1];
  if (!sicneaPage) throw new Error('No se abrió la ventana principal de SICNEA');

  sicneaPage.setDefaultTimeout(120000);
  await sicneaPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});

  await new Promise(r => setTimeout(r, 3000));

  let btnIngresar = null;
  const selectorIngresar = 'input[value="Ingresar"], button:has-text("Ingresar"), input#cmdAceptar';

  for (const frame of sicneaPage.frames()) {
    try {
      const el = frame.locator(selectorIngresar).first();
      if (await el.count() > 0) { btnIngresar = el; break; }
    } catch (_) {}
  }

  if (!btnIngresar) throw new Error('No se encontró el botón "Ingresar"');
  await btnIngresar.click();

  await new Promise(r => setTimeout(r, 5000));
  await sicneaPage.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  return sicneaPage;
}

// ── Navegación sidebar → Ver notificaciones ──────────────────────────────────
//
// A diferencia de sicnea.legacy.js (que va a "Consulta" y explícitamente
// evita "Ver notificaciones"), esta parte hace lo opuesto a propósito: entra
// a "Ver notificaciones", que es donde están las notificaciones RECIBIDA
// (no vistas). Por eso el llamador (más abajo) exige que sea sábado o domingo
// antes de siquiera abrir el navegador.

async function irAVerNotificaciones(mainPage) {
  const selectorSidebar = 'aside, nav, [class*="sidebar"], [class*="menu"], [class*="nav"]';
  let hovereado = false;

  for (const ctx of [mainPage, ...mainPage.frames()]) {
    try {
      const el = ctx.locator(selectorSidebar).first();
      if (await el.count() > 0) { await el.hover({ timeout: 10000 }); hovereado = true; break; }
    } catch (_) {}
  }

  if (!hovereado) await mainPage.mouse.move(10, 300);
  await new Promise(r => setTimeout(r, 2000));

  let btnVerNotif = null;
  for (const ctx of [mainPage, ...mainPage.frames()]) {
    try {
      const candidatos = ctx.locator('a, button, li, span, td, div');
      const count = await candidatos.count();
      for (let i = 0; i < count; i++) {
        const el = candidatos.nth(i);
        const texto = (await el.innerText().catch(() => '')).trim();
        if (/ver.?notificaci/i.test(texto)) { btnVerNotif = el; break; }
      }
      if (btnVerNotif) break;
    } catch (_) {}
  }

  if (!btnVerNotif) throw new Error('No se encontró "Ver notificaciones" en el sidebar');

  await btnVerNotif.hover({ timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  await btnVerNotif.click();

  await new Promise(r => setTimeout(r, 5000));
  await mainPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
}

// ── Función principal (parte 1, hasta acá no más) ────────────────────────────

/**
 * Abre "Ver notificaciones" de SICNEA Abogados. No lee ni procesa nada
 * todavía — solo llega hasta tener el apartado abierto.
 *
 * Guard duro: solo puede correr sábado o domingo. Ver comentario de mecánica
 * al principio del archivo.
 */
async function abrirVerNotificacionesAbogados({ headless = true } = {}) {
  const dia = new Date().getDay();
  if (dia !== 6 && dia !== 0) {
    throw new Error('"Ver notificaciones" de SICNEA solo puede abrirse sábado o domingo (no cambia el ESTADO esos días).');
  }

  const paso = texto => {
    process.stdout.write(`  [SICNEA/ver-notif] ${texto}`.padEnd(60) + ' ');
    return () => process.stdout.write('OK!\n');
  };

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(120000);

  try {
    let ok = paso('Login AFIP...');
    const portalPage = await login(context);
    ok();

    ok = paso('Abriendo SICNEA Abogados...');
    const mainPage = await abrirSICNEAAbogados(context, portalPage);
    ok();

    ok = paso('Abriendo "Ver notificaciones"...');
    await irAVerNotificaciones(mainPage);
    ok();

    console.log('  [SICNEA/ver-notif] Apartado abierto. Acá termina la parte 1.');
    return mainPage;
  } finally {
    // Nada más que hacer todavía — se cierra el navegador al terminar esta parte.
    await browser.close();
  }
}

module.exports = { abrirVerNotificacionesAbogados };

// node sicnea.js [--visible]
if (require.main === module) {
  const args     = process.argv.slice(2);
  const headless = !args.includes('--visible');

  abrirVerNotificacionesAbogados({ headless }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
