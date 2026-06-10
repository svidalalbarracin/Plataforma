/**
 * Scraper de SICNEA Abogados (Sistema de Notificaciones Aduaneras).
 *
 * Navega al portal de ARCA (ex-AFIP), abre el servicio SICNEA Abogados,
 * entra a la Bandeja de Entrada (Ver Notificaciones), y para cada notificación
 * descarga el detalle y los PDFs adjuntos.
 *
 * Se ejecuta automáticamente los sábados al iniciar la plataforma.
 * La práctica del estudio es abrirlas los sábados para que los plazos
 * procesales queden asentados el lunes siguiente.
 *
 * Flujo de navegación:
 *   ARCA login → portal → click SICNEA → mgenEntradaUsuarioExterno → cmdAceptar
 *   → frameset (mgenMarcoPpal) → frame iframeAreaCargaDatos → csicneaAboBandejaEntrada.aspx
 *   → click "Ver" en fila → frame navega a csicneaAboVerCedula.aspx → extrae datos + PDFs
 *   → vuelve a Bandeja para la siguiente fila
 *
 * @module causas/scrapers/sicnea
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const STORAGE_DIR = path.join(__dirname, '../../storage/sicnea');
const URL_BANDEJA = 'https://serviciosadu2.afip.gob.ar/DIAV2/Sicnea.Web/Sicnea.WebApp/formularios/csicneaAboBandejaEntrada.aspx';

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Verifica si una notificación SICNEA ya existe en la base por número de cédula.
 * @param {string} numero
 * @returns {boolean}
 */
function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_sicnea WHERE numero = ?').get(numero);
}

/**
 * Inserta una notificación SICNEA en la base de datos.
 * `archivos_paths` se serializa como JSON array de rutas absolutas.
 *
 * @param {{ numero: string, dependencia: string|null, cuit_cliente: string|null, razon_social: string|null, aduana: string|null, motivo: string|null, documento_ref: string|null, fecha_alta: string|null, estado: string|null, archivos_paths: string[] }} datos
 */
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

/**
 * Guarda o reemplaza un valor en la tabla de metadata del scraper.
 * @param {string} key   - Clave (ej: 'sicnea_ultima_auto')
 * @param {string} value
 */
function guardarMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO scraper_meta (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Convierte fechas dd/mm/aaaa a ISO (YYYY-MM-DD).
 * @param {string|null} str
 * @returns {string|null}
 */
function isoFecha(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return str.trim() || null;
}

// ── Login AFIP ────────────────────────────────────────────────────────────────

/**
 * Abre una nueva pestaña y hace login en el portal de ARCA (auth.afip.gob.ar)
 * con CUIT y CLAVE_FISCAL del .env.
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>} Página del portal ya autenticada
 * @throws {Error} Si el login falla y no llega al portal
 */
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

/**
 * Hace click en el tile "SICNEA Abogados" del portal ARCA, espera que abra la
 * página de ingreso externo (mgenEntradaUsuarioExterno.aspx) y presiona "Aceptar"
 * para cargar el frameset principal.
 *
 * El portal abre SICNEA en una nueva ventana (popup). Se escucha el evento 'page'
 * a nivel de contexto para capturarla.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} portalPage - Página del portal ARCA autenticada
 * @returns {Promise<import('playwright').Page>} Página principal de SICNEA con el frameset cargado
 */
async function abrirSICNEA(context, portalPage) {
  const popups = [];
  context.on('page', p => popups.push(p));

  await portalPage.locator('text=SICNEA Abogados').first().click();
  console.log('  Click en SICNEA, esperando páginas...');
  await new Promise(r => setTimeout(r, 10000));

  const usuarioPage = popups.find(p => p.url().includes('UsuarioExterno')) ?? popups[popups.length - 1];
  if (!usuarioPage) throw new Error('No se abrió página de SICNEA');

  usuarioPage.setDefaultTimeout(120000);
  await usuarioPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  console.log('  Página SICNEA:', usuarioPage.url());

  await usuarioPage.click('input#cmdAceptar');
  console.log('  cmdAceptar clickeado, esperando frameset...');
  await new Promise(r => setTimeout(r, 5000));
  await usuarioPage.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  console.log('  Frameset SICNEA cargado');
  return usuarioPage;
}

// ── Navegación ────────────────────────────────────────────────────────────────

/**
 * Navega el frame de contenido (iframeAreaCargaDatos) a la Bandeja de Entrada
 * y espera que aparezca la tabla de notificaciones.
 *
 * @param {import('playwright').Page} mainPage - Página del frameset de SICNEA
 * @returns {Promise<import('playwright').Frame>} Frame con la Bandeja de Entrada cargada
 * @throws {Error} Si no se encuentra el frame de contenido
 */
async function irABandeja(mainPage) {
  const frame = mainPage.frames().find(f => f.url().includes('mgenInicioGen') || f.name() === 'iframeAreaCargaDatos');
  if (!frame) throw new Error('No se encontró frame de contenido');

  await frame.goto(URL_BANDEJA, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await frame.waitForSelector('table#dgdNotificacion', { timeout: 30000 });
  console.log('  Bandeja cargada:', frame.url());
  return frame;
}

// ── Extracción de datos ───────────────────────────────────────────────────────

/**
 * Extrae las filas de datos de la tabla de la Bandeja de Entrada.
 * Columnas: [0] Numero | [1] Cuit | [2] Razon Social | [3] Motivo | [4] Enviada | [5] Vencimiento | [6] Notif Auto | [7] Ver
 *
 * @param {import('playwright').Frame} frame
 * @returns {Promise<Array<{ rowIndex: number, numero: string, cuit: string|null, razon_social: string|null, motivo: string|null, fecha_envio: string|null, vencimiento: string|null, tieneVer: boolean }>>}
 */
async function extraerFilas(frame) {
  return frame.evaluate(() => {
    const limpiar = s => s?.replace(/\s+/g, ' ').trim() || null;
    const filas = [];
    const table = document.getElementById('dgdNotificacion');
    if (!table) return filas;

    table.querySelectorAll('tbody tr').forEach((tr, index) => {
      const celdas = [...tr.querySelectorAll('td')].map(td => limpiar(td.innerText));
      if (celdas.length >= 5 && celdas[0] && /\d/.test(celdas[0])) {
        filas.push({
          rowIndex:     index,
          numero:       celdas[0],
          cuit:         celdas[1],
          razon_social: celdas[2],
          motivo:       celdas[3],
          fecha_envio:  celdas[4],
          vencimiento:  celdas[5],
          tieneVer:     !!tr.querySelector('a, input[type=button], button'),
        });
      }
    });
    return filas;
  });
}

/**
 * Hace click en el botón "Ver" de una fila de la Bandeja.
 * El botón navega el frame a csicneaAboVerCedula.aspx (no abre popup).
 * Espera que aparezca el campo txtNroCedula como señal de que cargó el detalle.
 *
 * @param {import('playwright').Frame} frame
 * @param {number} rowIndex - Índice de la fila en tbody (desde extraerFilas)
 * @returns {Promise<boolean>} true si se abrió el detalle, false si no había botón
 */
async function abrirDetalle(frame, rowIndex) {
  const filas  = frame.locator('table#dgdNotificacion tbody tr');
  const fila   = filas.nth(rowIndex);
  const btnVer = fila.locator('a, input[type=button], button').first();
  if ((await btnVer.count()) === 0) return false;

  await btnVer.click();
  await frame.waitForSelector('input#txtNroCedula', { timeout: 30000 });
  console.log(`    [detalle] frame en: ${frame.url()}`);
  return true;
}

/**
 * Extrae los campos del formulario de la cédula (csicneaAboVerCedula.aspx).
 * Todos los campos son `<input readonly>` con IDs conocidos.
 *
 * @param {import('playwright').Frame} frame - Frame ya en la página de detalle
 * @returns {Promise<{ numero: string|null, dependencia: string|null, cuit_cliente: string|null, razon_social: string|null, aduana: string|null, motivo: string|null, documento_ref: string|null, fecha_alta: string|null, estado: string|null }>}
 */
async function extraerDetalle(frame) {
  return frame.evaluate(() => {
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

/**
 * Descarga todos los PDFs adjuntos de la cédula (tabla dgdArchivoAdjuntos).
 * Si el archivo ya existe en disco, lo omite.
 * Los PDFs se nombran `<numero>_<orden>.pdf`.
 *
 * @param {import('playwright').BrowserContext} context - Para escuchar el evento 'download' a nivel de contexto
 * @param {import('playwright').Frame} frame            - Frame en la página de detalle
 * @param {string} numero                               - Número de cédula (para nombrar archivos)
 * @returns {Promise<string[]>} Rutas absolutas de los PDFs descargados o ya existentes
 */
async function descargarAdjuntos(context, frame, numero) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const archivosLista = await frame.evaluate(() => {
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
      // El listener debe registrarse ANTES del click para no perder el evento de descarga
      const downloadPromise = context.waitForEvent('download', { timeout: 60000 });
      await frame.locator('table#dgdArchivoAdjuntos a:has-text("Ver")').nth(i).click();
      const download = await downloadPromise;
      await download.saveAs(filePath);
      archivos.push(filePath);
      console.log(`    [PDF] ${nombreOriginal} → ${path.basename(filePath)}`);
      // Esperar que el frame vuelva al estado estable tras el postback ASP.NET
      await frame.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.log(`    [!] ${nombreOriginal} no descargado (${e.message.split('\n')[0].substring(0, 80)})`);
    }
  }
  return archivos;
}

// ── Función principal exportable ──────────────────────────────────────────────

/**
 * Obtiene las notificaciones de la Bandeja de Entrada de SICNEA y las persiste en la base.
 *
 * - Modo automático (limite = null): para al encontrar la primera notificación ya registrada.
 * - Modo manual (limite > 0): procesa hasta `limite` filas nuevas, ignorando duplicados.
 *
 * @param {{ headless?: boolean, limite?: number|null }} [opts]
 * @returns {Promise<number>} Cantidad de notificaciones nuevas guardadas
 */
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

    console.log('\n3. Abriendo Bandeja de Entrada...');
    const consultaFrame = await irABandeja(mainPage);

    console.log('\n4. Procesando notificaciones...');

    const filas = await extraerFilas(consultaFrame);
    console.log(`  ${filas.length} fila(s) encontradas`);

    let examinadas = 0;
    for (const fila of filas) {
      const numero = fila.numero?.trim();
      if (!numero) continue;

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

      let detalleDatos  = {};
      let archivosPaths = [];
      if (fila.tieneVer) {
        const ok = await abrirDetalle(consultaFrame, fila.rowIndex);
        if (ok) {
          detalleDatos  = await extraerDetalle(consultaFrame);
          archivosPaths = await descargarAdjuntos(context, consultaFrame, numero);
          // Volver a la Bandeja para procesar la siguiente fila
          await consultaFrame.goto(URL_BANDEJA, { waitUntil: 'domcontentloaded', timeout: 90000 });
          await consultaFrame.waitForSelector('table#dgdNotificacion', { timeout: 30000 });
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

      console.log(`  [OK] ${numero}  ${fila.motivo || ''}  ${fila.fecha_envio || ''}`);
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
  const args    = process.argv.slice(2);
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
