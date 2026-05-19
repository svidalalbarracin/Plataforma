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
    iva         REAL,
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

// Migración: permitir iva NULL
const ivaCol = db.prepare("PRAGMA table_info(facturas)").all().find(c => c.name === 'iva');
if (ivaCol && ivaCol.notnull === 1) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    ALTER TABLE facturas RENAME TO _facturas_old;
    CREATE TABLE facturas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id  INTEGER NOT NULL,
      numero      TEXT    NOT NULL UNIQUE,
      fecha       TEXT    NOT NULL,
      monto       REAL    NOT NULL,
      iva         REAL,
      monto_total REAL    NOT NULL,
      pdf_path    TEXT,
      estado      TEXT    NOT NULL DEFAULT 'impaga' CHECK(estado IN ('pagada', 'impaga')),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    );
    INSERT INTO facturas SELECT * FROM _facturas_old;
    DROP TABLE _facturas_old;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// Migración: agregar monto_neto a facturas y backfill con IVA 21%
const facturasCols = db.prepare('PRAGMA table_info(facturas)').all().map(c => c.name);
if (!facturasCols.includes('monto_neto')) {
  db.exec('ALTER TABLE facturas ADD COLUMN monto_neto REAL');
  db.exec(`
    UPDATE facturas
    SET monto_neto = ROUND(monto_total / 1.21, 2),
        iva        = ROUND(monto_total - ROUND(monto_total / 1.21, 2), 2),
        monto      = ROUND(monto_total / 1.21, 2)
  `);
}

// Migración: agregar retencion a pagos
const pagosCols = db.prepare('PRAGMA table_info(pagos)').all().map(c => c.name);
if (!pagosCols.includes('retencion')) {
  db.exec('ALTER TABLE pagos ADD COLUMN retencion REAL');
}

module.exports = db;
