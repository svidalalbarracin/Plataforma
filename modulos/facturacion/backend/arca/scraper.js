/**
 * Scraper de ARCA (ex-AFIP) — Importación de comprobantes desde RCEL.
 *
 * Flujo de navegación:
 * 1. Login en afip.gob.ar con CUIT + clave fiscal (abre nueva pestaña).
 * 2. Desde el portal, hace clic en "Comprobantes en línea" (abre RCEL en otra pestaña).
 * 3. Selecciona el representado (el primer btn_empresa, que es el estudio).
 * 4. Navega a la sección "Consultas" y completa el formulario de fechas/tipo.
 * 5. Extrae las filas de resultados, descarga el PDF de cada una y guarda en DB.
 *
 * Variables de entorno requeridas: CUIT, CLAVE_FISCAL.
 *
 * @module facturacion/arca/scraper
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const pdfParse = require('pdf-parse');
const db   = require('../../../../core/database');

const PDF_DIR = path.join(__dirname, '../../storage/facturas');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ── Helpers de formato ────────────────────────────────────────────────────────

/**
 * Formatea una fecha JS como DD/MM/AAAA (formato que espera el formulario de ARCA).
 * @param {Date} d
 * @returns {string}
 */
function fmtDDMMAAAA(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

/**
 * Mapea la descripción textual del tipo de comprobante que devuelve ARCA a un código corto.
 * Ej: "Factura A" → "A", "Nota de Crédito B" → "NC B".
 * @param {string|null} tipoComp - Texto tal como aparece en la tabla de resultados.
 * @returns {string|null} Código corto o null si no se reconoce.
 */
function mapearTipo(tipoComp) {
  if (!tipoComp) return null;
  const t = tipoComp.trim();
  if (/Factura\s+A\b/i.test(t))                              return 'A';
  if (/Factura\s+B\b/i.test(t))                              return 'B';
  if (/Factura\s+C\b/i.test(t))                              return 'C';
  if (/Nota\s+de\s+Cr[eé]dito\s+A\b/i.test(t))              return 'NC A';
  if (/Nota\s+de\s+Cr[eé]dito\s+B\b/i.test(t))              return 'NC B';
  if (/Nota\s+de\s+Cr[eé]dito\s+C\b/i.test(t))              return 'NC C';
  if (/Nota\s+de\s+Cr[eé]dito/i.test(t))                    return 'NC';
  if (/FCE|Factura\s+de\s+Cr[eé]dito/i.test(t))             return 'FCE';
  if (/Factura\s+de\s+Exportaci[oó]n|Exportaci[oó]n/i.test(t)) return 'E';
  return t || null;
}

/**
 * Indica si el tipo de comprobante corresponde a una Nota de Crédito.
 * @param {string|null} tipo
 * @returns {boolean}
 */
function esNotaCredito(tipo) {
  return tipo != null && tipo.startsWith('NC');
}

// ── Extracción de datos desde el PDF ─────────────────────────────────────────

/**
 * Extrae el nombre del receptor desde el PDF del comprobante.
 * Soporta dos patrones:
 * - Entidad argentina: CUIT de 11 dígitos seguido del nombre en mayúsculas.
 * - Entidad extranjera: primera línea de contenido real bajo "Apellido y Nombre".
 * @param {string} pdfPath - Ruta absoluta al PDF.
 * @returns {Promise<string|null>} Nombre o null si no se puede extraer.
 */
async function extraerNombreDesdePDF(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);
    const idx = text.indexOf('Apellido y Nombre');
    if (idx === -1) return null;
    const sector = text.slice(idx, idx + 600);

    // Patrón 1: CUIT (11 dígitos) pegado al nombre → entidad argentina
    const m = sector.match(/\d{11}([A-ZÁÉÍÓÚÜÑ][^\n]+)/);
    if (m) return m[1].trim();

    // Patrón 2: entidad extranjera (sin CUIT) → primera línea de contenido real
    const skip = /^(Apellido y Nombre|Domicilio|CUIT:|Condición|Ingresos|Fecha de |Punto de|Razón Social:|Comp\. Nro)|\d{2}\/\d{2}\/\d{4}|^\d+$/;
    for (const linea of sector.split('\n').map(l => l.trim()).filter(Boolean)) {
      if (!skip.test(linea)) return linea;
    }
  } catch (e) {
    console.warn(`  [warn] No se pudo extraer nombre del PDF ${path.basename(pdfPath)}: ${e.message}`);
  }
  return null;
}

/**
 * Detecta si el comprobante está emitido en USD leyendo la línea "Moneda:" del PDF.
 * @param {string} pdfPath
 * @returns {Promise<'USD'|'ARS'>}
 */
async function extraerMoneda(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);
    const m = text.match(/Moneda:\s*([^\n]{3,60})/i);
    if (m && /d[oó]lar|USD/i.test(m[1])) return 'USD';
  } catch (e) {
    console.warn(`  [warn] No se pudo detectar moneda de ${path.basename(pdfPath)}: ${e.message}`);
  }
  return 'ARS';
}

/**
 * Extrae el tipo de cambio consignado en el PDF (solo para facturas USD).
 * ARCA imprime: "tipo de cambio consignado de 1349.000000".
 * @param {string} pdfPath
 * @returns {Promise<number|null>}
 */
async function extraerTipoCambio(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);
    const m = text.match(/tipo de cambio\D{0,30}?([\d]+(?:[.,]\d+)?)/i);
    if (m) return parseFloat(m[1].replace(',', '.'));
  } catch (e) {
    console.warn(`  [warn] No se pudo extraer tipo de cambio de ${path.basename(pdfPath)}: ${e.message}`);
  }
  return null;
}

/**
 * Extrae el número de la factura original asociada a una nota de crédito.
 * Intenta dos patrones: "Fac. A: 00002-00000669" y la sección "Comprobante Asociado".
 * @param {string} pdfPath
 * @returns {Promise<string|null>} Número normalizado (PPPP-NNNNNNN) o null.
 */
async function extraerComprobanteAsociado(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);

    const m0 = text.match(/Fac\.\s+[A-Z]:\s*(\d{1,5}-\d{6,8})/i);
    if (m0) return normalizarNumero(m0[1]);

    const idx = text.search(/Comprobantes?\s+Asoc/i);
    if (idx !== -1) {
      const sector = text.slice(idx, idx + 500);
      const m1 = sector.match(/(\d{1,4})\s*[-–]\s*(\d{6,8})/);
      if (m1) return normalizarNumero(`${m1[1]}-${m1[2]}`);
      const m2 = sector.match(/\b(\d{4})\s+(\d{8})\b/);
      if (m2) return `${m2[1]}-${m2[2]}`;
    }
  } catch (e) {
    console.warn(`  [warn] No se pudo extraer comprobante asociado de ${path.basename(pdfPath)}: ${e.message}`);
  }
  return null;
}

// ── Persistencia ──────────────────────────────────────────────────────────────

/**
 * Busca un cliente por CUIT y lo crea si no existe.
 * Si existe pero su nombre es el CUIT (placeholder) y ahora tenemos el nombre real, lo actualiza.
 * @param {string|number} nroDoc - CUIT del receptor.
 * @param {string|null} nombre   - Nombre extraído del PDF.
 * @returns {number} ID del cliente.
 */
function obtenerOCrearCliente(nroDoc, nombre = null) {
  const cuit = String(nroDoc);
  let cliente = db.prepare('SELECT id, nombre FROM clientes WHERE cuit = ?').get(cuit);

  if (cliente) {
    if (nombre && cliente.nombre === cuit) {
      db.prepare('UPDATE clientes SET nombre = ? WHERE cuit = ?').run(nombre, cuit);
    }
    return cliente.id;
  }

  const nombreGuardar = nombre ?? cuit;
  const res = db.prepare('INSERT INTO clientes (nombre, cuit) VALUES (?, ?)').run(nombreGuardar, cuit);
  return res.lastInsertRowid;
}

/**
 * Indica si una factura con ese número ya está importada en la DB.
 * @param {string} numero
 * @returns {boolean}
 */
function yaImportada(numero) {
  return !!db.prepare('SELECT id FROM facturas WHERE numero = ?').get(numero);
}

/**
 * Inserta o actualiza una factura en la DB.
 * Si `forzar` es true y la factura ya existe, la actualiza (útil para reimportar).
 * El monto_neto se calcula asumiendo IVA 21% sobre el monto_total.
 * @param {{ clienteId, numero, fecha, montoTotal, pdfPath, tipo?, facturaAsociadaNumero?, moneda?, tipoCambio?, forzar? }} opts
 */
function guardarFactura({ clienteId, numero, fecha, montoTotal, pdfPath, tipo = null, facturaAsociadaNumero = null, moneda = 'ARS', tipoCambio = null, forzar = false }) {
  const montoNeto = Math.round((montoTotal / 1.21) * 100) / 100;
  const iva       = Math.round((montoTotal - montoNeto) * 100) / 100;

  if (forzar && db.prepare('SELECT id FROM facturas WHERE numero = ?').get(numero)) {
    db.prepare(`
      UPDATE facturas SET monto=?, iva=?, monto_neto=?, monto_total=?, tipo=?, factura_asociada_numero=?, moneda=?, tipo_cambio=? WHERE numero=?
    `).run(montoNeto, iva, montoNeto, montoTotal, tipo, facturaAsociadaNumero, moneda, tipoCambio, numero);
  } else {
    db.prepare(`
      INSERT INTO facturas (cliente_id, numero, fecha, monto, iva, monto_neto, monto_total, pdf_path, tipo, factura_asociada_numero, moneda, tipo_cambio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clienteId, numero, fecha, montoNeto, iva, montoNeto, montoTotal, path.basename(pdfPath), tipo, facturaAsociadaNumero, moneda, tipoCambio);
  }
}

// ── Parseo de tabla de resultados ─────────────────────────────────────────────

/**
 * Extrae todas las filas de resultados de la tabla de RCEL mediante `page.evaluate`.
 * Solo considera filas con ≥7 columnas y fecha en columna 0 (dd/mm/aaaa).
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{fecha, tipoComp, nroComp, tipoDoc, nroDoc, cae, importeTotal}>>}
 */
async function extraerFilas(page) {
  return page.evaluate(() => {
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
      if (celdas.length >= 7 && /^\d{2}\/\d{2}\/\d{4}$/.test(celdas[0])) {
        filas.push({
          fecha:        celdas[0],   // dd/mm/aaaa
          tipoComp:     celdas[1],
          nroComp:      celdas[2],   // "PPPP-NNNNNNN"
          tipoDoc:      celdas[3],
          nroDoc:       celdas[4],
          cae:          celdas[5],
          importeTotal: celdas[6],
        });
      }
    });
    return filas;
  });
}

// ── Navegación ────────────────────────────────────────────────────────────────

/**
 * Hace login en ARCA con las credenciales del .env (CUIT + CLAVE_FISCAL).
 * El botón "Ingresar con Clave Fiscal" abre una nueva pestaña; si falla, navega directo.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>} Página del portal de servicios post-login.
 * @throws {Error} Si la URL final no contiene 'portalcf'.
 */
async function login(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  console.log('  Navegando a afip.gob.ar...');
  await page.goto('https://www.afip.gob.ar/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const [authPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 15000 }),
    page.locator('a:has-text("Ingresar con Clave Fiscal"), a:has-text("ingresar")').first().click(),
  ]).catch(async () => {
    console.log('  Fallback: navegando directo al login...');
    await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', { waitUntil: 'networkidle', timeout: 60000 });
    return [page];
  });

  const auth = authPage ?? page;
  auth.setDefaultTimeout(45000);
  await auth.waitForLoadState('networkidle');

  console.log('  Ingresando CUIT...');
  await auth.fill('[id="F1:username"]', process.env.CUIT);
  await auth.click('[id="F1:btnSiguiente"]');
  await auth.waitForLoadState('networkidle');

  console.log('  Ingresando clave fiscal...');
  await auth.fill('[id="F1:password"]', process.env.CLAVE_FISCAL);
  await auth.click('[id="F1:btnIngresar"]');
  await auth.waitForLoadState('networkidle');

  if (!auth.url().includes('portalcf')) {
    throw new Error(`Login fallido. URL actual: ${auth.url()}`);
  }
  console.log('  Login OK');
  return auth;
}

/**
 * Hace clic en "Comprobantes en línea" en el portal, lo que abre RCEL en una nueva pestaña.
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} portalPage
 * @returns {Promise<import('playwright').Page>} Página de RCEL.
 */
async function abrirRCEL(context, portalPage) {
  console.log('  Buscando "Comprobantes en línea"...');
  const [rcelPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 20000 }),
    portalPage.locator('text=Comprobantes en línea').first().click(),
  ]).catch(async () => {
    console.log('  Fallback: esperando navegación en la misma pestaña...');
    await portalPage.waitForLoadState('networkidle');
    return [portalPage];
  });
  rcelPage.setDefaultTimeout(45000);
  await rcelPage.waitForLoadState('networkidle');
  console.log('  RCEL abierto:', rcelPage.url());
  return rcelPage;
}

/**
 * Selecciona el representado en RCEL (el primer botón `input.btn_empresa`).
 * @param {import('playwright').Page} rcelPage
 * @returns {Promise<import('playwright').Page>} La misma página tras el submit.
 */
async function seleccionarRepresentado(rcelPage) {
  console.log('  Seleccionando representado (CUIT del abogado)...');
  await rcelPage.waitForLoadState('networkidle');
  await rcelPage.waitForSelector('input.btn_empresa', { timeout: 20000 });
  await rcelPage.locator('input.btn_empresa').first().click();
  await rcelPage.waitForLoadState('networkidle');
  console.log('  Representado seleccionado:', rcelPage.url());
  return rcelPage;
}

/**
 * Hace clic en el link "Consultas" para ir a la sección de búsqueda de comprobantes.
 * @param {import('playwright').Page} page
 */
async function irAConsultas(page) {
  console.log('  Haciendo click en "Consultas"...');
  await page.locator('a:has-text("Consultas")').first().click();
  await page.waitForLoadState('networkidle');
  console.log('  En Consultas:', page.url());
}

/**
 * Completa el formulario de búsqueda de comprobantes con el rango de fechas y filtros opcionales.
 * @param {import('playwright').Page} page
 * @param {{ fechaDesde: Date, fechaHasta: Date, tipoComprobante?: number|null, puntoVenta?: number|null }} opts
 */
async function completarFormulario(page, { fechaDesde, fechaHasta, tipoComprobante, puntoVenta }) {
  console.log('  Completando formulario de consulta...');
  const desde = fmtDDMMAAAA(fechaDesde);
  const hasta  = fmtDDMMAAAA(fechaHasta);

  const inputDesde = page.locator('input[name*="esde"], input[id*="esde"]').first();
  const inputHasta = page.locator('input[name*="asta"], input[id*="asta"]').first();
  await inputDesde.fill(desde);
  await inputHasta.fill(hasta);

  if (tipoComprobante != null) {
    const selectTipo = page.locator('select').first();
    await selectTipo.selectOption({ value: String(tipoComprobante) }).catch(() => null);
  }

  if (puntoVenta != null) {
    const selectPV = page.locator('select').nth(1);
    await selectPV.selectOption({ value: String(puntoVenta) }).catch(() => null);
  }

  console.log(`  Formulario: ${desde} → ${hasta}  tipo=${tipoComprobante ?? 'todos'}  PV=${puntoVenta ?? 'todos'}`);
}

/**
 * Hace clic en "Buscar", parsea los resultados y para cada fila descarga el PDF,
 * extrae los datos del receptor y guarda la factura en la DB.
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {{ forzar?: boolean }} opts - Si forzar=true, actualiza facturas ya importadas.
 * @returns {Promise<{importadas, actualizadas, omitidas, errores, numerosImportados: string[]}>}
 */
async function buscarYProcesar(page, context, { forzar = false } = {}) {
  console.log('  Haciendo click en "Buscar"...');
  await page.locator('input[type="submit"], button[type="submit"], input[value*="uscar"]').first().click();
  await page.waitForLoadState('networkidle');

  const filas = await extraerFilas(page);
  console.log(`  Resultados: ${filas.length} fila(s)`);

  if (filas.length === 0) {
    const texto = await page.textContent('body');
    console.log('  Texto página:', texto.replace(/\s+/g, ' ').slice(0, 400));
    return { importadas: 0, actualizadas: 0, omitidas: 0, errores: 0, numerosImportados: [] };
  }

  let importadas = 0, actualizadas = 0, omitidas = 0, errores = 0;
  const numerosImportados = [];

  for (const fila of filas) {
    const numero = normalizarNumero(fila.nroComp);
    const existe = yaImportada(numero);

    if (existe && !forzar) { omitidas++; continue; }

    try {
      const montoTotal = parsearMonto(fila.importeTotal);
      console.log(`  [raw] ${numero}  importe="${fila.importeTotal}" → ${montoTotal}`);

      const pdfPath = await descargarPDF(page, context, fila, numero);
      const nombre  = await extraerNombreDesdePDF(pdfPath);
      if (nombre) console.log(`  [nombre] ${nombre}`);
      const clienteId = obtenerOCrearCliente(fila.nroDoc, nombre);
      const fecha      = isoFecha(fila.fecha);
      const tipo       = mapearTipo(fila.tipoComp);

      const moneda     = await extraerMoneda(pdfPath);
      const tipoCambio = moneda === 'USD' ? await extraerTipoCambio(pdfPath) : null;
      if (moneda === 'USD') console.log(`  [USD] ${numero}  TC: ${tipoCambio}`);

      const facturaAsociadaNumero = esNotaCredito(tipo)
        ? await extraerComprobanteAsociado(pdfPath)
        : null;
      if (facturaAsociadaNumero) console.log(`  [NC→] asociada a ${facturaAsociadaNumero}`);

      guardarFactura({ clienteId, numero, fecha, montoTotal, pdfPath, tipo, facturaAsociadaNumero, moneda, tipoCambio, forzar });

      if (existe) {
        console.log(`  [UPD] ${numero}  ${fecha}  $${montoTotal}`);
        actualizadas++;
      } else {
        console.log(`  [OK] ${numero}  ${fecha}  $${montoTotal}`);
        numerosImportados.push(numero);
        importadas++;
      }
    } catch (e) {
      console.error(`  [ERR] ${numero}: ${e.message}`);
      errores++;
    }
  }

  return { importadas, actualizadas, omitidas, errores, numerosImportados };
}

/**
 * Descarga el PDF de un comprobante haciendo clic en el botón "Ver" de la fila correspondiente.
 * Primero intenta capturar el evento `download`; si el archivo se abre en una nueva pestaña
 * (como visor de PDF), captura esa pestaña y exporta con `page.pdf()`.
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {{ nroComp: string }} fila
 * @param {string} numero - Número normalizado, usado como nombre del archivo.
 * @returns {Promise<string>} Ruta absoluta del PDF descargado.
 */
async function descargarPDF(page, context, fila, numero) {
  const pdfFile = path.join(PDF_DIR, `${numero}.pdf`);

  const verLink = page.locator(`tr:has-text("${fila.nroComp}") a:has-text("Ver"), tr:has-text("${fila.nroComp}") input[value="Ver"]`).first();

  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 30000 }),
    verLink.click(),
  ]).catch(async () => {
    const [newTab] = await Promise.all([
      context.waitForEvent('page', { timeout: 10000 }),
      verLink.click(),
    ]);
    await newTab.waitForLoadState('load');
    await newTab.pdf({ path: pdfFile });
    await newTab.close();
    return [null];
  });

  if (download) await download.saveAs(pdfFile);

  return pdfFile;
}

// ── Utils ─────────────────────────────────────────────────────────────────────

/**
 * Normaliza un número de comprobante al formato PPPP-NNNNNNNN (punto de venta 4 dígitos, número 8 dígitos).
 * Ej: "2-669" → "0002-00000669".
 * @param {string} raw
 * @returns {string}
 */
function normalizarNumero(raw) {
  const limpio = raw.replace(/\s/g, '');
  const match  = limpio.match(/^(\d+)-(\d+)$/);
  if (match) {
    const pv  = String(parseInt(match[1], 10)).padStart(4, '0');
    const nro = String(parseInt(match[2], 10)).padStart(8, '0');
    return `${pv}-${nro}`;
  }
  return limpio;
}

/**
 * Convierte una fecha en formato dd/mm/aaaa al formato ISO YYYY-MM-DD.
 * @param {string} ddmmaaaa
 * @returns {string}
 */
function isoFecha(ddmmaaaa) {
  const [d, m, a] = ddmmaaaa.split('/');
  return `${a}-${m}-${d}`;
}

/**
 * Parsea un string de monto argentino a un número float.
 * Soporta tres formatos:
 * - "1.234,56" → separador de miles punto, decimal coma.
 * - "13451977.56" → un punto con ≤2 decimales.
 * - "1.234.567" → múltiples puntos como separadores de miles.
 * @param {string} str
 * @returns {number}
 */
function parsearMonto(str) {
  const limpio = str.trim().replace(/[^\d.,]/g, '');

  if (limpio.includes(',')) {
    return parseFloat(limpio.replace(/\./g, '').replace(',', '.')) || 0;
  }

  const partes = limpio.split('.');
  if (partes.length === 2 && partes[1].length <= 2) {
    return parseFloat(limpio) || 0;
  }

  return parseFloat(limpio.replace(/\./g, '')) || 0;
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Importa facturas desde RCEL para el período y filtros indicados.
 * Período por defecto: últimos 30 días.
 * @param {{ fechaDesde?: Date, fechaHasta?: Date, tipoComprobante?: number, puntoVenta?: number, forzar?: boolean }} [opts]
 * @returns {Promise<{importadas, actualizadas, omitidas, errores, numerosImportados: string[]}>}
 */
async function importarFacturas({ fechaDesde, fechaHasta, tipoComprobante, puntoVenta, forzar = false } = {}) {
  const desde = fechaDesde ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const hasta  = fechaHasta ?? new Date();

  console.log('\n══ Importación RCEL ══════════════════════════════════════');
  console.log(`  Período: ${fmtDDMMAAAA(desde)} → ${fmtDDMMAAAA(hasta)}`);
  console.log(`  Tipo: ${tipoComprobante ?? 'todos'}  PV: ${puntoVenta ?? 'todos'}  forzar: ${forzar}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });

  try {
    console.log('1. Login en ARCA...');
    const portalPage = await login(context);

    console.log('\n2. Abriendo RCEL...');
    const rcelPage = await abrirRCEL(context, portalPage);

    console.log('\n3. Seleccionando representado...');
    const repPage = await seleccionarRepresentado(rcelPage);

    console.log('\n4. Navegando a Consultas...');
    await irAConsultas(repPage);

    console.log('\n5. Completando formulario...');
    await completarFormulario(repPage, { fechaDesde: desde, fechaHasta: hasta, tipoComprobante, puntoVenta });

    console.log('\n6. Buscando y procesando...');
    const totales = await buscarYProcesar(repPage, context, { forzar });

    console.log('\n══ Resultado ═════════════════════════════════════════════');
    console.log(`  ${totales.importadas} importadas · ${totales.actualizadas} actualizadas · ${totales.omitidas} ya existían · ${totales.errores} errores`);
    return totales;

  } finally {
    await browser.close();
  }
}

module.exports = { importarFacturas };

// Ejecución directa: node scraper.js
if (require.main === module) {
  importarFacturas().catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
