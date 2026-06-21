require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const STORAGE_DIR = path.join(__dirname, '../../storage/sicnea');

// ── DB helpers ────────────────────────────────────────────────────────────────

function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_sicnea WHERE numero = ?').get(numero);
}

function guardar({ numero, dependencia, cuit_cliente, razon_social, aduana, motivo,
                   documento_ref, fecha_alta, estado, archivos_paths = [] }) {
  db.prepare(`
    INSERT INTO notificaciones_sicnea
      (numero, dependencia, cuit_cliente, razon_social, aduana, motivo,
       documento_ref, fecha_alta, estado, archivos_paths)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(numero, dependencia, cuit_cliente, razon_social, aduana, motivo,
         documento_ref, fecha_alta, estado, JSON.stringify(archivos_paths));
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
  await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('[id="F1:username"]', process.env.CUIT);
  await page.click('[id="F1:btnSiguiente"]');
  await page.waitForLoadState('networkidle');
  await page.fill('[id="F1:password"]', process.env.CLAVE_FISCAL);
  await page.click('[id="F1:btnIngresar"]');
  await page.waitForLoadState('networkidle');
  if (!page.url().includes('portalcf')) throw new Error(`Login fallido. URL: ${page.url()}`);
  console.log('  Login OK →', page.url());
  return page;
}

// ── Apertura de SICNEA ────────────────────────────────────────────────────────

// Flujo:
//   ARCA portal → click "SICNEA Abogados"
//   → popup 1: mgenEntrada.aspx (página intermedia, se ignora)
//   → popup 2: mgenEntradaUsuarioExterno.aspx (ventana real, tiene botón "Ingresar")
//   → click "Ingresar" → carga el sistema principal de SICNEA

async function abrirSICNEA(context, portalPage) {
  const popups = [];
  context.on('page', p => popups.push(p));

  await portalPage.locator('text=SICNEA Abogados').first().click();
  console.log('  Click en SICNEA, esperando ventanas...');

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (popups.length >= 2) break;
    console.log(`  Esperando segunda ventana... (${popups.length} abierta(s))`);
  }

  console.log(`  Ventanas abiertas: ${popups.length}`);
  popups.forEach((p, i) => console.log(`    [${i}] ${p.url()}`));

  const sicneaPage = popups.find(p => !p.url().includes('mgenEntrada.aspx')) ?? popups[popups.length - 1];
  if (!sicneaPage) throw new Error('No se abrió la ventana principal de SICNEA');

  sicneaPage.setDefaultTimeout(120000);
  await sicneaPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  console.log('  Ventana SICNEA:', sicneaPage.url());

  await new Promise(r => setTimeout(r, 3000));

  // Buscar "Ingresar" en todos los frames del popup
  let btnIngresar = null;
  const selectorIngresar = 'input[value="Ingresar"], button:has-text("Ingresar"), input#cmdAceptar';

  for (const frame of sicneaPage.frames()) {
    try {
      const el = frame.locator(selectorIngresar).first();
      if (await el.count() > 0) {
        btnIngresar = el;
        console.log('  Botón "Ingresar" en frame:', frame.url());
        break;
      }
    } catch (_) {}
  }

  if (!btnIngresar) throw new Error('No se encontró el botón "Ingresar"');
  await btnIngresar.click();
  console.log('  "Ingresar" clickeado, esperando...');

  await new Promise(r => setTimeout(r, 5000));
  await sicneaPage.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  console.log('  SICNEA cargado');
  return sicneaPage;
}

// ── Navegación sidebar → Consultas → Buscar ──────────────────────────────────

// Flujo dentro del sistema SICNEA:
//   Hover sobre sidebar → click "Consulta/Consultas" (no "Ver Notificaciones")
//   → esperar que cargue el apartado → click "Buscar"
//   → esperar tabla de notificaciones

async function irAConsulta(mainPage) {
  console.log('  Abriendo sidebar...');

  // El sidebar se despliega al pasar el mouse encima
  const selectorSidebar = 'aside, nav, [class*="sidebar"], [class*="menu"], [class*="nav"]';
  let hovereado = false;

  for (const ctx of [mainPage, ...mainPage.frames()]) {
    try {
      const el = ctx.locator(selectorSidebar).first();
      if (await el.count() > 0) {
        await el.hover({ timeout: 10000 });
        hovereado = true;
        break;
      }
    } catch (_) {}
  }

  if (!hovereado) await mainPage.mouse.move(10, 300);
  await new Promise(r => setTimeout(r, 2000));

  // Buscar ítem "Consulta" o "Consultas" en todos los frames, excluyendo "Ver Notificaciones"
  let btnConsulta = null;

  for (const ctx of [mainPage, ...mainPage.frames()]) {
    try {
      const candidatos = ctx.locator('a, button, li, span, td, div');
      const count = await candidatos.count();
      for (let i = 0; i < count; i++) {
        const el = candidatos.nth(i);
        const texto = (await el.innerText().catch(() => '')).trim();
        if (/^consulta/i.test(texto) && !/ver.?notificaci/i.test(texto)) {
          btnConsulta = el;
          console.log(`  Ítem encontrado: "${texto}"`);
          break;
        }
      }
      if (btnConsulta) break;
    } catch (_) {}
  }

  if (!btnConsulta) throw new Error('No se encontró "Consulta/Consultas" en el sidebar');

  await btnConsulta.hover({ timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  await btnConsulta.click();
  console.log('  "Consulta" clickeado, esperando apartado...');

  // Esperar a que cargue el frame de consulta (csicneaAboConsulta.aspx)
  await new Promise(r => setTimeout(r, 5000));
  await mainPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

  // Buscar "Buscar" específicamente en el frame de consulta
  const frameConsulta = mainPage.frames().find(f => f.url().includes('Consulta'));
  if (!frameConsulta) throw new Error('No se encontró el frame csicneaAboConsulta');
  console.log('  Frame consulta:', frameConsulta.url());

  const btnBuscar = frameConsulta.locator('input[value="Buscar"], button:has-text("Buscar")').first();
  await btnBuscar.waitFor({ timeout: 15000 });
  await btnBuscar.click();
  console.log('  "Buscar" clickeado, esperando resultados...');

  // Esperar a que los resultados carguen — el sistema es lento, puede tardar bastante
  // El formulario de búsqueda ya tiene ~8 filas de layout; esperamos que aparezcan muchas más
  process.stdout.write('  Esperando resultados');
  let intentos = 0;
  while (intentos < 30) {
    await new Promise(r => setTimeout(r, 4000));
    const filas = await frameConsulta.evaluate(() => {
      const tablas = [...document.querySelectorAll('table')];
      return Math.max(...tablas.map(t => t.querySelectorAll('tbody tr').length), 0);
    }).catch(() => 0);
    process.stdout.write('.');
    intentos++;
    if (filas >= 20) break;
  }
  process.stdout.write('\n');

  // Verificar que dgdNotificacion esté en el frame de consulta
  const tieneTabla = await frameConsulta.evaluate(
    () => !!document.getElementById('dgdNotificacion')
  ).catch(() => false);

  if (!tieneTabla) throw new Error('No se encontró la tabla dgdNotificacion');

  console.log('  Tabla "dgdNotificacion" cargada');
  return frameConsulta;
}

// ── Extracción de datos ───────────────────────────────────────────────────────

async function extraerFilas(ctx) {
  return ctx.evaluate(() => {
    const limpiar = s => s?.replace(/\s+/g, ' ').trim() || null;
    const filas = [];
    const table = document.getElementById('dgdNotificacion');
    if (!table) return filas;

    table.querySelectorAll('tbody tr').forEach((tr, index) => {
      const celdas = [...tr.querySelectorAll('td')].map(td => limpiar(td.innerText));
      if (celdas.length >= 5 && celdas[0] && /\d/.test(celdas[0])) {
        const tieneVer = [...tr.querySelectorAll('td')].some(td =>
          td.innerText.trim() === 'Ver' ||
          !!td.querySelector('a, button, input[type=button], input[type=submit], input[value="Ver"]')
        );
        filas.push({
          rowIndex:     index,
          numero:       celdas[0],
          cuit:         celdas[1],
          razon_social: celdas[2],
          motivo:       celdas[3],
          fecha_envio:  celdas[4],
          vencimiento:  celdas[5],
          tieneVer,
        });
      }
    });
    return filas;
  });
}

// "Ver" abre un popup con el detalle — capturamos esa nueva ventana
async function abrirDetalle(context, ctx, rowIndex) {
  const filas  = ctx.locator('table#dgdNotificacion tbody tr');
  const fila   = filas.nth(rowIndex);
  const btnVer = fila.locator('a, button, input[type=button], input[type=submit], input[value="Ver"], :text("Ver")').first();
  if ((await btnVer.count()) === 0) return null;

  const popupPromise = context.waitForEvent('page', { timeout: 30000 });
  await btnVer.click();
  const detallePage = await popupPromise;
  detallePage.setDefaultTimeout(60000);
  await detallePage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await detallePage.waitForSelector('input#txtNroCedula', { timeout: 30000 });
  console.log(`    [detalle] ${detallePage.url()}`);
  return detallePage;
}

async function extraerDetalle(ctx) {
  return ctx.evaluate(() => {
    const val = id => document.getElementById(id)?.value?.trim() || null;
    return {
      numero:        val('txtNroCedula'),
      dependencia:   val('txtDependencia'),
      cuit_cliente:  val('txtCuit'),
      razon_social:  val('txtRazonSocial'),
      aduana:        val('txtDesAduana'),
      motivo:        val('txtMotivo'),
      documento_ref: val('txtNroExpediente'),
      fecha_alta:    val('txtFechaNotificacion'),
      estado:        val('txtEstado'),
    };
  });
}

async function descargarAdjuntos(context, ctx, numero) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const archivos = [];

  // PDF de la notificación en sí (botón "Imprimir" dentro del detalle)
  const notifPath = path.join(STORAGE_DIR, `${numero}_notif.pdf`);
  if (!fs.existsSync(notifPath)) {
    try {
      const btnImprimir = ctx.locator('input[value="Imprimir"], button:has-text("Imprimir")').first();
      if (await btnImprimir.count() > 0) {
        const downloadPromise = context.waitForEvent('download', { timeout: 60000 });
        await btnImprimir.click();
        const download = await downloadPromise;
        await download.saveAs(notifPath);
        archivos.push(notifPath);
        console.log(`    [PDF] notificación → ${path.basename(notifPath)}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.log(`    [!] PDF notificación no descargado (${e.message.split('\n')[0].substring(0, 80)})`);
    }
  } else {
    archivos.push(notifPath);
  }

  const archivosLista = await ctx.evaluate(() => {
    const tabla = document.getElementById('dgdArchivoAdjuntos');
    if (!tabla) return [];
    return [...tabla.querySelectorAll('tbody tr')].map(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(c => c.innerText.trim());
      return { orden: celdas[0], nombre: celdas[1] };
    }).filter(r => r.nombre && r.nombre.length > 0);
  });

  if (archivosLista.length === 0) return archivos;

  for (let i = 0; i < archivosLista.length; i++) {
    const nombreOriginal = archivosLista[i].nombre;
    const filePath = path.join(STORAGE_DIR, `${numero}_${i + 1}.pdf`);
    if (fs.existsSync(filePath)) { archivos.push(filePath); continue; }

    try {
      const downloadPromise = context.waitForEvent('download', { timeout: 60000 });
      await ctx.locator('table#dgdArchivoAdjuntos a:has-text("Ver")').nth(i).click();
      const download = await downloadPromise;
      await download.saveAs(filePath);
      archivos.push(filePath);
      console.log(`    [PDF] ${nombreOriginal} → ${path.basename(filePath)}`);
      await ctx.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.log(`    [!] ${nombreOriginal} no descargado (${e.message.split('\n')[0].substring(0, 80)})`);
    }
  }
  return archivos;
}

// ── Función principal ─────────────────────────────────────────────────────────

async function obtenerNotificacionesSICNEA({ headless = true, limite = null } = {}) {
  const modoAuto = limite === null;

  console.log('\n══ Scraper SICNEA ════════════════════════════════════════════');
  console.log(modoAuto
    ? '  Modo: automático'
    : `  Modo: prueba — límite ${limite}`
  );

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(120000);

  let nuevas = 0;

  try {
    console.log('\n1. Login AFIP...');
    const portalPage = await login(context);

    console.log('\n2. Abriendo SICNEA...');
    const mainPage = await abrirSICNEA(context, portalPage);

    console.log('\n3. Navegando a Consultas...');
    const consultaCtx = await irAConsulta(mainPage);

    console.log('\n4. Procesando notificaciones...');

    const filas = await extraerFilas(consultaCtx);
    const conVer = filas.filter(f => f.tieneVer).length;
    console.log(`  ${filas.length} fila(s) encontradas (${conVer} con botón Ver)`);

    let examinadas = 0;
    let duplicadosConsecutivos = 0;
    for (const fila of filas) {
      const numero = fila.numero?.trim();
      if (!numero) continue;

      if (yaExiste(numero)) {
        if (modoAuto) {
          duplicadosConsecutivos++;
          console.log(`  [>>] ${numero} ya existe (${duplicadosConsecutivos}/2)`);
          if (duplicadosConsecutivos >= 2) break;
          examinadas++;
          continue;
        }
        console.log(`  [--] ${numero} ya existe`);
        examinadas++;
        if (limite && examinadas >= limite) break;
        continue;
      }

      duplicadosConsecutivos = 0;

      let detalleDatos  = {};
      let archivosPaths = [];
      if (fila.tieneVer) {
        const detallePage = await abrirDetalle(context, consultaCtx, fila.rowIndex);
        if (detallePage) {
          detalleDatos  = await extraerDetalle(detallePage);
          archivosPaths = await descargarAdjuntos(context, detallePage, numero);
          await detallePage.close();
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      guardar({
        numero,
        dependencia:    detalleDatos.dependencia   || null,
        cuit_cliente:   detalleDatos.cuit_cliente  || fila.cuit || null,
        razon_social:   detalleDatos.razon_social  || fila.razon_social || null,
        aduana:         detalleDatos.aduana        || null,
        motivo:         detalleDatos.motivo        || fila.motivo || null,
        documento_ref:  detalleDatos.documento_ref || null,
        fecha_alta:     isoFecha(detalleDatos.fecha_alta) || isoFecha(fila.fecha_envio),
        estado:         detalleDatos.estado        || null,
        archivos_paths: archivosPaths,
      });

      console.log(`  [OK] ${numero}  ${detalleDatos.motivo || ''}  ${detalleDatos.fecha_alta || ''}`);
      nuevas++;
      examinadas++;

      if (limite && examinadas >= limite) {
        console.log(`  Límite de ${limite} alcanzado`);
        break;
      }
    }

    if (modoAuto) guardarMeta('sicnea_ultima_auto', new Date().toISOString());

    console.log('\n══ Resultado ═════════════════════════════════════════════════');
    console.log(`  ${nuevas} nueva(s)`);
    return nuevas;

  } finally {
    await browser.close();
  }
}

module.exports = { obtenerNotificacionesSICNEA };

// node sicnea.js [--visible] [--limite=3]
if (require.main === module) {
  const args     = process.argv.slice(2);
  const headless = !args.includes('--visible');
  const limiteA  = args.find(a => a.startsWith('--limite='))?.split('=')[1];

  obtenerNotificacionesSICNEA({
    headless,
    limite: limiteA ? parseInt(limiteA, 10) : null,
  }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
