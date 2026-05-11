const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '..', 'database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'facturacion.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT    NOT NULL,
    cuit      TEXT    NOT NULL,
    email     TEXT,
    telefono  TEXT
  );

  CREATE TABLE IF NOT EXISTS facturas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id  INTEGER NOT NULL,
    numero      TEXT    NOT NULL UNIQUE,
    fecha       TEXT    NOT NULL,
    monto       REAL    NOT NULL,
    iva         REAL    NOT NULL,
    monto_total REAL    NOT NULL,
    pdf_path    TEXT,
    estado      TEXT    NOT NULL DEFAULT 'impaga' CHECK(estado IN ('pagada', 'impaga')),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
  );

  CREATE TABLE IF NOT EXISTS pagos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id  INTEGER NOT NULL,
    fecha       TEXT    NOT NULL,
    monto       REAL    NOT NULL,
    nota        TEXT,
    FOREIGN KEY (factura_id) REFERENCES facturas(id)
  );
`);

module.exports = db;
