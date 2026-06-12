/**
 * Módulo central de base de datos.
 *
 * Abre (o crea) la base SQLite en database/facturacion.db,
 * aplica los pragmas de rendimiento y crea todas las tablas del sistema
 * (facturación + causas PJN/TAD/SICNEA).
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

// ── Facturación ───────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre                TEXT    NOT NULL,
    cuit                  TEXT    NOT NULL,
    email                 TEXT,
    telefono              TEXT,
    anticipo_usd          REAL,
    honorario_exito_usd   REAL,
    concepto_facturacion  TEXT
  );

  CREATE TABLE IF NOT EXISTS facturas (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id               INTEGER NOT NULL,
    numero                   TEXT    NOT NULL UNIQUE,
    fecha                    TEXT    NOT NULL,
    monto                    REAL    NOT NULL,
    iva                      REAL,
    monto_neto               REAL,
    monto_total              REAL    NOT NULL,
    pdf_path                 TEXT,
    estado                   TEXT    NOT NULL DEFAULT 'impaga' CHECK(estado IN ('pagada', 'impaga')),
    tipo                     TEXT,
    factura_asociada_numero  TEXT,
    moneda                   TEXT    NOT NULL DEFAULT 'ARS',
    tipo_cambio              REAL,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
  );

  CREATE TABLE IF NOT EXISTS pagos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id  INTEGER NOT NULL,
    fecha       TEXT    NOT NULL,
    monto       REAL    NOT NULL,
    retencion   REAL,
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

// ── Causas — PJN ──────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS notificaciones_pjn (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    numero            TEXT    NOT NULL UNIQUE,
    numero_expediente TEXT,
    caratula          TEXT,
    autor             TEXT,
    destinatario      TEXT,
    fecha_envio       TEXT,
    archivo_path      TEXT,
    leida             INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scraper_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

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

// ── Causas — SICNEA ───────────────────────────────────────────────────────────

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

// ── Biblioteca — Causas ───────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS causas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_expediente TEXT,
    caratula          TEXT,
    tipo              TEXT NOT NULL CHECK(tipo IN ('pjn','tad','sicnea','aduanero','papel')),
    estado            TEXT NOT NULL DEFAULT 'en_tramite' CHECK(estado IN ('en_tramite','archivada','cerrada')),
    juzgado           TEXT,
    fecha_inicio      TEXT,
    notas             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS causa_cliente (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    causa_id   INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL,
    UNIQUE (causa_id, cliente_id),
    FOREIGN KEY (causa_id)   REFERENCES causas(id)   ON DELETE CASCADE,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS carpetas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    causa_id    INTEGER,
    numero      TEXT,
    ubicacion   TEXT,
    descripcion TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (causa_id) REFERENCES causas(id) ON DELETE SET NULL
  );
`);

// Agrega causa_id a las tablas de notificaciones si todavía no existe.
// SQLite no soporta ALTER TABLE ADD COLUMN IF NOT EXISTS, así que se verifica
// con PRAGMA antes de intentar la migración.
for (const tabla of ['notificaciones_pjn', 'notificaciones_tad', 'notificaciones_sicnea']) {
  const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all();
  if (!columnas.find(c => c.name === 'causa_id')) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN causa_id INTEGER REFERENCES causas(id) ON DELETE SET NULL`);
  }
}

module.exports = db;
