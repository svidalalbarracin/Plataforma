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

  CREATE TABLE IF NOT EXISTS facturacion_recurrente (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id    INTEGER NOT NULL UNIQUE,
    honorario_usd REAL    NOT NULL,
    activo        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (date('now')),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
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

// Fix: la migración de IVA nulo renombró facturas → _facturas_old y SQLite
// actualizó automáticamente la FK de pagos, dejándola apuntando a _facturas_old.
// Si la tabla pagos tiene esa FK rota, se recrea con la referencia correcta.
const pagosSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pagos'").get();
if (pagosSchema?.sql?.includes('_facturas_old')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE pagos RENAME TO _pagos_old;
    CREATE TABLE pagos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id  INTEGER NOT NULL,
      fecha       TEXT    NOT NULL,
      monto       REAL    NOT NULL,
      nota        TEXT,
      retencion   REAL,
      FOREIGN KEY (factura_id) REFERENCES facturas(id)
    );
    INSERT INTO pagos SELECT * FROM _pagos_old;
    DROP TABLE _pagos_old;
    PRAGMA foreign_keys = ON;
  `);
}

// Migración: agregar retencion a pagos (para DBs que no pasaron por el fix anterior)
const pagosCols = db.prepare('PRAGMA table_info(pagos)').all().map(c => c.name);
if (!pagosCols.includes('retencion')) {
  db.exec('ALTER TABLE pagos ADD COLUMN retencion REAL');
}

// Migración: agregar tipo a facturas
const facturasCols2 = db.prepare('PRAGMA table_info(facturas)').all().map(c => c.name);
if (!facturasCols2.includes('tipo')) {
  db.exec('ALTER TABLE facturas ADD COLUMN tipo TEXT');
}

// Migración: agregar factura_asociada_numero (para notas de crédito)
const facturasCols3 = db.prepare('PRAGMA table_info(facturas)').all().map(c => c.name);
if (!facturasCols3.includes('factura_asociada_numero')) {
  db.exec('ALTER TABLE facturas ADD COLUMN factura_asociada_numero TEXT');
}

// Migración: agregar moneda a facturas
const facturasCols4 = db.prepare('PRAGMA table_info(facturas)').all().map(c => c.name);
if (!facturasCols4.includes('moneda')) {
  db.exec("ALTER TABLE facturas ADD COLUMN moneda TEXT NOT NULL DEFAULT 'ARS'");
}

// Migración: agregar tipo_cambio a facturas (TC oficial al emitir, para facturas USD)
const facturasCols5 = db.prepare('PRAGMA table_info(facturas)').all().map(c => c.name);
if (!facturasCols5.includes('tipo_cambio')) {
  db.exec('ALTER TABLE facturas ADD COLUMN tipo_cambio REAL');
}

// Migración: agregar campos de facturación a clientes
const clientesCols = db.prepare('PRAGMA table_info(clientes)').all().map(c => c.name);
if (!clientesCols.includes('anticipo_usd')) {
  db.exec('ALTER TABLE clientes ADD COLUMN anticipo_usd REAL');
}
if (!clientesCols.includes('honorario_exito_usd')) {
  db.exec('ALTER TABLE clientes ADD COLUMN honorario_exito_usd REAL');
}
if (!clientesCols.includes('concepto_facturacion')) {
  db.exec('ALTER TABLE clientes ADD COLUMN concepto_facturacion TEXT');
}

// ── Causas — PJN ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS notificaciones_pjn (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    numero            TEXT    NOT NULL UNIQUE,
    numero_expediente TEXT,
    caratula          TEXT,
    autor             TEXT,
    destinatario      TEXT,
    fecha_envio       TEXT,
    leida             INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scraper_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS notificaciones_sicnea (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    numero         TEXT    NOT NULL UNIQUE,
    dependencia    TEXT,
    cuit_cliente   TEXT,
    razon_social   TEXT,
    aduana         TEXT,
    motivo         TEXT,
    documento_ref  TEXT,
    fecha_alta     TEXT,
    estado         TEXT,
    archivos_paths TEXT    NOT NULL DEFAULT '[]',
    leida          INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migración: agregar archivo_path a notificaciones_pjn
const pjnCols = db.prepare('PRAGMA table_info(notificaciones_pjn)').all().map(c => c.name);
if (!pjnCols.includes('archivo_path')) {
  db.exec('ALTER TABLE notificaciones_pjn ADD COLUMN archivo_path TEXT');
}

// ── Causas — TAD ──────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS notificaciones_tad (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha          TEXT,
    nombre         TEXT,
    mensaje        TEXT,
    numero_tramite TEXT    NOT NULL,
    archivo_path   TEXT,
    leida          INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS documentos_externos_tad (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_envio    TEXT,
    nombre         TEXT,
    numero_tramite TEXT    NOT NULL,
    motivo         TEXT,
    archivos_paths TEXT,
    leida          INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
