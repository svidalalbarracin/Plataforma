require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const db = require('../../../../core/database');

// ── Helpers ───────────────────────────────────────────────────────────────────

function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_sicnea WHERE numero = ?').get(numero);
}

function guardar({ numero, cuit, razon_social, motivo, fecha_envio, fecha_vencimiento }) {
  db.prepare(`
    INSERT INTO notificaciones_sicnea
      (numero, aduana, dependencia, razon_social, motivo, documento_ref, fecha_alta, fecha_vencimiento, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NOTIFICADA')
  `).run(numero, null, null, razon_social, motivo, cuit, fecha_envio, fecha_vencimiento);
}

function guardarMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO scraper_meta (key, value) VALUES (?, ?)').run(key, value);
}

function isoFecha(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return str.trim() || null;
}

// ── Login AFIP ────────────────────────────────────────────────────────────────

async function login(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('[id="F1:username"]', process.env.CUIT);
  await page.click('[id="F1:btnSiguiente"]');
  await page.waitForLoadState('networkidle');
  await page.fill('[id="F1:password"]', process.env.CLAVE_FISCAL);
  await page.click('[id="F1:btnIngresar"]');
  await page.waitForLoadState('networkidle');
  if (!page.url().includes('portalcf')) throw new Error(`Login fallido. URL: ${page.url()}`);
  console.log('  Login OK');
  return page;
}

// ── Abrir SICNEA y llegar al frameset principal ───────────────────────────────

async function abrirSICNEA(context, portalPage) {
  const popups = [];
  context.on('page', p => popups.push(p));

  await portalPage.locator('text=SICNEA Abogados').first().click();
  await new Promise(r => setTimeout(r, 10000));

  // El segundo popup es mgenEntradaUsuarioExterno.aspx (abierto automáticamente)
  const usuarioPage = popups.find(p => p.url().includes('UsuarioExterno')) ?? popups[popups.length - 1];
  if (!usuarioPage) throw new Error('No se abrió popup de SICNEA');

  usuarioPage.setDefaultTimeout(120000);
  await usuarioPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  console.log('  Popup:', usuarioPage.url());

  await usuarioPage.click('input#cmdAceptar');
  await new Promise(r => setTimeout(r, 5000));
  await usuarioPage.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  console.log('  Frameset cargado');

  return usuarioPage;
}

// ── Navegar a Bandeja de Entrada ──────────────────────────────────────────────

async function irABandeja(mainPage) {
  const inicioFrame = mainPage.frames().find(f => f.url().includes('mgenInicioGen') || f.url().includes('mgenMarcoPpal'));
  if (!inicioFrame) throw new Error('No se encontró frame de contenido');

  const url = 'https://serviciosadu2.afip.gob.ar/DIAV2/Sicnea.Web/Sicnea.WebApp/formularios/csicneaAboBandejaEntrada.aspx';
  const resp = await inicioFrame.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  if (!resp || resp.status() >= 400) throw new Error(`BandejaEntrada devolvió status ${resp?.status()}`);
  console.log('  Bandeja cargada:', inicioFrame.url());
  return inicioFrame;
}

// ── Extraer filas de la tabla ─────────────────────────────────────────────────

async function extraerFilas(frame) {
  // Esperar que la tabla tenga al menos una fila de datos
  await frame.waitForSelector('table tbody tr', { timeout: 30000 }).catch(() => {});

  return frame.evaluate(() => {
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim());
      // Columnas: [0]=numero [1]=cuit [2]=razon_social [3]=motivo [4]=enviada [5]=notif_auto [6]=vencimiento [7]=Ver
      // Solo incluir notificaciones con estado NOTIFICADO (vencimiento ya pasó)
      if (celdas.length >= 7 && /^\d{5}NOTI/i.test(celdas[0])) {
        filas.push({
          numero:             celdas[0],
          cuit:               celdas[1] || null,
          razon_social:       celdas[2] || null,
          motivo:             celdas[3] || null,
          fecha_envio:        celdas[4] || null,
          notif_auto:         celdas[5] || null,
          fecha_vencimiento:  celdas[6] || null,
        });
      }
    });
    return filas;
  });
}

// ── Paginación ────────────────────────────────────────────────────────────────

async function hayPaginaSiguiente(frame) {
  const info = await frame.evaluate(() => {
    const pagina = parseInt(document.getElementById('txtNroPagina')?.value, 10);
    const total  = parseInt(document.getElementById('txtCantPaginas')?.value, 10);
    if (!pagina || !total || isNaN(pagina) || isNaN(total)) return null;
    return { pagina, total };
  });
  if (!info || info.pagina >= info.total) return false;
  // Verificar que el botón siguiente existe y está habilitado
  const btn = frame.locator('input[name="btnSiguiente"], input[value="Siguiente"], a:has-text("Siguiente")').first();
  if (await btn.count() === 0) return false;
  const disabled = await btn.evaluate(el => el.disabled || el.classList.contains('disabled')).catch(() => true);
  return !disabled;
}

async function irAPaginaSiguiente(frame) {
  // SICNEA usa PostBack vía hidden field txtNroPagina
  await frame.evaluate(() => {
    const n = document.getElementById('txtNroPagina');
    if (n) n.value = String(parseInt(n.value, 10) + 1);
  });
  const btn = frame.locator('input[name="btnSiguiente"], input[value="Siguiente"], a:has-text("Siguiente")').first();
  await btn.click({ timeout: 30000 });
  await frame.waitForLoadState('networkidle', { timeout: 120000 });
}

// ── Función principal exportable ──────────────────────────────────────────────

async function obtenerNotificacionesSICNEA({ headless = true, limite = null } = {}) {
  const modoAuto = limite === null;

  console.log('\n══ Scraper SICNEA ════════════════════════════════════════════');
  console.log(modoAuto
    ? '  Modo: automático (para al encontrar la última registrada)'
    : `  Modo: manual — límite de ${limite} notificación(es)`
  );

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  context.setDefaultTimeout(120000);

  try {
    console.log('\n1. Login ARCA...');
    const portalPage = await login(context);

    console.log('\n2. Abriendo SICNEA...');
    const mainPage = await abrirSICNEA(context, portalPage);

    console.log('\n3. Navegando a Bandeja de Entrada...');
    const bandejaFrame = await irABandeja(mainPage);

    console.log('\n4. Procesando notificaciones...');
    let pagina    = 1;
    let nuevas    = 0;
    let examinadas = 0;
    let detener   = false;

    while (!detener) {
      console.log(`\n  ── Página ${pagina} ──────────────────────────────────────`);
      const filas = await extraerFilas(bandejaFrame);
      console.log(`  ${filas.length} fila(s) encontradas`);

      if (filas.length === 0) break;

      for (const fila of filas) {
        const numero = fila.numero?.trim();
        if (!numero) continue;

        // Solo procesar notificaciones ya notificadas (vencimiento pasado o con fecha auto)
        const venc = isoFecha(fila.fecha_vencimiento);
        const hoy  = new Date().toISOString().slice(0, 10);
        if (!fila.notif_auto && (!venc || venc >= hoy)) {
          console.log(`  [>>] ${numero}  ENVIADA (vence ${venc}) → ignorando`);
          continue;
        }

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

        guardar({
          numero,
          cuit:              fila.cuit,
          razon_social:      fila.razon_social,
          motivo:            fila.motivo,
          fecha_envio:       isoFecha(fila.fecha_envio),
          fecha_vencimiento: isoFecha(fila.fecha_vencimiento),
        });

        console.log(`  [OK] ${numero}  ${fila.razon_social ?? '-'}  ${fila.fecha_envio ?? '-'}`);
        nuevas++;
        examinadas++;

        if (!modoAuto && examinadas >= limite) {
          console.log(`  Límite de ${limite} examinadas alcanzado`);
          detener = true;
          break;
        }
      }

      if (detener) break;
      if (!(await hayPaginaSiguiente(bandejaFrame))) break;
      console.log('  Navegando a página siguiente...');
      await irAPaginaSiguiente(bandejaFrame);
      pagina++;
    }

    const ahora = new Date().toISOString();
    if (modoAuto) guardarMeta('sicnea_ultima_auto', ahora);

    console.log('\n══ Resultado ═════════════════════════════════════════════════');
    console.log(`  ${nuevas} nueva(s)`);
    return nuevas;

  } finally {
    await browser.close();
  }
}

module.exports = { obtenerNotificacionesSICNEA };

if (require.main === module) {
  obtenerNotificacionesSICNEA({ headless: true }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
