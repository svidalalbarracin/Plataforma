/**
 * Rutas API para gestión de configuración del sistema (.env).
 *
 * GET  /api/configuracion  → devuelve los campos visibles (CUIT, MAIL_TO). Los sensibles se omiten.
 * POST /api/configuracion  → actualiza uno o más campos permitidos en el archivo .env.
 *
 * @module configuracion/routes
 */
const { Router } = require('express');
const fs   = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../../../.env');

/** Campos que se devuelven en el GET (sin valor sensible). */
const VISIBLES  = ['CUIT', 'MAIL_TO'];
/** Campos que se pueden actualizar pero nunca se exponen en el GET. */
const SENSIBLES = ['CLAVE_FISCAL'];
/** Unión de todos los campos que el endpoint acepta en el POST. */
const PERMITIDOS = [...VISIBLES, ...SENSIBLES];

const router = Router();

/**
 * Lee y parsea el archivo .env como un mapa clave→valor.
 * Ignora líneas vacías y comentarios (#).
 *
 * @returns {{ [key: string]: string }} Mapa con todas las variables del .env
 */
function leerEnv() {
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return result;
}

/**
 * Escribe un conjunto de actualizaciones en el archivo .env y en process.env.
 * Maneja el bug de instalar.bat con chcp 65001 que dejaba el valor en la línea siguiente.
 *
 * @param {{ [key: string]: string }} updates - Pares clave/valor a actualizar
 */
function escribirEnv(updates) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const trimmedValue = value.trim();
    // Detecta el caso KEY=\nvalor_huérfano (bug de instalar.bat con chcp 65001)
    const regexOrfano = new RegExp(`^${key}=[ \t]*\n[^\n]+`, 'm');
    const regexNormal = new RegExp(`^${key}=[^\n]*`, 'm');
    if (regexOrfano.test(content)) {
      content = content.replace(regexOrfano, `${key}=${trimmedValue}`);
    } else if (regexNormal.test(content)) {
      content = content.replace(regexNormal, `${key}=${trimmedValue}`);
    } else {
      content = content.trimEnd() + `\n${key}=${trimmedValue}\n`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value.trim();
  }
}

/**
 * GET /api/configuracion
 * Devuelve los campos visibles. Los campos sensibles se retornan como null.
 */
router.get('/', (req, res) => {
  try {
    const env  = leerEnv();
    const data = {};
    for (const key of VISIBLES)  data[key] = env[key] ?? '';
    for (const key of SENSIBLES) data[key] = null; // nunca se exponen
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/configuracion
 * Actualiza los campos presentes en el body. Los sensibles vacíos se ignoran
 * (vacío = "no cambiar la clave fiscal").
 */
router.post('/', (req, res) => {
  try {
    const updates = {};
    for (const key of PERMITIDOS) {
      const val = req.body[key];
      if (SENSIBLES.includes(key) && !val) continue;
      if (val !== undefined && val !== null) updates[key] = val;
    }
    if (Object.keys(updates).length) escribirEnv(updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
