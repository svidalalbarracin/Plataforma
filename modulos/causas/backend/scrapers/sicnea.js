/**
 * Scraper de SICNEA — reescrito para cubrir los dos sistemas (agosto 2026).
 *
 * Ambos sistemas (SICNEA Abogados y SICNEA II — "SICNEA Gestión de
 * comunicación y notificaciones", el servicio aduanero) son el mismo portal
 * por dentro: mismo login AFIP, mismo flujo de apertura por popups, mismo
 * árbol de sidebar con "Consulta", y muy probablemente la misma tabla
 * `dgdNotificacion` y el mismo popup de detalle (mismos ids de campo) una
 * vez adentro. Se diferencian solo por el texto del link de servicio que se
 * clickea en el portal ARCA, y se guardan en la misma tabla
 * notificaciones_sicnea, distinguidos por la columna `sistema`
 * ('abogados' | 'aduanero').
 *
 * Por qué "Consulta" y no "Ver notificaciones": el scraper que corrió en
 * producción durante meses (ver sicnea.legacy.js, y el sicnea.js real de la
 * rama `development`) entra a "Consulta" — nunca a "Ver notificaciones".
 *
 * Seguridad: Consulta lista notificaciones en cualquier ESTADO, incluidas
 * las ENVIADA que todavía no pasaron a NOTIFICADA (transición automática el
 * primer lunes desde que se enviaron) — abrir el detalle de una ENVIADA
 * antes de esa transición le arrancaría el plazo antes de tiempo, igual que
 * pasaba en "Ver notificaciones". La diferencia clave (confirmada por
 * captura el 2026-08-10): la tabla de resultados de Consulta SÍ tiene una
 * columna Estado visible en la lista, sin abrir nada — extraerFilas() la
 * lee por nombre de header (columnas por posición fija no sirven: Aduanero
 * ni siquiera tiene Cuit/Razón Social). obtenerNotificacionesSICNEA() usa
 * esa columna como regla máxima: nunca abre una fila que no diga
 * exactamente NOTIFICADA. Por eso esta función es segura para correr
 * cualquier día — no lleva guard de día de la semana. La distinción
 * sábado/domingo (corrida automática) vs entre semana (botón manual "poner
 * SICNEA al día") es una decisión de scheduler/rutas, no de este archivo.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const db   = require('../../../../core/database');

const STORAGE_DIR  = path.join(__dirname, '../../storage/sicnea');
const FECHA_LIMITE = '2026-06-01'; // no importar notificaciones anteriores a esta fecha

// Palabras clave en vez de texto literal o regex de Playwright — dos
// intentos con regex en el selector text= de Playwright fallaron en vivo
// (2026-08-10) sin poder confirmar por qué exactamente (probablemente el
// título real de la tarjeta de aduanero, "SICNEA - GESTION DE COMUNICACION
// Y NOTIFICACION ELECTRONICA ADUANERA.", viene partido en líneas de un modo
// que el regex no terminaba de cubrir). En vez de seguir ajustando un
// regex a ciegas, abrirServicioSICNEA() busca el elemento a mano con JS
// (normalizando espacios Y sacando tildes antes de comparar), que es más
// robusto que depender del selector de texto de Playwright.
const SERVICIOS = {
  abogados: { nombre: 'SICNEA Abogados',                             claves: ['sicnea', 'abogados'] },
  aduanero: { nombre: 'SICNEA Gestión de comunicación y notificaciones', claves: ['sicnea', 'gestion', 'comunicacion', 'notificaci'] },
};

// ── DB helpers ────────────────────────────────────────────────────────────────

function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_sicnea WHERE numero = ?').get(numero);
}

function guardar(sistema, { numero, dependencia, cuit_cliente, razon_social, aduana, motivo,
                             documento_ref, fecha_alta, estado, archivos_paths = [] }) {
  db.prepare(`
    INSERT INTO notificaciones_sicnea
      (numero, sistema, dependencia, cuit_cliente, razon_social, aduana, motivo,
       documento_ref, fecha_alta, estado, archivos_paths)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(numero, sistema, dependencia, cuit_cliente, razon_social, aduana, motivo,
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
  return page;
}

// ── Apertura del servicio SICNEA (Abogados o Aduanero) ────────────────────────
//
// Flujo (igual para los dos servicios, solo cambia el texto del link):
//   ARCA portal → click en el servicio ("SICNEA Abogados" o el de aduanero)
//   → popup 1: mgenEntrada.aspx (página intermedia, se ignora)
//   → popup 2: mgenEntradaUsuarioExterno.aspx (ventana real, tiene botón "Ingresar")
//   → click "Ingresar" → carga el sistema principal de SICNEA

async function abrirServicioSICNEA(context, portalPage, clavesServicio, nombreServicio) {
  const popups = [];
  context.on('page', p => popups.push(p));

  // Busca a mano (en vez de un selector de Playwright) el elemento más chico
  // cuyo texto, normalizado (espacios colapsados, sin tildes, minúscula),
  // contenga TODAS las palabras clave — y lo clickea directo con JS. Evita
  // depender del motor text= de Playwright con regex, que falló en vivo
  // (ver commit anterior) sin poder confirmar la causa exacta.
  const clickeado = await portalPage.evaluate((claves) => {
    const normalizar = s => (s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    let elegido = null, textoElegido = '';
    for (const el of document.querySelectorAll('a, button, div, td, span, h1, h2, h3, h4')) {
      const texto = normalizar(el.innerText || el.textContent);
      if (!texto) continue;
      if (claves.every(clave => texto.includes(clave))) {
        // Se queda con el más chico (menos texto propio) entre los que matchean,
        // para no clickear un contenedor grande en vez del link específico.
        if (!elegido || texto.length < textoElegido.length) {
          elegido = el;
          textoElegido = texto;
        }
      }
    }
    if (!elegido) return false;
    elegido.click();
    return true;
  }, clavesServicio);

  if (!clickeado) {
    throw new Error(`No se encontró el servicio "${nombreServicio}" en el portal ARCA`);
  }

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

// ── Navegación sidebar → Consultas → Buscar ──────────────────────────────────
//
// Flujo dentro del sistema SICNEA:
//   Hover sobre sidebar → click "Consulta/Consultas" (no "Ver Notificaciones")
//   → esperar que cargue el apartado → (opcional) filtrar Estado=NOTIFICADA
//   → click "Buscar" → esperar tabla
//
// El filtro de Estado en la búsqueda es una capa extra de seguridad (además
// del chequeo por fila en obtenerNotificacionesSICNEA): entre semana, ni
// siquiera trae las ENVIADA en el resultado. Si no se pide filtro (fin de
// semana) busca sin filtrar nada, igual que el scraper viejo probado en
// producción.

/**
 * Selecciona "NOTIFICADA" en el <select> de Estado del formulario de
 * Consulta. Lo busca por el texto de sus <option> (no por id, que no
 * conocemos) para no depender del layout exacto del form.
 * @returns {Promise<boolean>} true si encontró y pudo seleccionar la opción
 */
async function filtrarPorEstadoNotificada(frameConsulta) {
  return frameConsulta.evaluate(() => {
    const selects = [...document.querySelectorAll('select')];
    for (const sel of selects) {
      const opcion = [...sel.options].find(o => o.textContent.trim().toUpperCase() === 'NOTIFICADA');
      if (opcion) {
        sel.value = opcion.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function irAConsulta(mainPage, { soloNotificada = false } = {}) {
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

  let btnConsulta = null;
  for (const ctx of [mainPage, ...mainPage.frames()]) {
    try {
      const candidatos = ctx.locator('a, button, li, span, td, div');
      const count = await candidatos.count();
      for (let i = 0; i < count; i++) {
        const el = candidatos.nth(i);
        const texto = (await el.innerText().catch(() => '')).trim();
        if (/^consulta/i.test(texto) && !/ver.?notificaci/i.test(texto)) { btnConsulta = el; break; }
      }
      if (btnConsulta) break;
    } catch (_) {}
  }

  if (!btnConsulta) throw new Error('No se encontró "Consulta/Consultas" en el sidebar');

  await btnConsulta.hover({ timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  await btnConsulta.click();

  await new Promise(r => setTimeout(r, 5000));
  await mainPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

  const frameConsulta = mainPage.frames().find(f => f.url().includes('Consulta'));
  if (!frameConsulta) throw new Error('No se encontró el frame csicneaAboConsulta');

  if (soloNotificada) {
    const filtroAplicado = await filtrarPorEstadoNotificada(frameConsulta);
    if (!filtroAplicado) {
      console.warn('  [SICNEA] No se pudo aplicar el filtro Estado=NOTIFICADA en la búsqueda (no se encontró el <select>) — sigue solo con el chequeo por fila.');
    }
  }

  const btnBuscar = frameConsulta.locator('input[value="Buscar"], button:has-text("Buscar")').first();
  await btnBuscar.waitFor({ timeout: 15000 });
  await btnBuscar.click();

  let intentos = 0;
  while (intentos < 30) {
    await new Promise(r => setTimeout(r, 4000));
    const filas = await frameConsulta.evaluate(() => {
      const tablas = [...document.querySelectorAll('table')];
      return Math.max(...tablas.map(t => t.querySelectorAll('tbody tr').length), 0);
    }).catch(() => 0);
    intentos++;
    if (filas >= 20) break;
  }

  const tieneTabla = await frameConsulta.evaluate(
    () => !!document.getElementById('dgdNotificacion')
  ).catch(() => false);

  if (!tieneTabla) throw new Error('No se encontró la tabla dgdNotificacion');

  return frameConsulta;
}

// ── Extracción de datos ───────────────────────────────────────────────────────

// Lee las columnas por nombre de header en vez de por posición fija: Abogados
// y Aduanero pueden no tener el mismo layout (la tabla de Aduanero, por
// ejemplo, no tiene columnas de Cuit ni Razón Social, pero sí Estado —
// confirmado por captura el 2026-08-10). La columna Estado es la pieza de
// seguridad clave: es lo único que permite saber si una fila es NOTIFICADA
// (segura) o ENVIADA (todavía sin transicionar) sin abrir el detalle.
async function extraerFilas(ctx) {
  return ctx.evaluate(() => {
    const limpiar = s => s?.replace(/\s+/g, ' ').trim() || null;
    const table = document.getElementById('dgdNotificacion');
    if (!table) return [];

    const filaHeader = table.querySelector('thead tr') || table.querySelector('tr');
    const celdasHeader = [...(filaHeader?.querySelectorAll('th, td') || [])];
    const indice = {};
    celdasHeader.forEach((th, i) => {
      const texto = (limpiar(th.innerText) || '').toLowerCase();
      if (texto.includes('numero') || texto.includes('número') || texto.includes('cedula') || texto.includes('cédula')) indice.numero = i;
      else if (texto.includes('cuit')) indice.cuit = i;
      else if (texto.includes('razon') || texto.includes('razón')) indice.razon_social = i;
      else if (texto.includes('motivo')) indice.motivo = i;
      else if (texto.includes('fecha')) indice.fecha_envio = i;
      else if (texto.includes('estado')) indice.estado = i;
    });

    const filas = [];
    table.querySelectorAll('tbody tr').forEach((tr, index) => {
      const celdas = [...tr.querySelectorAll('td')].map(td => limpiar(td.innerText));
      const numero = indice.numero != null ? celdas[indice.numero] : celdas[0];
      if (!numero || !/\d/.test(numero)) return;

      const tieneVer = [...tr.querySelectorAll('td')].some(td =>
        td.innerText.trim() === 'Ver' ||
        !!td.querySelector('a, button, input[type=button], input[type=submit], input[value="Ver"]')
      );

      filas.push({
        rowIndex:     index,
        numero,
        cuit:         indice.cuit         != null ? celdas[indice.cuit]         : null,
        razon_social: indice.razon_social != null ? celdas[indice.razon_social] : null,
        motivo:       indice.motivo       != null ? celdas[indice.motivo]       : null,
        fecha_envio:  indice.fecha_envio  != null ? celdas[indice.fecha_envio]  : null,
        estado:       indice.estado       != null ? celdas[indice.estado]       : null,
        tieneVer,
      });
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
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) { /* PDF no disponible */ }
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
    const filePath = path.join(STORAGE_DIR, `${numero}_${i + 1}.pdf`);
    if (fs.existsSync(filePath)) { archivos.push(filePath); continue; }

    try {
      const downloadPromise = context.waitForEvent('download', { timeout: 60000 });
      await ctx.locator('table#dgdArchivoAdjuntos a:has-text("Ver")').nth(i).click();
      const download = await downloadPromise;
      await download.saveAs(filePath);
      archivos.push(filePath);
      await ctx.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) { /* adjunto no disponible */ }
  }
  return archivos;
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Trae notificaciones nuevas de un sistema SICNEA vía "Consulta".
 *
 * Seguridad, distinta según el día:
 * - Sábado o domingo: abrir una notificación ENVIADA (todavía sin
 *   transicionar a NOTIFICADA) es seguro, porque al no ser días hábiles la
 *   transición automática (00:00 del lunes) no corre plazos de más — mismo
 *   motivo por el que el diseño viejo de "Ver notificaciones" limitaba todo
 *   a fin de semana. Estos días se procesa cualquier fila nueva sin
 *   filtrar por Estado, para traer las ENVIADA lo antes posible.
 * - Entre semana (corrida manual "poner SICNEA al día"): regla máxima,
 *   nunca abre una fila que no diga exactamente NOTIFICADA en la columna
 *   Estado de la lista — doble capa: se filtra Estado=NOTIFICADA en la
 *   búsqueda (filtrarPorEstadoNotificada) y además se vuelve a chequear por
 *   fila antes de abrir, por si el filtro de búsqueda no se pudo aplicar.
 *
 * @param {{ sistema: 'abogados'|'aduanero', headless?: boolean, limite?: number|null }} opts
 * @returns {Promise<number>} cantidad de notificaciones nuevas guardadas
 */
async function obtenerNotificacionesSICNEA({ sistema, headless = true, limite = null }) {
  const servicio = SERVICIOS[sistema];
  if (!servicio) throw new Error(`sistema inválido: "${sistema}" (esperado "abogados" o "aduanero")`);

  const dia = new Date().getDay();
  const esFinDeSemana = dia === 6 || dia === 0;

  const modoAuto = limite === null;

  const paso = texto => {
    process.stdout.write(`  [SICNEA/${sistema}] ${texto}`.padEnd(55) + ' ');
    return () => process.stdout.write('OK!\n');
  };

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(120000);

  let nuevas = 0;

  try {
    let ok = paso('Login AFIP...');
    const portalPage = await login(context);
    ok();

    ok = paso(`Abriendo ${servicio.nombre}...`);
    const mainPage = await abrirServicioSICNEA(context, portalPage, servicio.claves, servicio.nombre);
    ok();

    ok = paso('Navegando a consultas...');
    const consultaCtx = await irAConsulta(mainPage, { soloNotificada: !esFinDeSemana });
    ok();

    ok = paso('Procesando notificaciones...');
    const filas = await extraerFilas(consultaCtx);

    // Si hay filas pero ninguna trajo Estado, la detección de esa columna
    // falló (cambió el layout de la tabla) — cortar acá en vez de saltear
    // todo en silencio para siempre (la regla máxima de arriba fallaría
    // "cerrada" sin avisar por qué nunca hay novedades).
    if (filas.length > 0 && filas.every(f => !f.estado)) {
      throw new Error('No se pudo leer la columna "Estado" de la tabla de resultados — revisar el layout, puede haber cambiado.');
    }

    let examinadas = 0, duplicadosConsecutivos = 0;

    for (const fila of filas) {
      const numero = fila.numero?.trim();
      if (!numero) continue;

      // Entre semana, regla máxima: solo se abren filas NOTIFICADA. Una
      // ENVIADA (todavía sin transicionar) se ignora sin abrir nada — no
      // cuenta como duplicado, se reintenta sola en la próxima corrida. Fin
      // de semana no filtra por Estado (ver doc de la función).
      if (!esFinDeSemana && fila.estado?.trim().toUpperCase() !== 'NOTIFICADA') continue;

      if (yaExiste(numero)) {
        if (modoAuto) {
          duplicadosConsecutivos++;
          if (duplicadosConsecutivos >= 2) break;
          examinadas++;
          continue;
        }
        examinadas++;
        if (limite && examinadas >= limite) break;
        continue;
      }

      duplicadosConsecutivos = 0;

      let detalleDatos = {}, archivosPaths = [];
      if (fila.tieneVer) {
        const detallePage = await abrirDetalle(context, consultaCtx, fila.rowIndex);
        if (detallePage) {
          detalleDatos = await extraerDetalle(detallePage);
          const fechaNotif = isoFecha(detalleDatos.fecha_alta);
          if (fechaNotif && fechaNotif < FECHA_LIMITE) {
            await detallePage.close();
            break;
          }
          archivosPaths = await descargarAdjuntos(context, detallePage, numero);
          await detallePage.close();
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      guardar(sistema, {
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

      nuevas++;
      examinadas++;
      if (limite && examinadas >= limite) break;
    }
    ok();

    if (modoAuto) guardarMeta(`sicnea_${sistema}_ultima_auto`, new Date().toISOString());
    console.log(`  [SICNEA/${sistema}] ${nuevas > 0 ? `${nuevas} nueva(s)` : 'Sin novedades'}`);
    return nuevas;

  } finally {
    await browser.close();
  }
}

module.exports = {
  obtenerNotificacionesSICNEA,
  obtenerNotificacionesAbogados: opts => obtenerNotificacionesSICNEA({ ...opts, sistema: 'abogados' }),
  obtenerNotificacionesAduanero: opts => obtenerNotificacionesSICNEA({ ...opts, sistema: 'aduanero' }),
};

// node sicnea.js [--visible] [--limite=3] [--sistema=abogados|aduanero|ambos]
if (require.main === module) {
  const args     = process.argv.slice(2);
  const headless = !args.includes('--visible');
  const limiteA  = args.find(a => a.startsWith('--limite='))?.split('=')[1];
  const sistemaA = args.find(a => a.startsWith('--sistema='))?.split('=')[1] || 'abogados';

  const opts = {
    headless,
    limite: limiteA ? parseInt(limiteA, 10) : null,
  };

  const correr = sistema => obtenerNotificacionesSICNEA({ ...opts, sistema }).catch(e => {
    console.error(`\nError fatal (${sistema}):`, e.message);
    process.exitCode = 1;
  });

  (async () => {
    if (sistemaA === 'ambos') {
      await correr('abogados');
      await correr('aduanero');
    } else {
      await correr(sistemaA);
    }
  })();
}
