/**
 * Inferencia automática de clientes a partir de notificaciones vinculadas.
 *
 * Estrategia por portal:
 * - SICNEA: razon_social es el cliente explícito → auto-crear y vincular.
 * - PJN:    parsear carátula (IMPUTADO / CONTRIBUYENTE / REQUERIDO / c/ DGA).
 * - TAD:    1º intentar campo `mensaje`; 2º fallback PDF: línea "Referencia:" del
 *           acto del TFN. Crea el cliente si no existe (el PDF es fuente oficial).
 *
 * Las funciones exportadas son async porque el fallback PDF usa pdf-parse (async).
 *
 * @module causas/inferirCliente
 */
const fs       = require('fs');
const pdfParse = require('pdf-parse');
const db       = require('../../../core/database');

// ── Helpers ───────────────────────────────────────────────────────────────────

function norm(nombre) {
  return nombre.toUpperCase()
    .replace(/\./g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Búsqueda exacta por nombre normalizado.
 */
function buscarCliente(nombre) {
  const n = norm(nombre);
  return db.prepare('SELECT id, nombre FROM clientes').all()
    .find(c => norm(c.nombre) === n) ?? null;
}

/**
 * Búsqueda fuzzy: devuelve el primer cliente cuyo nombre normalizado contiene
 * al extraído, o viceversa. Útil cuando el PDF da "MC CAIN" y la DB tiene "MC CAIN SA".
 */
function buscarClienteFuzzy(nombre) {
  const n = norm(nombre);
  return db.prepare('SELECT id, nombre FROM clientes').all()
    .find(c => {
      const cn = norm(c.nombre);
      return cn.includes(n) || n.includes(cn);
    }) ?? null;
}

function encontrarOCrear(nombre) {
  const exacto = buscarCliente(nombre);
  if (exacto) return { ...exacto, nuevo: false };
  const r = db.prepare('INSERT INTO clientes (nombre) VALUES (?)').run(nombre.trim());
  return { id: r.lastInsertRowid, nombre: nombre.trim(), nuevo: true };
}

function vincular(causaId, clienteId) {
  const existe = db.prepare(
    'SELECT id FROM causa_cliente WHERE causa_id = ? AND cliente_id = ?'
  ).get(causaId, clienteId);
  if (existe) return false;
  db.prepare('INSERT INTO causa_cliente (causa_id, cliente_id) VALUES (?, ?)').run(causaId, clienteId);
  return true;
}

// ── Extracción de nombre por portal ───────────────────────────────────────────

function extraerDePJN(caratula) {
  if (!caratula) return null;

  let s = caratula;
  const prefijo = /^(?:Incidente|Recurso\s+\w+|Auto)\s+Nº\s+\d+\s+-\s+/i;
  while (prefijo.test(s)) s = s.replace(prefijo, '').trim();

  const limpiar = str => str
    .replace(/\s+Y\s+OTROS?$/i, '')
    .replace(/\s+Y\s+OTRO$/i, '')
    .replace(/\s*\(.*?\)\s*$/, '')
    .trim();

  const patrones = [
    /IMPUTADO:\s*(.+?)(?=\s+s\/|\s+Y\s+OTRO|\s+QUERELLANTE|$)/i,
    /CONTRIBUYENTE:\s*(.+?)(?=\s+s\/|\s+Y\s+OTRO|$)/i,
    /^(.+?)\s*\(TF[\s\d\-A-Z]+\)\s+c\//i,
    /REQUERIDO:\s*(.+?)(?=\s+s\/|\s+Y\s+OTRO|$)/i,
    /^([A-Z][A-Z\s\.\-,]+?)\s+Y\s+OTRO\s+s\//i,
  ];

  for (const pat of patrones) {
    const m = s.match(pat);
    if (m) {
      const nombre = limpiar(m[1]);
      if (nombre.length > 3 && !/^N\.?N\.?$/i.test(nombre)) return nombre;
    }
  }
  return null;
}

function extraerDeTAD(mensaje) {
  if (!mensaje) return null;
  const m = mensaje.match(/^[\d\.\-]+[A-Z]?\s+([A-Z][A-Z\s\.]+(?:S\.?A\.?|S\.?R\.?L\.?|TEAM|GROUP|S\.?A\.?S\.?)?)(?:\s|$)/i);
  return m ? m[1].trim() : null;
}

/**
 * Lee un PDF y devuelve su texto plano. Devuelve null si el archivo no existe o falla.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function extraerTextoPDF(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const buf  = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return data.text ?? null;
  } catch {
    return null;
  }
}

/**
 * Extrae el nombre del cliente de la línea "Referencia:" de un acto del TFN.
 *
 * Formatos observados:
 *   Referencia: EX-2020-07566630- -APN-SGASAD#TFN Monte Verde SA
 *   Referencia: "MC CAIN" (2023-135287222)
 *   Referencia: Traslado inicial EX-2026-34118977- BARPLA S.A.
 *
 * @param {string} texto  Texto plano del PDF
 * @returns {string|null}
 */
function extraerDeTADTextoPDF(texto) {
  if (!texto) return null;

  const linea = texto.split('\n').map(l => l.trim()).find(l => /^Referencia:/i.test(l));
  if (!linea) return null;

  const contenido = linea.replace(/^Referencia:\s*/i, '').trim();

  // Formato: "NOMBRE" (referencia)
  const conComillas = contenido.match(/^"([^"]+)"/);
  if (conComillas) return conComillas[1].trim();

  // Formato: [descripción opcional] EX-YYYY-NNNNNNN- [-APN-XXX#TFN] NOMBRE
  // Se elimina todo hasta el fin del token EX (con sufijo APN opcional) y se toma el resto.
  const sinEX = contenido.replace(/^.*?EX-[\d\-]+\s*(?:-APN-[^\s]+\s*)?/, '').trim();
  if (sinEX && sinEX !== contenido && sinEX.length > 2) {
    return sinEX.replace(/\s*\(.*\)\s*$/, '').trim();
  }

  return null;
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Intenta inferir y vincular el cliente de una causa a partir de sus notificaciones.
 * Async porque el fallback PDF usa pdf-parse.
 *
 * @param {{ id: number, tipo: string, numero_expediente: string }} causa
 * @returns {Promise<{ fuente: string, nombre: string, nuevo: boolean, vinculado: boolean } | null>}
 */
async function inferirParaCausa(causa) {
  // SICNEA: razon_social es explícito
  if (causa.tipo === 'sicnea') {
    const notif = db.prepare(
      'SELECT razon_social FROM notificaciones_sicnea WHERE causa_id = ? AND razon_social IS NOT NULL LIMIT 1'
    ).get(causa.id);
    if (!notif?.razon_social) return null;

    const cliente  = encontrarOCrear(notif.razon_social);
    const vinculado = vincular(causa.id, cliente.id);
    return { fuente: 'sicnea', nombre: cliente.nombre, nuevo: cliente.nuevo, vinculado };
  }

  // PJN: parsear carátula
  if (causa.tipo === 'pjn') {
    const notif = db.prepare(
      'SELECT caratula FROM notificaciones_pjn WHERE causa_id = ? AND caratula IS NOT NULL LIMIT 1'
    ).get(causa.id);
    const nombre = extraerDePJN(notif?.caratula);
    if (!nombre) return null;

    const cliente  = encontrarOCrear(nombre);
    const vinculado = vincular(causa.id, cliente.id);
    return { fuente: 'pjn', nombre: cliente.nombre, nuevo: cliente.nuevo, vinculado };
  }

  // TAD: 1º mensaje, 2º fallback PDF
  if (causa.tipo === 'tad') {
    const notifs = db.prepare(
      'SELECT mensaje, archivo_path FROM notificaciones_tad WHERE causa_id = ? ORDER BY fecha DESC'
    ).all(causa.id);

    // Intentar primero con mensaje de cada notificación
    for (const notif of notifs) {
      const nombre = extraerDeTAD(notif.mensaje);
      if (nombre) {
        const cliente  = encontrarOCrear(nombre);
        const vinculado = vincular(causa.id, cliente.id);
        return { fuente: 'tad:mensaje', nombre: cliente.nombre, nuevo: cliente.nuevo, vinculado };
      }
    }

    // Fallback: escanear PDFs en busca de la línea Referencia:
    for (const notif of notifs) {
      if (!notif.archivo_path) continue;
      const texto  = await extraerTextoPDF(notif.archivo_path);
      const nombre = extraerDeTADTextoPDF(texto);
      if (!nombre) continue;

      // Intentar match exacto primero, luego fuzzy (ej. "MC CAIN" → "MC CAIN SA")
      const existente = buscarCliente(nombre) ?? buscarClienteFuzzy(nombre);
      if (existente) {
        const vinculado = vincular(causa.id, existente.id);
        return { fuente: 'tad:pdf', nombre: existente.nombre, nuevo: false, vinculado };
      }

      // No existe: crear desde PDF (fuente oficial)
      const nuevo    = encontrarOCrear(nombre);
      const vinculado = vincular(causa.id, nuevo.id);
      return { fuente: 'tad:pdf', nombre: nuevo.nombre, nuevo: nuevo.nuevo, vinculado };
    }

    return null;
  }

  return null;
}

/**
 * Corre la inferencia sobre todas las causas que aún no tienen clientes vinculados.
 * @returns {Promise<{ procesadas, vinculadas, nuevosClientes, sinMatch, detalle }>}
 */
async function inferirTodos() {
  const sinClientes = db.prepare(`
    SELECT c.id, c.tipo, c.numero_expediente
    FROM causas c
    WHERE NOT EXISTS (SELECT 1 FROM causa_cliente cc WHERE cc.causa_id = c.id)
  `).all();

  let vinculadas = 0, nuevosClientes = 0, sinMatch = 0;
  const detalle = [];

  for (const causa of sinClientes) {
    const r = await inferirParaCausa(causa);
    if (!r) {
      sinMatch++;
      detalle.push({ causa: causa.numero_expediente, tipo: causa.tipo, resultado: null });
    } else {
      if (r.vinculado) vinculadas++;
      if (r.nuevo)     nuevosClientes++;
      detalle.push({ causa: causa.numero_expediente, tipo: causa.tipo, resultado: r });
    }
  }

  return { procesadas: sinClientes.length, vinculadas, nuevosClientes, sinMatch, detalle };
}

/**
 * Recorre las notificaciones sin causa_id y las vincula a la causa cuyo
 * numero_expediente coincida exactamente. Se llama después de cada ciclo de scrapers,
 * antes de inferirTodos(), para que la inferencia tenga datos disponibles.
 *
 * @returns {{ pjn: number, tad: number, sicnea: number }} Cantidad de filas actualizadas por origen.
 */
function vincularNotificacionesPendientes() {
  const pjn = db.prepare(`
    UPDATE notificaciones_pjn
    SET causa_id = (SELECT id FROM causas WHERE numero_expediente = notificaciones_pjn.numero_expediente LIMIT 1)
    WHERE causa_id IS NULL
      AND numero_expediente IS NOT NULL
      AND EXISTS (SELECT 1 FROM causas WHERE numero_expediente = notificaciones_pjn.numero_expediente)
  `).run().changes;

  const tad = db.prepare(`
    UPDATE notificaciones_tad
    SET causa_id = (SELECT id FROM causas WHERE numero_expediente = notificaciones_tad.numero_tramite LIMIT 1)
    WHERE causa_id IS NULL
      AND numero_tramite IS NOT NULL
      AND EXISTS (SELECT 1 FROM causas WHERE numero_expediente = notificaciones_tad.numero_tramite)
  `).run().changes;

  const sicnea = db.prepare(`
    UPDATE notificaciones_sicnea
    SET causa_id = (SELECT id FROM causas WHERE numero_expediente = notificaciones_sicnea.documento_ref LIMIT 1)
    WHERE causa_id IS NULL
      AND documento_ref IS NOT NULL
      AND EXISTS (SELECT 1 FROM causas WHERE numero_expediente = notificaciones_sicnea.documento_ref)
  `).run().changes;

  return { pjn, tad, sicnea };
}

module.exports = { inferirParaCausa, inferirTodos, vincularNotificacionesPendientes, extraerDePJN, extraerDeTAD, extraerDeTADTextoPDF };
