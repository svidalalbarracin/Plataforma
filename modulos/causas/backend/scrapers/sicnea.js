require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { chromium } = require('playwright');
const db = require('../../../../core/database');

// ── DB helpers ────────────────────────────────────────────────────────────────

function yaExiste(numero) {
  return !!db.prepare('SELECT id FROM notificaciones_sicnea WHERE numero = ?').get(numero);
}

function estaNotificada(numero) {
  const r = db.prepare("SELECT estado FROM notificaciones_sicnea WHERE numero = ?").get(numero);
  return r?.estado === 'NOTIFICADA';
}

function guardar({ numero, motivo, fecha_notificacion, archivos_adjuntos, domicilio_procesal, estado }) {
  db.prepare(`
    INSERT INTO notificaciones_sicnea (numero, motivo, documento_ref, fecha_alta, estado)
    VALUES (?, ?, ?, ?, ?)
  `).run(numero, motivo, domicilio_procesal, fecha_notificacion, estado);
}

function actualizarEstado(numero, estado) {
  db.prepare('UPDATE notificaciones_sicnea SET estado = ? WHERE numero = ?').run(estado, numero);
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
  console.log('  Login OK');
  return page;
}

// ── Abrir SICNEA ──────────────────────────────────────────────────────────────

async function abrirSICNEA(context, portalPage) {
  const popups = [];
  context.on('page', p => popups.push(p));

  await portalPage.locator('text=SICNEA Abogados').first().click();
  await new Promise(r => setTimeout(r, 10000));

  const usuarioPage = popups.find(p => p.url().includes('UsuarioExterno')) ?? popups[popups.length - 1];
  if (!usuarioPage) throw new Error('No se abrió popup de SICNEA');

  usuarioPage.setDefaultTimeout(120000);
  await usuarioPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  await usuarioPage.click('input#cmdAceptar');
  await new Promise(r => setTimeout(r, 5000));
  await usuarioPage.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  console.log('  Frameset SICNEA cargado');
  return usuarioPage;
}

// ── Navegar a Consulta ────────────────────────────────────────────────────────

async function irAConsulta(mainPage) {
  const frame = mainPage.frames().find(f => f.url().includes('mgenInicioGen'));
  if (!frame) throw new Error('No se encontró frame de contenido');

  const url = 'https://serviciosadu2.afip.gob.ar/DIAV2/Sicnea.Web/Sicnea.WebApp/formularios/csicneaAboConsulta.aspx';
  await frame.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  console.log('  Consulta cargada');
  return frame;
}

// ── Buscar (sin filtros) y esperar resultados ─────────────────────────────────

async function buscar(frame) {
  await frame.click('input#btnBuscar');
  console.log('  Buscando... (puede tardar ~90s)');

  // Polling hasta que aparezca la tabla de resultados
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const filas = await frame.evaluate(() =>
      document.querySelectorAll('table[id*="dgd"] tbody tr, table.dgdTable tbody tr').length
    ).catch(() => 0);
    if (filas > 0) {
      console.log(`  Resultados listos (t+${(i + 1) * 5}s)`);
      return;
    }
  }
  throw new Error('Timeout esperando resultados de búsqueda (150s)');
}

// ── Extraer filas de la página actual ────────────────────────────────────────

async function extraerFilas(frame) {
  return frame.evaluate(() => {
    const filas = [];
    // La grilla puede estar en una tabla anidada — buscar por id o clase
    const table = document.querySelector('table[id*="dgd"], table.dgdTable');
    if (!table) return filas;

    table.querySelectorAll('tbody tr').forEach(tr => {
      const celdas = [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim());
      // Columnas: [0]=Numero [1]=Motivo [2]=Fecha Notificacion [3]=Archivos [4]=Domicilio [5]=Estado [6]=Ver
      if (celdas.length >= 6 && /^\d{5}NOTI/i.test(celdas[0])) {
        filas.push({
          numero:              celdas[0],
          motivo:              celdas[1] || null,
          fecha_notificacion:  celdas[2] || null,
          archivos_adjuntos:   celdas[3] || null,
          domicilio_procesal:  celdas[4] || null,
          estado:              celdas[5] || null,
        });
      }
    });
    return filas;
  });
}

// ── Paginación ────────────────────────────────────────────────────────────────

async function hayPaginaSiguiente(frame) {
  return frame.evaluate(() => {
    const link = document.getElementById('lnkSiguiente');
    return !!(link && !link.classList.contains('disabled') && link.style.display !== 'none');
  });
}

async function irAPaginaSiguiente(frame) {
  // Capturar el texto de paginación actual para detectar el cambio
  const paginaAntes = await frame.evaluate(() =>
    document.getElementById('lblCantRegistros')?.innerText || ''
  );

  await frame.locator('#lnkSiguiente').click({ timeout: 30000 });

  // Esperar hasta que el indicador de página cambie
  await frame.waitForFunction(
    prev => (document.getElementById('lblCantRegistros')?.innerText || '') !== prev,
    paginaAntes,
    { timeout: 60000 }
  );
}

// ── Función principal exportable ──────────────────────────────────────────────

async function obtenerNotificacionesSICNEA({ headless = true, limite = null } = {}) {
  const modoAuto = limite === null;

  console.log('\n══ Scraper SICNEA ════════════════════════════════════════════');
  console.log(modoAuto
    ? '  Modo: automático (para al encontrar la primera ya registrada)'
    : `  Modo: manual — límite ${limite} notificación(es)`
  );

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  context.setDefaultTimeout(120000);

  try {
    console.log('\n1. Login ARCA...');
    const portalPage = await login(context);

    console.log('\n2. Abriendo SICNEA...');
    const mainPage = await abrirSICNEA(context, portalPage);

    console.log('\n3. Navegando a Consulta...');
    const consultaFrame = await irAConsulta(mainPage);

    console.log('\n4. Ejecutando búsqueda...');
    await buscar(consultaFrame);

    console.log('\n5. Procesando notificaciones...');

    let pagina    = 1;
    let nuevas    = 0;
    let actualizadas = 0;
    let examinadas = 0;
    let detener   = false;

    while (!detener) {
      console.log(`\n  ── Página ${pagina} ──────────────────────────────────────`);
      const filas = await extraerFilas(consultaFrame);
      console.log(`  ${filas.length} fila(s) encontradas`);

      if (filas.length === 0) break;

      for (const fila of filas) {
        const numero = fila.numero?.trim();
        if (!numero) continue;

        const estado = fila.estado?.trim().toUpperCase();

        if (!yaExiste(numero)) {
          // Nueva notificación
          guardar({
            numero,
            motivo:             fila.motivo,
            fecha_notificacion: isoFecha(fila.fecha_notificacion),
            archivos_adjuntos:  fila.archivos_adjuntos,
            domicilio_procesal: fila.domicilio_procesal,
            estado,
          });
          console.log(`  [+]  ${numero}  ${estado}  ${fila.fecha_notificacion ?? ''}`);
          nuevas++;
          examinadas++;
        } else if (estado === 'NOTIFICADA' && !estaNotificada(numero)) {
          // Pasó de ENVIADA a NOTIFICADA
          actualizarEstado(numero, 'NOTIFICADA');
          console.log(`  [↑]  ${numero}  ENVIADA → NOTIFICADA`);
          actualizadas++;
          examinadas++;
        } else {
          // Ya existe con el estado correcto
          if (modoAuto) {
            console.log(`  [>>] ${numero}  ya registrada → deteniendo`);
            detener = true;
            break;
          }
          console.log(`  [=]  ${numero}  ya existe`);
          examinadas++;
        }

        if (!modoAuto && examinadas >= limite) {
          console.log(`  Límite de ${limite} alcanzado`);
          detener = true;
          break;
        }
      }

      if (detener) break;
      if (!(await hayPaginaSiguiente(consultaFrame))) break;
      console.log('  Navegando a página siguiente...');
      await irAPaginaSiguiente(consultaFrame);
      pagina++;
    }

    const ahora = new Date().toISOString();
    if (modoAuto) guardarMeta('sicnea_ultima_auto', ahora);

    console.log('\n══ Resultado ═════════════════════════════════════════════════');
    console.log(`  ${nuevas} nueva(s), ${actualizadas} actualizada(s) ENVIADA→NOTIFICADA`);
    return { nuevas, actualizadas };

  } finally {
    await browser.close();
  }
}

module.exports = { obtenerNotificacionesSICNEA };

if (require.main === module) {
  obtenerNotificacionesSICNEA({ headless: true, limite: 20 }).catch(e => {
    console.error('\nError fatal:', e.message);
    process.exit(1);
  });
}
