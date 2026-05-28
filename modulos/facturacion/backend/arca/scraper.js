require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const pdfParse = require('pdf-parse');
const db   = require('../../../../core/database');

const PDF_DIR = path.join(__dirname, '../../storage/facturas');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDDMMAAAA(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

function mapearTipo(tipoComp) {
  if (!tipoComp) return null;
  const t = tipoComp.trim();
  if (/Factura\s+A\b/i.test(t))                  return 'A';
  if (/Factura\s+B\b/i.test(t))                  return 'B';
  if (/Factura\s+C\b/i.test(t))                  return 'C';
  if (/Nota\s+de\s+Cr[eé]dito\s+A\b/i.test(t))          return 'NC A';
  if (/Nota\s+de\s+Cr[eé]dito\s+B\b/i.test(t))          return 'NC B';
  if (/Nota\s+de\s+Cr[eé]dito\s+C\b/i.test(t))          return 'NC C';
  if (/Nota\s+de\s+Cr[eé]dito/i.test(t))                return 'NC';
  if (/FCE|Factura\s+de\s+Cr[eé]dito/i.test(t))         return 'FCE';
  if (/Factura\s+de\s+Exportaci[oó]n|Exportaci[oó]n/i.test(t)) return 'E';
  return t || null;
}

// ── Helpers de tipo ───────────────────────────────────────────────────────────

function esNotaCredito(tipo) {
  return tipo != null && tipo.startsWith('NC');
}

// ── Extracción de nombre desde PDF ───────────────────────────────────────────

async function extraerNombreDesedePDF(pdfPath) {
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

// ── Detección de moneda desde PDF ────────────────────────────────────────────

async function extraerMoneda(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);
    // ARCA indica "Moneda: USD - Dólar Estadounidense" o "Moneda: Pesos Argentinos"
    const m = text.match(/Moneda:\s*([^\n]{3,60})/i);
    if (m && /d[oó]lar|USD/i.test(m[1])) return 'USD';
  } catch (e) {
    console.warn(`  [warn] No se pudo detectar moneda de ${path.basename(pdfPath)}: ${e.message}`);
  }
  return 'ARS';
}

async function extraerTipoCambio(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);
    // ARCA: "tipo de cambio consignado de 1349.000000"
    const m = text.match(/tipo de cambio\D{0,30}?([\d]+(?:[.,]\d+)?)/i);
    if (m) return parseFloat(m[1].replace(',', '.'));
  } catch (e) {
    console.warn(`  [warn] No se pudo extraer tipo de cambio de ${path.basename(pdfPath)}: ${e.message}`);
  }
  return null;
}

// ── Extracción de comprobante asociado desde PDF (para notas de crédito) ─────

async function extraerComprobanteAsociado(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const { text } = await pdfParse(buf);

    // Patrón ARCA más común: "Fac. A: 00002-00000669" en descripción del ítem
    const m0 = text.match(/Fac\.\s+[A-Z]:\s*(\d{1,5}-\d{6,8})/i);
    if (m0) return normalizarNumero(m0[1]);

    // Patrón alternativo: sección "Comprobante Asociado" con PV-NRO
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

function obtenerOCrearCliente(nroDoc, nombre = null) {
  const cuit = String(nroDoc);
  let cliente = db.prepare('SELECT id, nombre FROM clientes WHERE cuit = ?').get(cuit);

  if (cliente) {
    // Actualizar nombre si el actual es solo el CUIT y ahora tenemos el nombre real
    if (nombre && cliente.nombre === cuit) {
      db.prepare('UPDATE clientes SET nombre = ? WHERE cuit = ?').run(nombre, cuit);
    }
    return cliente.id;
  }

  const nombreGuardar = nombre ?? cuit;
  const res = db.prepare('INSERT INTO clientes (nombre, cuit) VALUES (?, ?)').run(nombreGuardar, cuit);
  return res.lastInsertRowid;
}

function yaImportada(numero) {
  return !!db.prepare('SELECT id FROM facturas WHERE numero = ?').get(numero);
}

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

// ── Parseo de tabla ───────────────────────────────────────────────────────────

async function extraerFilas(page) {
  return page.evaluate(() => {
    const filas = [];
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
      // Espera al menos 7 columnas y que la primera sea una fecha (dd/mm/aaaa)
      if (celdas.length >= 7 && /^\d{2}\/\d{2}\/\d{4}$/.test(celdas[0])) {
        filas.push({
          fecha:       celdas[0],   // dd/mm/aaaa
          tipoComp:    celdas[1],
          nroComp:     celdas[2],   // puede ser "PPPP-NNNNNNN" o similar
          tipoDoc:     celdas[3],
          nroDoc:      celdas[4],
          cae:         celdas[5],
          importeTotal: celdas[6],
        });
      }
    });
    return filas;
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function login(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  console.log('  Navegando a afip.gob.ar...');
  await page.goto('https://www.afip.gob.ar/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // El click en "Ingresar con Clave Fiscal" abre nueva pestaña
  const [authPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 30000 }),
    page.locator('a:has-text("Ingresar con Clave Fiscal"), a:has-text("ingresar")').first().click(),
  ]).catch(async () => {
    // Fallback: navegar directo al login
    console.log('  Fallback: navegando directo al login...');
    await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', { waitUntil: 'load', timeout: 60000 });
    return [page];
  });

  const auth = authPage ?? page;
  auth.setDefaultTimeout(60000);
  await auth.waitForLoadState('load');

  console.log('  Ingresando CUIT...');
  await auth.fill('#F1\\:username', process.env.CUIT);
  await auth.click('#F1\\:btnSiguiente');
  await auth.waitForLoadState('load');

  console.log('  Ingresando clave fiscal...');
  await auth.fill('#F1\\:password', process.env.CLAVE_FISCAL);
  await auth.click('#F1\\:btnIngresar');

  // ARCA redirige por múltiples pasos (SAML/SSO) antes de llegar al portal.
  // Esperamos a que la URL final contenga 'portalcf'; si no llega en 60s, falló.
  const llegóAlPortal = await auth.waitForURL(/portalcf/, { timeout: 60000 })
    .then(() => true)
    .catch(() => false);

  if (!llegóAlPortal) {
    console.error('  [login] URL final:', auth.url());
    console.error('  [login] Texto:', (await auth.textContent('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 500));
    throw new Error(`Login fallido. URL actual: ${auth.url()}`);
  }
  console.log('  Login OK');
  return auth; // página del portal de servicios
}

// ── Navegar a RCEL ────────────────────────────────────────────────────────────

async function abrirRCEL(context, portalPage) {
  console.log('  Buscando "Comprobantes en línea"...');

  // El click abre nueva pestaña
  const [rcelPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 30000 }),
    portalPage.locator('text=Comprobantes en línea').first().click(),
  ]);
  rcelPage.setDefaultTimeout(60000);
  await rcelPage.waitForLoadState('load');
  console.log('  RCEL abierto:', rcelPage.url());
  return rcelPage;
}

// ── Seleccionar representado ──────────────────────────────────────────────────

async function seleccionarRepresentado(rcelPage) {
  console.log('  Seleccionando representado (CUIT del abogado)...');

  // Esperar a que la página cargue contenido
  await rcelPage.waitForLoadState('load');

  // El portal muestra un <input type="button" class="btn_empresa"> por cada empresa
  // El onclick setea el hidden idContribuyente y hace submit del form
  await rcelPage.waitForSelector('input.btn_empresa', { timeout: 20000 });
  await rcelPage.locator('input.btn_empresa').first().click();
  await rcelPage.waitForLoadState('load');

  console.log('  Representado seleccionado:', rcelPage.url());
  return rcelPage;
}

// ── Navegar a Consultas ───────────────────────────────────────────────────────

async function irAConsultas(page) {
  console.log('  Haciendo click en "Consultas"...');
  await page.locator('a:has-text("Consultas")').first().click();
  await page.waitForLoadState('load');
  console.log('  En Consultas:', page.url());
}

// ── Completar formulario de consulta ─────────────────────────────────────────

async function completarFormulario(page, { fechaDesde, fechaHasta, tipoComprobante, puntoVenta }) {
  console.log('  Completando formulario de consulta...');

  const desde = fmtDDMMAAAA(fechaDesde);
  const hasta = fmtDDMMAAAA(fechaHasta);

  // Fechas
  const inputDesde = page.locator('input[name*="esde"], input[id*="esde"]').first();
  const inputHasta = page.locator('input[name*="asta"], input[id*="asta"]').first();
  await inputDesde.fill(desde);
  await inputHasta.fill(hasta);

  // Tipo de comprobante (dropdown)
  if (tipoComprobante != null) {
    const selectTipo = page.locator('select').first();
    await selectTipo.selectOption({ value: String(tipoComprobante) }).catch(() => null);
  }

  // Punto de venta (dropdown)
  if (puntoVenta != null) {
    const selectPV = page.locator('select').nth(1);
    await selectPV.selectOption({ value: String(puntoVenta) }).catch(() => null);
  }

  console.log(`  Formulario: ${desde} → ${hasta}  tipo=${tipoComprobante ?? 'todos'}  PV=${puntoVenta ?? 'todos'}`);
}

// ── Buscar y procesar resultados ──────────────────────────────────────────────

async function buscarYProcesar(page, context, { forzar = false } = {}) {
  console.log('  Haciendo click en "Buscar"...');
  await page.locator('input[type="submit"], button[type="submit"], input[value*="uscar"]').first().click();
  await page.waitForLoadState('load');

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

    if (existe && !forzar) {
      omitidas++;
      continue;
    }

    try {
      const montoTotal = parsearMonto(fila.importeTotal);
      console.log(`  [raw] ${numero}  importe="${fila.importeTotal}" → ${montoTotal}`);

      const pdfPath   = await descargarPDF(page, context, fila, numero);
      const nombre    = await extraerNombreDesedePDF(pdfPath);
      if (nombre) console.log(`  [nombre] ${nombre}`);
      const clienteId = obtenerOCrearCliente(fila.nroDoc, nombre);
      const fecha     = isoFecha(fila.fecha);
      const tipo      = mapearTipo(fila.tipoComp);

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

// ── Descargar PDF ─────────────────────────────────────────────────────────────

async function descargarPDF(page, context, fila, numero) {
  const pdfFile = path.join(PDF_DIR, `${numero}.pdf`);

  // Buscar el botón/link "Ver" en la misma fila
  const verLink = page.locator(`tr:has-text("${fila.nroComp}") a:has-text("Ver"), tr:has-text("${fila.nroComp}") input[value="Ver"]`).first();

  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 30000 }),
    verLink.click(),
  ]).catch(async () => {
    // Si no dispara download, puede abrirse en nueva pestaña como PDF
    const [newTab] = await Promise.all([
      context.waitForEvent('page', { timeout: 10000 }),
      verLink.click(),
    ]);
    await newTab.waitForLoadState('load');
    // Guardar el contenido de la pestaña como PDF
    await newTab.pdf({ path: pdfFile });
    await newTab.close();
    return [null];
  });

  if (download) {
    await download.saveAs(pdfFile);
  }

  return pdfFile;
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function normalizarNumero(raw) {
  const limpio = raw.replace(/\s/g, '');
  const match = limpio.match(/^(\d+)-(\d+)$/);
  if (match) {
    const pv  = String(parseInt(match[1], 10)).padStart(4, '0');
    const nro = String(parseInt(match[2], 10)).padStart(8, '0');
    return `${pv}-${nro}`;
  }
  return limpio;
}

function isoFecha(ddmmaaaa) {
  const [d, m, a] = ddmmaaaa.split('/');
  return `${a}-${m}-${d}`;
}

function parsearMonto(str) {
  const limpio = str.trim().replace(/[^\d.,]/g, '');

  if (limpio.includes(',')) {
    // "1.234,56" → punto=miles, coma=decimal
    return parseFloat(limpio.replace(/\./g, '').replace(',', '.')) || 0;
  }

  const partes = limpio.split('.');
  if (partes.length === 2 && partes[1].length <= 2) {
    // Un solo punto con ≤2 decimales → es separador decimal ("13451977.56")
    return parseFloat(limpio) || 0;
  }

  // Sin coma y múltiples puntos, o punto con 3 dígitos → separadores de miles
  return parseFloat(limpio.replace(/\./g, '')) || 0;
}

// ── Función principal exportable ──────────────────────────────────────────────

async function importarFacturas({ fechaDesde, fechaHasta, tipoComprobante, puntoVenta, forzar = false } = {}) {
  const desde = fechaDesde ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const hasta  = fechaHasta ?? new Date();

  console.log('\n══ Importación RCEL ══════════════════════════════════════');
  console.log(`  Período: ${fmtDDMMAAAA(desde)} → ${fmtDDMMAAAA(hasta)}`);
  console.log(`  Tipo: ${tipoComprobante ?? 'todos'}  PV: ${puntoVenta ?? 'todos'}  forzar: ${forzar}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
  });

  try {
    // 1. Login
    console.log('1. Login en ARCA...');
    const portalPage = await login(context);

    // 2. Abrir RCEL (Comprobantes en línea)
    console.log('\n2. Abriendo RCEL...');
    const rcelPage = await abrirRCEL(context, portalPage);

    // 3. Seleccionar representado
    console.log('\n3. Seleccionando representado...');
    const repPage = await seleccionarRepresentado(rcelPage);

    // 4. Ir a Consultas
    console.log('\n4. Navegando a Consultas...');
    await irAConsultas(repPage);

    // 5. Completar formulario
    console.log('\n5. Completando formulario...');
    await completarFormulario(repPage, { fechaDesde: desde, fechaHasta: hasta, tipoComprobante, puntoVenta });

    // 6. Buscar y procesar
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
