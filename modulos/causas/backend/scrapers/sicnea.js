require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const STORAGE_DIR = path.join(__dirname, '../../storage/sicnea');
const DESDE_ISO   = '2026-01-01';

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

// ── Utilidades ────────────────────────────────────────────────────────────────

function pausa(ms = 10000) {
  return new Promise(r => setTimeout(r, ms));
}

// "01/02/2026" → "2026-02-01"  |  "2026-02-01" → mismo  |  null → null
function isoFecha(str) {
  if (!str) return null;
  const s = str.trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function esPosteriorADesde(fechaIso) {
  if (!fechaIso) return true; // si no hay fecha la incluimos
  return fechaIso >= DESDE_ISO;
}

// Extrae texto de una celda/campo buscando primero por label aproximado
function extraerCampo(page, labelTexto) {
  return page.evaluate((label) => {
    const limpiar = s => s?.replace(/\s+/g, ' ').trim() || null;

    // Busca th/td pares en tabla
    for (const th of document.querySelectorAll('th, td, label, dt, .label, [class*="label"]')) {
      if (th.innerText?.toLowerCase().includes(label.toLowerCase())) {
        const sib = th.nextElementSibling || th.parentElement?.nextElementSibling?.querySelector('td, dd, span, input');
        if (sib) return limpiar(sib.innerText || sib.value);
      }
    }
    return null;
  }, labelTexto);
}

// ── Login AFIP ────────────────────────────────────────────────────────────────

async function loginAFIP(context) {
  const mainPage = await context.newPage();
  console.log('  Navegando a AFIP...');
  await mainPage.goto('https://www.afip.gob.ar/', { waitUntil: 'load', timeout: 60000 });
  await pausa(4000);

  // Botón "Ingresar con Clave Fiscal" abre nueva pestaña
  console.log('  Clickeando Ingresar con Clave Fiscal...');
  const [loginPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 30000 }),
    mainPage.locator('text=Ingresar con Clave Fiscal').first().click(),
  ]);
  await loginPage.waitForLoadState('load', { timeout: 60000 });
  await pausa(4000);

  // CUIT
  console.log('  Ingresando CUIT...');
  await loginPage.waitForSelector('[id="F1:username"]', { timeout: 30000 });
  await loginPage.fill('[id="F1:username"]', process.env.CUIT);
  await pausa(1000);
  await loginPage.click('[id="F1:btnSiguiente"]');
  await pausa(5000);

  // Clave fiscal
  console.log('  Ingresando clave fiscal...');
  await loginPage.waitForSelector('[id="F1:password"]', { timeout: 30000 });
  await loginPage.fill('[id="F1:password"]', process.env.CLAVE_FISCAL);
  await pausa(1000);
  await loginPage.click('[id="F1:btnIngresar"]');

  console.log('  Esperando portal AFIP...');
  await loginPage.waitForURL(url => url.href.includes('portalcf'), { timeout: 60000, waitUntil: 'load' });
  await pausa(8000);

  console.log('  Login OK →', loginPage.url());
  return loginPage;
}

// ── Abrir SICNEA Abogados ─────────────────────────────────────────────────────

async function abrirSICNEA(portalPage) {
  console.log('  Buscando SICNEA Abogados en el portal...');
  await portalPage.waitForSelector('text=SICNEA Abogados', { timeout: 30000 });
  await pausa(2000);

  // Clic abre un Pop Up (window.open)
  const [sicneaPopup] = await Promise.all([
    portalPage.waitForEvent('popup', { timeout: 30000 }),
    portalPage.locator('text=SICNEA Abogados').first().click(),
  ]);
  await sicneaPopup.waitForLoadState('load', { timeout: 60000 });
  await pausa(10000);
  console.log('  Popup SICNEA abierto:', sicneaPopup.url());

  // Click en "Ingresar" dentro del popup
  console.log('  Clickeando Ingresar...');
  await sicneaPopup.waitForSelector('text=Ingresar', { timeout: 20000 });

  // "Ingresar" puede navegar en el mismo popup o abrir una nueva ventana
  let sicneaPage;
  try {
    [sicneaPage] = await Promise.all([
      sicneaPopup.context().waitForEvent('page', { timeout: 15000 }),
      sicneaPopup.locator('text=Ingresar').first().click(),
    ]);
    await sicneaPage.waitForLoadState('load', { timeout: 60000 });
  } catch {
    sicneaPage = sicneaPopup;
    await sicneaPage.waitForLoadState('load', { timeout: 60000 });
  }

  await pausa(10000);
  console.log('  SICNEA cargado:', sicneaPage.url());
  return sicneaPage;
}

// ── Navegar al listado de notificaciones ──────────────────────────────────────

async function navegarANotificaciones(sicneaPage) {
  console.log('  Buscando menú de navegación...');

  // Hover sobre el primer ítem del menú principal para desplegarlo
  const menuItems = sicneaPage.locator('nav li, ul.menu > li, .navbar li, [class*="menu"] > li, [class*="nav"] > li');
  const count = await menuItems.count();
  if (count > 0) {
    await menuItems.first().hover();
    await pausa(3000);
  }

  // Si no apareció, intentar hover en un <a> del menú
  const navLinks = sicneaPage.locator('nav a, [class*="menu"] a, [class*="nav"] a');
  const linkCount = await navLinks.count();
  for (let i = 0; i < Math.min(linkCount, 5); i++) {
    await navLinks.nth(i).hover();
    await pausa(1500);
    const verVisible = await sicneaPage.locator('text=Ver Notificaciones').isVisible().catch(() => false);
    if (verVisible) break;
  }

  console.log('  Clickeando Ver Notificaciones...');
  await sicneaPage.waitForSelector('text=Ver Notificaciones', { timeout: 20000 });
  await sicneaPage.locator('text=Ver Notificaciones').first().click();
  await pausa(10000);

  await sicneaPage.waitForSelector('table, [class*="tabla"], [class*="grid"]', { timeout: 30000 });
  console.log('  Tabla de notificaciones visible');
}

// ── Aplicar filtro de fecha si está disponible ────────────────────────────────

async function aplicarFiltroFecha(sicneaPage) {
  // Busca inputs de fecha ("Desde", "Fecha Desde", etc.)
  const inputDesde = sicneaPage.locator('input[placeholder*="esde"], input[name*="esde"], input[id*="esde"]').first();
  if ((await inputDesde.count()) > 0) {
    console.log('  Aplicando filtro de fecha desde 01/01/2026...');
    await inputDesde.fill('01/01/2026');
    await pausa(2000);

    // Botón Buscar/Filtrar
    const btnBuscar = sicneaPage.locator('button:has-text("Buscar"), button:has-text("Filtrar"), input[value="Buscar"]').first();
    if ((await btnBuscar.count()) > 0) {
      await btnBuscar.click();
      await pausa(10000);
    }
    console.log('  Filtro aplicado');
    return true;
  }
  console.log('  Sin filtro de fecha disponible — se filtrará por fecha localmente');
  return false;
}

// ── Extraer filas de la tabla de notificaciones ───────────────────────────────

async function extraerFilasTabla(sicneaPage) {
  return sicneaPage.evaluate(() => {
    const limpiar = s => s?.replace(/\s+/g, ' ').trim() || '';
    const filas = [];

    document.querySelectorAll('table tbody tr, [class*="tabla"] tr, [class*="grid"] tr').forEach((tr, index) => {
      const celdas = [...tr.querySelectorAll('td')].map(td => limpiar(td.innerText));
      if (celdas.length < 2) return;

      // Buscar botón "Ver" en la fila
      const btnVer = tr.querySelector('button, a, input[type="button"]');
      const tieneBoton = !!btnVer;

      filas.push({ index, celdas, tieneBoton });
    });
    return filas;
  });
}

// ── Extraer datos del detalle de una notificación ─────────────────────────────

async function extraerDetalle(detallePage) {
  return detallePage.evaluate(() => {
    const limpiar = s => s?.replace(/\s+/g, ' ').trim() || null;

    // Intentar extraer por pares label/valor de cualquier estructura
    const datos = {};
    const mapeo = {
      numero:       ['número', 'numero', 'nro', 'n°'],
      dependencia:  ['dependencia'],
      cuit_cliente: ['cuit'],
      razon_social: ['razón social', 'razon social', 'denominación', 'denominacion'],
      aduana:       ['aduana'],
      motivo:       ['motivo'],
      documento_ref:['documento', 'doc. ref', 'documento ref'],
      fecha_alta:   ['fecha de alta', 'fecha alta'],
      estado:       ['estado'],
    };

    // Método 1: pares th/td en tabla
    document.querySelectorAll('tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('th, td')].map(c => limpiar(c.innerText));
      for (let i = 0; i < celdas.length - 1; i++) {
        const labelLow = celdas[i]?.toLowerCase() || '';
        for (const [campo, labels] of Object.entries(mapeo)) {
          if (!datos[campo] && labels.some(l => labelLow.includes(l))) {
            datos[campo] = celdas[i + 1] || null;
          }
        }
      }
    });

    // Método 2: pares label/span o dt/dd
    document.querySelectorAll('label, dt, [class*="label"]').forEach(el => {
      const labelLow = limpiar(el.innerText)?.toLowerCase() || '';
      const valor = limpiar(
        (el.nextElementSibling || el.parentElement?.querySelector('span, dd, input'))?.innerText
        || el.parentElement?.nextElementSibling?.innerText
      );
      for (const [campo, labels] of Object.entries(mapeo)) {
        if (!datos[campo] && valor && labels.some(l => labelLow.includes(l))) {
          datos[campo] = valor;
        }
      }
    });

    // Texto plano completo como respaldo
    datos._textoCompleto = limpiar(document.body.innerText);
    return datos;
  });
}

// ── Descargar adjuntos del detalle ────────────────────────────────────────────

async function descargarAdjuntos(detallePage, numero) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  // Selectores típicos de enlaces/botones de descarga
  const adjuntos = detallePage.locator(
    'a[href*=".pdf"], a[href*="adjunto"], a[href*="archivo"], ' +
    'button:has-text("Descargar"), button:has-text("PDF"), ' +
    'a:has-text("Descargar"), a:has-text("Adjunto")'
  );
  const total = await adjuntos.count();
  const archivos = [];

  for (let i = 0; i < total; i++) {
    const filePath = path.join(STORAGE_DIR, `${numero}_${i + 1}.pdf`);
    if (fs.existsSync(filePath)) { archivos.push(filePath); continue; }

    try {
      const [download] = await Promise.all([
        detallePage.waitForEvent('download', { timeout: 20000 }),
        adjuntos.nth(i).click(),
      ]);
      await download.saveAs(filePath);
      archivos.push(filePath);
      console.log(`    [PDF] ${path.basename(filePath)}`);
      await pausa(3000);
    } catch (e) {
      console.log(`    [!] Adjunto ${i + 1} no descargado: ${e.message}`);
    }
  }
  return archivos;
}

// ── Procesar una notificación (abrir detalle, extraer, descargar) ─────────────

async function procesarNotificacion(sicneaPage, rowIndex, context) {
  const filas = sicneaPage.locator('table tbody tr, [class*="tabla"] tr, [class*="grid"] tr');
  const fila  = filas.nth(rowIndex);

  const btnVer = fila.locator('button, a, input[type="button"]').first();
  if ((await btnVer.count()) === 0) return null;

  console.log(`    Abriendo detalle de fila ${rowIndex}...`);

  let detallePage;
  try {
    // "Ver" puede abrir popup o navegar
    [detallePage] = await Promise.all([
      context.waitForEvent('page', { timeout: 20000 }),
      btnVer.click(),
    ]);
    await detallePage.waitForLoadState('load', { timeout: 60000 });
  } catch {
    // Si no abrió nueva página, buscar popup
    try {
      [detallePage] = await Promise.all([
        sicneaPage.waitForEvent('popup', { timeout: 10000 }),
        btnVer.click(),
      ]);
      await detallePage.waitForLoadState('load', { timeout: 60000 });
    } catch {
      console.log(`    [!] No se pudo abrir el detalle de fila ${rowIndex}`);
      return null;
    }
  }

  await pausa(10000);

  const datos   = await extraerDetalle(detallePage);
  const archivos = await descargarAdjuntos(detallePage, datos.numero || `fila${rowIndex}`);

  await detallePage.close();
  await pausa(3000);

  return { ...datos, archivos_paths: archivos };
}

// ── Paginación ────────────────────────────────────────────────────────────────

async function hayPaginaSiguiente(sicneaPage) {
  const btnSig = sicneaPage.locator(
    'button:has-text("Siguiente"), a:has-text("Siguiente"), ' +
    'button:has-text(">"), a:has-text(">"), ' +
    '[aria-label*="iguiente"], [title*="iguiente"]'
  ).first();
  if ((await btnSig.count()) === 0) return false;
  const disabled = await btnSig.evaluate(el => el.disabled || el.classList.contains('disabled')).catch(() => false);
  return !disabled;
}

async function irAPaginaSiguiente(sicneaPage) {
  const btnSig = sicneaPage.locator(
    'button:has-text("Siguiente"), a:has-text("Siguiente"), ' +
    'button:has-text(">"), a:has-text(">"), ' +
    '[aria-label*="iguiente"], [title*="iguiente"]'
  ).first();
  await btnSig.click();
  await pausa(10000);
}

// ── Función principal exportable ──────────────────────────────────────────────

async function obtenerNotificacionesSICNEA({ headless = true } = {}) {
  console.log('\n══ Scraper SICNEA ════════════════════════════════════════════');

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  let nuevas = 0;

  try {
    console.log('\n1. Login AFIP...');
    const portalPage = await loginAFIP(context);

    console.log('\n2. Abriendo SICNEA Abogados...');
    const sicneaPage = await abrirSICNEA(portalPage);

    console.log('\n3. Navegando a notificaciones...');
    await navegarANotificaciones(sicneaPage);

    console.log('\n4. Aplicando filtro de fecha...');
    const filtroAplicado = await aplicarFiltroFecha(sicneaPage);

    console.log('\n5. Procesando notificaciones...');

    let pagina = 1;
    let detener = false;

    while (!detener) {
      console.log(`\n  ── Página ${pagina} ─────────────────────────────────────`);
      const filas = await extraerFilasTabla(sicneaPage);
      console.log(`  ${filas.length} fila(s) encontradas`);

      if (filas.length === 0) break;

      for (const fila of filas) {
        if (!fila.tieneBoton) continue;

        // Antes de procesar, intentar leer fecha de la tabla para filtrar
        // (columna con formato dd/mm/aaaa o similar)
        const fechaRaw = fila.celdas.find(c => /\d{2}\/\d{2}\/\d{4}/.test(c));
        const fechaIso = isoFecha(fechaRaw?.match(/\d{2}\/\d{2}\/\d{4}/)?.[0]);

        if (!filtroAplicado && fechaIso && fechaIso < DESDE_ISO) {
          console.log(`  [>>] Fecha ${fechaIso} anterior a ${DESDE_ISO} → deteniendo`);
          detener = true;
          break;
        }

        const datos = await procesarNotificacion(sicneaPage, fila.index, context);
        if (!datos) continue;

        const numero = datos.numero || fila.celdas[0] || `sin-numero-${Date.now()}`;

        if (yaExiste(numero)) {
          console.log(`  [--] ${numero}  ya existe`);
          continue;
        }

        guardar({
          numero,
          dependencia:   datos.dependencia || null,
          cuit_cliente:  datos.cuit_cliente || null,
          razon_social:  datos.razon_social || null,
          aduana:        datos.aduana       || null,
          motivo:        datos.motivo       || null,
          documento_ref: datos.documento_ref || null,
          fecha_alta:    isoFecha(datos.fecha_alta),
          estado:        datos.estado       || null,
          archivos_paths: datos.archivos_paths || [],
        });

        console.log(`  [OK] ${numero}  ${datos.estado || ''}  ${datos.fecha_alta || ''}`);
        nuevas++;
      }

      if (detener) break;
      if (!(await hayPaginaSiguiente(sicneaPage))) break;
      console.log('  Navegando a página siguiente...');
      await irAPaginaSiguiente(sicneaPage);
      pagina++;
    }

  } finally {
    await browser.close();
  }

  console.log('\n══ Resultado SICNEA ══════════════════════════════════════════');
  console.log(`  ${nuevas} nueva(s)`);
  return nuevas;
}

module.exports = { obtenerNotificacionesSICNEA };

// Ejecución directa: node sicnea.js
if (require.main === module) {
  obtenerNotificacionesSICNEA({ headless: false }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
