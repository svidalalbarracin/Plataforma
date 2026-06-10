/**
 * Módulo central de base de datos.
 *
 * Abre (o crea) la base SQLite en database/facturacion.db,
 * aplica los pragmas de rendimiento y crea/migra todas las tablas
 * del sistema (facturación + causas PJN/TAD/SICNEA).
 *
 * @module database
 * @returns {import('better-sqlite3').Database} Instancia sincrónica de better-sqlite3
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const dbDir = path.join(__dirname, '..', 'database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'facturacion.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Tablas de facturación ─────────────────────────────────────────────────────

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

// ── Migraciones de facturación ────────────────────────────────────────────────

// Migración: permitir iva NULL (DBs antiguas lo tenían NOT NULL)
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

// Migración: agregar columnas nuevas a facturas.
// Se consulta una sola vez luego de la posible re-creación de tabla anterior.
const facturasCols = db.prepare('PRAGMA table_info(facturas)').all().map(c => c.name);

if (!facturasCols.includes('monto_neto')) {
  db.exec('ALTER TABLE facturas ADD COLUMN monto_neto REAL');
  // Backfill con IVA 21% para facturas existentes
  db.exec(`
    UPDATE facturas
    SET monto_neto = ROUND(monto_total / 1.21, 2),
        iva        = ROUND(monto_total - ROUND(monto_total / 1.21, 2), 2),
        monto      = ROUND(monto_total / 1.21, 2)
  `);
}
if (!facturasCols.includes('tipo'))                   db.exec('ALTER TABLE facturas ADD COLUMN tipo TEXT');
if (!facturasCols.includes('factura_asociada_numero')) db.exec('ALTER TABLE facturas ADD COLUMN factura_asociada_numero TEXT');
if (!facturasCols.includes('moneda'))                  db.exec("ALTER TABLE facturas ADD COLUMN moneda TEXT NOT NULL DEFAULT 'ARS'");
if (!facturasCols.includes('tipo_cambio'))             db.exec('ALTER TABLE facturas ADD COLUMN tipo_cambio REAL');

// Migración: la re-creación de facturas durante la migración de iva NULL
// dejó la FK de pagos apuntando a _facturas_old. Se corrige recreando la tabla.
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

const pagosCols = db.prepare('PRAGMA table_info(pagos)').all().map(c => c.name);
if (!pagosCols.includes('retencion')) db.exec('ALTER TABLE pagos ADD COLUMN retencion REAL');

// Migración: campos de facturación por cliente
const clientesCols = db.prepare('PRAGMA table_info(clientes)').all().map(c => c.name);
if (!clientesCols.includes('anticipo_usd'))         db.exec('ALTER TABLE clientes ADD COLUMN anticipo_usd REAL');
if (!clientesCols.includes('honorario_exito_usd'))  db.exec('ALTER TABLE clientes ADD COLUMN honorario_exito_usd REAL');
if (!clientesCols.includes('concepto_facturacion')) db.exec('ALTER TABLE clientes ADD COLUMN concepto_facturacion TEXT');

// ── Tablas de causas — PJN ────────────────────────────────────────────────────

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

const pjnCols = db.prepare('PRAGMA table_info(notificaciones_pjn)').all().map(c => c.name);
if (!pjnCols.includes('archivo_path')) db.exec('ALTER TABLE notificaciones_pjn ADD COLUMN archivo_path TEXT');

// ── Tablas de causas — TAD ────────────────────────────────────────────────────

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

// ── Tablas de causas — SICNEA ─────────────────────────────────────────────────

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

module.exports = db;
