const { Router } = require('express');
const fs   = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../../../.env');

const VISIBLES  = ['CUIT', 'MAIL_USER', 'MAIL_TO', 'PUNTO_VENTA'];
const SENSIBLES = ['CLAVE_FISCAL', 'MAIL_PASS'];
const PERMITIDOS = [...VISIBLES, ...SENSIBLES];

const router = Router();

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

function escribirEnv(updates) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

router.get('/', (req, res) => {
  try {
    const env = leerEnv();
    const data = {};
    for (const key of VISIBLES)  data[key] = env[key] ?? '';
    for (const key of SENSIBLES) data[key] = null; // nunca se exponen
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const updates = {};
    for (const key of PERMITIDOS) {
      const val = req.body[key];
      if (SENSIBLES.includes(key) && !val) continue; // vacío = no cambiar
      if (val !== undefined && val !== null) updates[key] = val;
    }
    if (Object.keys(updates).length) escribirEnv(updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
