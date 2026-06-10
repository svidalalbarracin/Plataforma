require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const STORAGE_DIR   = path.join(__dirname, '../../storage/sicnea');
const DESDE_DEFAULT = '2026-01-01';
const URL_CONSULTA  = 'https://serviciosadu2.afip.gob.ar/DIAV2/Sicnea.Web/Sicnea.WebApp/formularios/csicneaAboConsulta.aspx';

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

// ── Abrir SICNEA ──────────────────────────────────────────────────────────────

async function abrirSICNEA(context, portalPage) {
  const popups = [];
  context.on('page', p => popups.push(p));

  await portalPage.locator('text=SICNEA Abogados').first().click();
  console.log('  Click en SICNEA, esperando páginas...');
  await new Promise(r => setTimeout(r, 10000));

  // El portal abre varias páginas — buscar la de UsuarioExterno (tiene el botón Ingresar)
  const usuarioPage = popups.find(p => p.url().includes('UsuarioExterno')) ?? popups[popups.length - 1];
  if (!usuarioPage) throw new Error('No se abrió página de SICNEA');

  usuarioPage.setDefaultTimeout(120000);
  await usuarioPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  console.log('  Página SICNEA:', usuarioPage.url());

  // Botón de ingreso al sistema
  await usuarioPage.click('input#cmdAceptar');
  console.log('  cmdAceptar clickeado, esperando frameset...');
  await new Promise(r => setTimeout(r, 5000));
  await usuarioPage.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  console.log('  Frameset SICNEA cargado');
  return usuarioPage;
}

// ── Navegar al frame de Consulta ──────────────────────────────────────────────

async function irAConsulta(mainPage) {
  const frame = mainPage.frames().find(f => f.url().includes('mgenInicioGen') || f.name() === 'iframeAreaCargaDatos');
  if (!frame) throw new Error('No se encontró frame de contenido');

  await frame.goto(URL_CONSULTA, { waitUntil: 'networkidle', timeout: 60000 });
  console.log('  Consulta cargada:', frame.url());
  return frame;
}

// ── Búsqueda con filtro de fecha opcional ─────────────────────────────────────

async function buscar(frame, desde) {
  // Filtro de fecha: ISO YYYY-MM-DD → DD/MM/YYYY
  const [y, m, d] = desde.split('-');
  await frame.fill('#txtFechaNotificacionDesde', `${d}/${m}/${y}`);
  console.log(`  Filtro de fecha: ${d}/${m}/${y}`);

  await frame.click('input#btnBuscar');
  console.log('  Buscando... (puede tardar hasta 120s)');

  // La búsqueda es asíncrona y puede tardar ~90s. Usamos txtCantidadReg como indicador.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const cantReg = await frame.evaluate(() =>
      document.getElementById('txtCantidadReg')?.value || '0'
    ).catch(() => '0');
    if (parseInt(cantReg) > 0) {
      console.log(`  Resultados listos: ${cantReg} registros (t+${(i + 1) * 5}s)`);
      return;
    }
    if ((i + 1) % 6 === 0) console.log(`  ... esperando (t+${(i + 1) * 5}s)`);
  }
  throw new Error('Timeout esperando resultados (200s)');
}

// ── Extraer filas de la tabla ─────────────────────────────────────────────────

async function extraerFilas(frame) {
  return frame.evaluate(() => {
    const limpiar = s => s?.replace(/\s+/g, ' ').trim() || null;
    const filas = [];
    const table = document.querySelector('table[id*="dgd"], table.dgdTable');
    if (!table) return filas;

    table.querySelectorAll('tbody tr').forEach((tr, index) => {
      const celdas = [...tr.querySelectorAll('td')].map(td => limpiar(td.innerText));
      // Columnas típicas: [0]=Numero [1]=Motivo [2]=Fecha [3]=Archivos [4]=Domicilio [5]=Estado [6]=Ver
      if (celdas.length >= 5 && celdas[0] && /\d/.test(celdas[0])) {
        filas.push({
          rowIndex:           index,
          numero:             celdas[0],
          motivo:             celdas[1],
          fecha_notificacion: celdas[2],
          archivos_adjuntos:  celdas[3],
          domicilio:          celdas[4],
          estado:             celdas[5] || null,
          tieneVer:           !!tr.querySelector('a, input[type=button], button'),
        });
      }
    });
    return filas;
  });
}

// ── Abrir detalle de una notificación ─────────────────────────────────────────

async function abrirDetalle(frame, context, rowIndex) {
  const filas = frame.locator('table[id*="dgd"] tbody tr, table.dgdTable tbody tr');
  const fila  = filas.nth(rowIndex);
  const btnVer = fila.locator('a, input[type=button], button').first();
  if ((await btnVer.count()) === 0) return null;

  try {
    const pagesBefore = context.pages().length;
    const [detallePage] = await Promise.all([
      context.waitForEvent('page', { timeout: 20000 }),
      btnVer.click(),
    ]);
    await detallePage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    return detallePage;
  } catch {
    return null;
  }
}

// ── Extraer campos del detalle ────────────────────────────────────────────────

async function extraerDetalle(detallePage) {
  return detallePage.evaluate(() => {
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

// ── Descargar adjuntos ────────────────────────────────────────────────────────

async function descargarAdjuntos(context, detallePage, numero) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const archivosLista = await detallePage.evaluate(() => {
    const tabla = document.getElementById('dgdArchivoAdjuntos');
    if (!tabla) return [];
    return [...tabla.querySelectorAll('tbody tr')].map(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(c => c.innerText.trim());
      return { orden: celdas[0], nombre: celdas[1] };
    }).filter(r => r.nombre && r.nombre.length > 0);
  });

  if (archivosLista.length === 0) return [];

  const archivos = [];
  for (let i = 0; i < archivosLista.length; i++) {
    const nombreOriginal = archivosLista[i].nombre;
    const filePath = path.join(STORAGE_DIR, `${numero}_${i + 1}.pdf`);
    if (fs.existsSync(filePath)) { archivos.push(filePath); continue; }

    try {
      // Registrar el listener ANTES del click para no perder el evento
      const downloadPromise = context.waitForEvent('download', { timeout: 60000 });
      await detallePage.locator('table#dgdArchivoAdjuntos a:has-text("Ver")').nth(i).click();
      const download = await downloadPromise;
      await download.saveAs(filePath);
      archivos.push(filePath);
      console.log(`    [PDF] ${nombreOriginal} → ${path.basename(filePath)}`);
      // Esperar que la página vuelva al estado estable tras el postback
      await detallePage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.log(`    [!] ${nombreOriginal} no descargado (${e.message.split('\n')[0].substring(0, 80)})`);
    }
  }
  return archivos;
}

// ── Función principal exportable ──────────────────────────────────────────────

async function obtenerNotificacionesSICNEA({ headless = true, desde = DESDE_DEFAULT, limite = null } = {}) {
  const modoAuto = limite === null;

  console.log('\n══ Scraper SICNEA ════════════════════════════════════════════');
  console.log(modoAuto
    ? `  Modo: automático, desde ${desde}`
    : `  Modo: prueba — límite ${limite}, desde ${desde}`
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

    console.log('\n3. Navegando a Consulta...');
    const consultaFrame = await irAConsulta(mainPage);

    console.log('\n4. Ejecutando búsqueda...');
    await buscar(consultaFrame, desde);

    console.log('\n5. Procesando notificaciones...');

    const filas = await extraerFilas(consultaFrame);
    console.log(`  ${filas.length} fila(s) encontradas`);

    let examinadas = 0;
    for (const fila of filas) {
      const numero = fila.numero?.trim();
      if (!numero) continue;

      const fechaIso = isoFecha(fila.fecha_notificacion);

      if (yaExiste(numero)) {
        if (modoAuto) {
          console.log(`  [>>] ${numero} ya existe → deteniendo`);
          break;
        }
        console.log(`  [--] ${numero} ya existe`);
        examinadas++;
        if (limite && examinadas >= limite) break;
        continue;
      }

      // Abrir detalle para obtener campos completos y PDFs
      let detalleDatos = {};
      let archivosPaths = [];
      if (fila.tieneVer) {
        const detallePage = await abrirDetalle(consultaFrame, context, fila.rowIndex);
        if (detallePage) {
          detalleDatos  = await extraerDetalle(detallePage);
          archivosPaths = await descargarAdjuntos(context, detallePage, numero);
          await detallePage.close();
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      guardar({
        numero,
        dependencia:   detalleDatos.dependencia  || null,
        cuit_cliente:  detalleDatos.cuit_cliente || null,
        razon_social:  detalleDatos.razon_social || null,
        aduana:        detalleDatos.aduana       || null,
        motivo:        detalleDatos.motivo       || fila.motivo || null,
        documento_ref: detalleDatos.documento_ref || null,
        fecha_alta:    isoFecha(detalleDatos.fecha_alta) || fechaIso,
        estado:        detalleDatos.estado       || fila.estado || null,
        archivos_paths: archivosPaths,
      });

      console.log(`  [OK] ${numero}  ${fila.estado || ''}  ${fila.fecha_notificacion || ''}`);
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

// node sicnea.js [--visible] [--desde=2023-01-01] [--limite=3]
if (require.main === module) {
  const args     = process.argv.slice(2);
  const headless = !args.includes('--visible');
  const desde    = args.find(a => a.startsWith('--desde='))?.split('=')[1]  || DESDE_DEFAULT;
  const limiteA  = args.find(a => a.startsWith('--limite='))?.split('=')[1];

  obtenerNotificacionesSICNEA({
    headless,
    desde,
    limite: limiteA ? parseInt(limiteA, 10) : null,
  }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
