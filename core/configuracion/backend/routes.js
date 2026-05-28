const { Router } = require('express');
const fs   = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../../../.env');

const VISIBLES  = ['CUIT', 'MAIL_TO'];
const SENSIBLES = ['CLAVE_FISCAL'];
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
    const trimmedValue = value.trim();
    // Detecta el caso KEY=\nvalor_huerfano (bug de instalar.bat con chcp 65001)
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
