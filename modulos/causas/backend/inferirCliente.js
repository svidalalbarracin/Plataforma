/**
 * Inferencia automática de clientes a partir de notificaciones vinculadas.
 *
 * Estrategia por portal:
 * - SICNEA: razon_social es el cliente explícito → auto-crear y vincular siempre.
 * - PJN:    parsear carátula buscando IMPUTADO / CONTRIBUYENTE / REQUERIDO /
 *           nombre c/ DGA → crear y vincular si el patrón es confiable.
 * - TAD:    buscar nombre en el campo `mensaje` → vincular solo si ya existe
 *           el cliente en la tabla (no crear desde TAD).
 *
 * @module causas/inferirCliente
 */
const db = require('../../../core/database');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normaliza un nombre para comparación: mayúsculas, sin puntuación duplicada,
 * sin espacios extra. Permite comparar "S.A." con "SA" y similares.
 * @param {string} nombre
 * @returns {string}
 */
function norm(nombre) {
  return nombre.toUpperCase()
    .replace(/\./g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca un cliente existente por nombre normalizado.
 * @param {string} nombre
 * @returns {{ id: number, nombre: string } | null}
 */
function buscarCliente(nombre) {
  const n = norm(nombre);
  return db.prepare('SELECT id, nombre FROM clientes').all()
    .find(c => norm(c.nombre) === n) ?? null;
}

/**
 * Busca o crea un cliente por nombre. Devuelve el cliente y si fue creado.
 * @param {string} nombre
 * @returns {{ id: number, nombre: string, nuevo: boolean }}
 */
function encontrarOCrear(nombre) {
  const existente = buscarCliente(nombre);
  if (existente) return { ...existente, nuevo: false };
  const r = db.prepare('INSERT INTO clientes (nombre) VALUES (?)').run(nombre.trim());
  return { id: r.lastInsertRowid, nombre: nombre.trim(), nuevo: true };
}

/**
 * Vincula un cliente a una causa si el vínculo no existe aún.
 * @param {number} causaId
 * @param {number} clienteId
 * @returns {boolean} true si se insertó, false si ya existía
 */
function vincular(causaId, clienteId) {
  const existe = db.prepare(
    'SELECT id FROM causa_cliente WHERE causa_id = ? AND cliente_id = ?'
  ).get(causaId, clienteId);
  if (existe) return false;
  db.prepare('INSERT INTO causa_cliente (causa_id, cliente_id) VALUES (?, ?)').run(causaId, clienteId);
  return true;
}

// ── Extracción de nombre por portal ───────────────────────────────────────────

/**
 * Extrae el nombre del cliente de una carátula PJN.
 *
 * Prioridad de patrones:
 * 1. IMPUTADO (el más confiable en causas penales/aduaneras)
 * 2. CONTRIBUYENTE (causas fiscales)
 * 3. Nombre c/ DGA (formato "EMPRESA c/ DGA")
 * 4. REQUERIDO
 * 5. Nombre Y OTRO s/ (cuando el cliente encabeza la carátula)
 *
 * Los prefijos "Incidente Nº X -" y "Recurso Nº X -" se eliminan antes.
 *
 * @param {string|null} caratula
 * @returns {string|null} Nombre extraído o null si no se pudo parsear
 */
function extraerDePJN(caratula) {
  if (!caratula) return null;

  // Eliminar prefijos anidados de incidente/recurso (puede haber más de uno)
  let s = caratula;
  const prefijo = /^(?:Incidente|Recurso\s+\w+|Auto)\s+Nº\s+\d+\s+-\s+/i;
  while (prefijo.test(s)) s = s.replace(prefijo, '').trim();

  const limpiar = str => str
    .replace(/\s+Y\s+OTROS?$/i, '')
    .replace(/\s+Y\s+OTRO$/i, '')
    .replace(/\s*\(.*?\)\s*$/, '')
    .trim();

  const patrones = [
    // IMPUTADO: NOMBRE  s/ o Y OTROS
    /IMPUTADO:\s*(.+?)(?=\s+s\/|\s+Y\s+OTRO|\s+QUERELLANTE|$)/i,
    // CONTRIBUYENTE: NOMBRE  s/ o Y OTROS
    /CONTRIBUYENTE:\s*(.+?)(?=\s+s\/|\s+Y\s+OTRO|$)/i,
    // NOMBRE (TF 12345-A) c/ DGA
    /^(.+?)\s*\(TF[\s\d\-A-Z]+\)\s+c\//i,
    // REQUERIDO: NOMBRE
    /REQUERIDO:\s*(.+?)(?=\s+s\/|\s+Y\s+OTRO|$)/i,
    // NOMBRE Y OTRO s/  (nombre encabeza la carátula)
    /^([A-Z][A-Z\s\.\-,]+?)\s+Y\s+OTRO\s+s\//i,
  ];

  for (const pat of patrones) {
    const m = s.match(pat);
    if (m) {
      const nombre = limpiar(m[1]);
      // Descartar "N.N.", nombres vacíos o demasiado cortos
      if (nombre.length > 3 && !/^N\.?N\.?$/i.test(nombre)) {
        return nombre;
      }
    }
  }

  return null;
}

/**
 * Extrae el nombre del cliente del campo `mensaje` de una notificación TAD.
 * El formato habitual es "34.900-A NOMBRE EMPRESA S.A." al inicio del mensaje.
 *
 * @param {string|null} mensaje
 * @returns {string|null}
 */
function extraerDeTAD(mensaje) {
  if (!mensaje) return null;
  // "34.900-A NOMBRE" o "EXP 12345 NOMBRE" al inicio
  const m = mensaje.match(/^[\d\.\-]+[A-Z]?\s+([A-Z][A-Z\s\.]+(?:S\.?A\.?|S\.?R\.?L\.?|TEAM|GROUP|S\.?A\.?S\.?)?)(?:\s|$)/i);
  if (m) return m[1].trim();
  return null;
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Resultado de una inferencia individual.
 * @typedef {{ fuente: string, nombre: string, nuevo: boolean, vinculado: boolean } | null} ResultadoInferencia
 */

/**
 * Intenta inferir y vincular el cliente de una causa a partir de sus notificaciones.
 *
 * @param {{ id: number, tipo: string, numero_expediente: string }} causa
 * @returns {{ fuente: string, nombre: string, nuevo: boolean, vinculado: boolean } | null}
 */
function inferirParaCausa(causa) {
  // SICNEA: razon_social es explícito
  if (causa.tipo === 'sicnea') {
    const notif = db.prepare(
      'SELECT razon_social FROM notificaciones_sicnea WHERE causa_id = ? AND razon_social IS NOT NULL LIMIT 1'
    ).get(causa.id);
    if (!notif?.razon_social) return null;

    const cliente = encontrarOCrear(notif.razon_social);
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

    const cliente = encontrarOCrear(nombre);
    const vinculado = vincular(causa.id, cliente.id);
    return { fuente: 'pjn', nombre: cliente.nombre, nuevo: cliente.nuevo, vinculado };
  }

  // TAD: solo vincular si el cliente ya existe, no crear
  if (causa.tipo === 'tad') {
    const notif = db.prepare(
      'SELECT mensaje FROM notificaciones_tad WHERE causa_id = ? AND mensaje IS NOT NULL LIMIT 1'
    ).get(causa.id);
    const nombre = extraerDeTAD(notif?.mensaje);
    if (!nombre) return null;

    const existente = buscarCliente(nombre);
    if (!existente) return null; // TAD no crea clientes nuevos

    const vinculado = vincular(causa.id, existente.id);
    return { fuente: 'tad', nombre: existente.nombre, nuevo: false, vinculado };
  }

  return null;
}

/**
 * Corre la inferencia sobre todas las causas que aún no tienen clientes vinculados.
 * Devuelve un resumen de lo que se procesó.
 *
 * @returns {{ procesadas: number, vinculadas: number, nuevosClientes: number, sinMatch: number, detalle: Array }}
 */
function inferirTodos() {
  const sinClientes = db.prepare(`
    SELECT c.id, c.tipo, c.numero_expediente
    FROM causas c
    WHERE NOT EXISTS (SELECT 1 FROM causa_cliente cc WHERE cc.causa_id = c.id)
  `).all();

  let vinculadas = 0, nuevosClientes = 0, sinMatch = 0;
  const detalle = [];

  for (const causa of sinClientes) {
    const r = inferirParaCausa(causa);
    if (!r) {
      sinMatch++;
      detalle.push({ causa: causa.numero_expediente, tipo: causa.tipo, resultado: null });
    } else {
      if (r.vinculado)   vinculadas++;
      if (r.nuevo)       nuevosClientes++;
      detalle.push({ causa: causa.numero_expediente, tipo: causa.tipo, resultado: r });
    }
  }

  return { procesadas: sinClientes.length, vinculadas, nuevosClientes, sinMatch, detalle };
}

module.exports = { inferirParaCausa, inferirTodos, extraerDePJN, extraerDeTAD };
