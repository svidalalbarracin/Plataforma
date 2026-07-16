/**
 * Módulo central de base de datos.
 *
 * Abre (o crea) la base SQLite en database/facturacion.db,
 * aplica los pragmas de rendimiento y crea todas las tablas del sistema
 * (facturación + causas PJN/TAD/SICNEA).
 *
 * Los CREATE TABLE definen el esquema final completo (una instalación nueva
 * no necesita migraciones). Las migraciones del final del archivo actualizan
 * bases creadas con versiones anteriores del esquema; todas están guardadas
 * por chequeos PRAGMA, así que son idempotentes.
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
    cuit                  TEXT,
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

// ── Biblioteca de causas ──────────────────────────────────────────────────────
// Se crea antes que las tablas de notificaciones porque estas la referencian (causa_id).

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

  CREATE TABLE IF NOT EXISTS causa_notas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    causa_id   INTEGER NOT NULL,
    texto      TEXT NOT NULL,
    fecha      TEXT NOT NULL DEFAULT (date('now', 'localtime')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (causa_id) REFERENCES causas(id) ON DELETE CASCADE
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

  CREATE TABLE IF NOT EXISTS pendientes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    descripcion       TEXT    NOT NULL,
    causa_id          INTEGER,
    fecha_limite      TEXT    NOT NULL,
    dias_aviso        INTEGER NOT NULL DEFAULT 3,
    fecha_aviso       TEXT    NOT NULL,
    nota              TEXT,
    completado        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    numero_expediente TEXT,
    caratula          TEXT,
    origen            TEXT,
    notificacion_id   INTEGER,
    notificacion_tipo TEXT,
    completado_at     TEXT,
    FOREIGN KEY (causa_id) REFERENCES causas(id) ON DELETE SET NULL
  );
`);

// ── Causas — Notificaciones (PJN / TAD / SICNEA) ─────────────────────────────

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
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    causa_id          INTEGER REFERENCES causas(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS notificaciones_tad (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha          TEXT,
    nombre         TEXT,
    mensaje        TEXT,
    numero_tramite TEXT    NOT NULL,
    archivo_path   TEXT,
    leida          INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    causa_id       INTEGER REFERENCES causas(id) ON DELETE SET NULL
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
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    causa_id       INTEGER REFERENCES causas(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS scraper_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Migraciones para bases creadas con versiones anteriores del esquema ──────
// En una instalación nueva no hacen nada (el esquema de arriba ya está completo).

// clientes.cuit pasó a ser nullable (los clientes inferidos desde causas no tienen CUIT inicial).
// SQLite no soporta ALTER COLUMN, así que se recrea la tabla solo si sigue siendo NOT NULL.
const cuitNotnull = db.prepare('PRAGMA table_info(clientes)').all()
  .find(c => c.name === 'cuit' && c.notnull === 1);
if (cuitNotnull) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE clientes_new (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre                TEXT    NOT NULL,
      cuit                  TEXT,
      email                 TEXT,
      telefono              TEXT,
      anticipo_usd          REAL,
      honorario_exito_usd   REAL,
      concepto_facturacion  TEXT
    );
    INSERT INTO clientes_new
      SELECT id, nombre, cuit, email, telefono, anticipo_usd, honorario_exito_usd, concepto_facturacion
      FROM clientes;
    DROP TABLE clientes;
    ALTER TABLE clientes_new RENAME TO clientes;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  console.log('[db] Migración: clientes.cuit ahora es nullable');
}

// pendientes ganó columnas de vínculo con notificaciones y timestamp de completado.
{
  const cols = db.prepare('PRAGMA table_info(pendientes)').all().map(c => c.name);
  const nuevos = [
    ['numero_expediente', 'TEXT'],
    ['caratula',          'TEXT'],
    ['origen',            'TEXT'],
    ['notificacion_id',   'INTEGER'],
    ['notificacion_tipo', 'TEXT'],
    ['completado_at',     'TEXT'],
  ];
  for (const [col, tipo] of nuevos) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE pendientes ADD COLUMN ${col} ${tipo}`);
    }
  }
}

// Las tablas de notificaciones ganaron causa_id (vínculo con la biblioteca de causas).
for (const tabla of ['notificaciones_pjn', 'notificaciones_tad', 'notificaciones_sicnea']) {
  const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all();
  if (!columnas.find(c => c.name === 'causa_id')) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN causa_id INTEGER REFERENCES causas(id) ON DELETE SET NULL`);
  }
}

// _pagos_old es el residuo de una migración manual vieja de pagos (renombrar,
// recrear, copiar) a la que le faltó el drop final.
db.exec('DROP TABLE IF EXISTS _pagos_old');

module.exports = db;
