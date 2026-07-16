# CLAUDE.md — Instrucciones para Claude Code

## Qué es la plataforma

Aplicación Node.js que corre localmente (WSL2/Ubuntu) para gestión interna de un estudio jurídico argentino. Sirve dos módulos principales:
- **Facturación**: clientes, facturas (ARS y USD), pagos, importación desde ARCA.
- **Causas**: seguimiento de expedientes judiciales con scrapers automáticos que bajan notificaciones de tres portales del Estado (PJN, TAD, SICNEA).

Frontend HTML vanilla servido como static files por Express (sin framework JS). Base de datos SQLite (better-sqlite3). Todo corre en un solo proceso Node.

## Stack

- **Runtime**: Node.js
- **Framework**: Express 5
- **DB**: SQLite vía better-sqlite3 (WAL mode, foreign keys ON)
- **Scrapers**: Playwright (Chromium headless)
- **PDF**: pdfkit (generar), pdf-parse (leer texto)
- **Mail**: nodemailer (Gmail SMTP, App Password)
- **Scheduler**: node-cron para tareas de hora fija (mails); setInterval para el ciclo de scrapers de causas
- **Frontend**: HTML + CSS + JS vanilla

## Estructura de carpetas

```
plataforma/
├── core/
│   ├── server.js              ← punto de entrada, monta rutas y static
│   ├── database.js            ← abre SQLite, crea/migra todas las tablas
│   ├── tipoCambio.js          ← consulta tipo de cambio USD
│   ├── configuracion/
│   │   ├── backend/routes.js  ← GET/POST /api/configuracion (lee/escribe .env)
│   │   └── frontend/          ← página de configuración (CUIT, credenciales)
│   └── frontend/              ← index.html (dashboard), layout.css, layout.js
│
├── modulos/
│   ├── facturacion/
│   │   ├── backend/
│   │   │   ├── arca/scraper.js     ← scraper RCEL para importar facturas emitidas
│   │   │   ├── notificaciones.js   ← mails de facturas vencidas
│   │   │   ├── scheduler.js        ← scheduler facturación
│   │   │   └── routes/
│   │   │       ├── clientes.js, facturas.js, pagos.js
│   │   │       ├── recurrentes.js, estadisticas.js
│   │   ├── frontend/               ← HTML de cada vista
│   │   └── storage/facturas/       ← PDFs de facturas
│   │
│   └── causas/
│       ├── backend/
│       │   ├── scrapers/
│       │   │   ├── pjn.js    ← Portal Judicial (notif.pjn.gov.ar)
│       │   │   ├── tad.js    ← Trámites a Distancia (tramitesadistancia.gob.ar)
│       │   │   └── sicnea.js ← SICNEA Abogados (vía portal ARCA/AFIP)
│       │   ├── inferirCliente.js   ← parsea carátulas/PDFs para encontrar cliente
│       │   ├── notificaciones.js   ← mails de causas (resumen diario + pendientes)
│       │   ├── scheduler.js        ← scheduler causas
│       │   └── routes/
│       │       ├── notificaciones.js, biblioteca.js, pendientes.js
│       ├── frontend/               ← HTML de cada vista
│       └── storage/
│           ├── pjn/notificaciones/ ← PDFs PJN
│           ├── tad/notificaciones/ y tad/documentos_externos/
│           └── sicnea/             ← PDFs SICNEA
│
├── database/facturacion.db    ← única DB SQLite del sistema
├── .env                       ← credenciales (CUIT, CLAVE_FISCAL, PJN_*, MAIL_*)
└── package.json
```

## Base de datos

### Facturación
- **clientes** (id, nombre, cuit nullable, email, telefono, anticipo_usd, honorario_exito_usd, concepto_facturacion)
- **facturas** (id, cliente_id, numero UNIQUE, fecha, monto, iva, monto_neto, monto_total, pdf_path, estado: 'pagada'|'impaga', tipo, factura_asociada_numero, moneda: 'ARS'|'USD', tipo_cambio)
- **pagos** (id, factura_id, fecha, monto, retencion, nota)
- **facturacion_recurrente** (id, cliente_id UNIQUE, honorario_usd, activo, created_at)

### Causas - Notificaciones (las tres tablas tienen `causa_id` y `leida`)
- **notificaciones_pjn** (numero UNIQUE, numero_expediente, caratula, autor, destinatario, fecha_envio, archivo_path, leida, causa_id)
- **notificaciones_tad** (fecha, nombre, mensaje, numero_tramite, archivo_path, leida, causa_id)
- **documentos_externos_tad** (fecha_envio, nombre, numero_tramite, motivo, archivos_paths (JSON), leida)
- **notificaciones_sicnea** (numero UNIQUE, dependencia, cuit_cliente, razon_social, aduana, motivo, documento_ref, fecha_alta, estado, archivos_paths (JSON), leida, causa_id)
- **scraper_meta** (key, value) ← guarda timestamps de última ejecución

### Biblioteca de causas
- **causas** (id, numero_expediente, caratula, tipo: 'pjn'|'tad'|'sicnea'|'aduanero'|'papel', estado: 'en_tramite'|'archivada'|'cerrada', juzgado, fecha_inicio, notas)
- **causa_cliente** (causa_id, cliente_id) ← relación N:M
- **causa_notas** (causa_id, texto, fecha) ← notas manuales con timeline
- **carpetas** (causa_id, numero, ubicacion, descripcion)
- **pendientes** (descripcion, causa_id, fecha_limite, dias_aviso, fecha_aviso, nota, completado, numero_expediente, caratula, origen, notificacion_id, notificacion_tipo, completado_at)

## Scrapers — cómo funcionan

### PJN (pjn.js)
- Navega a `notif.pjn.gov.ar/recibidas`
- SSO login automático con PJN_USUARIO / PJN_CLAVE del .env
- Recorre tabla Material UI paginada (30 filas/página)
- Modo automático: para con 3 duplicados consecutivos
- Modo manual (limite > 0): procesa N filas exactas
- Descarga PDFs con click en botón por fila
- Fecha límite: no importa notificaciones anteriores a 2026-06-01

### TAD (tad.js)
- Navega a `tramitesadistancia.gob.ar`
- Login vía modal → selecciona ARCA → completa con CUIT / CLAVE_FISCAL
- Extrae las últimas 10 notificaciones de la pestaña "Notificaciones"
- Luego cambia a pestaña "Documentos Externos" y descarga solo los docs de trámites que tuvieron notificación nueva
- Para documentos externos: abre el ojo (modal), descarga todos los PDFs del modal
- Fecha límite: 2026-06-01

### SICNEA (sicnea.js)
- Login en `auth.afip.gob.ar` con CUIT / CLAVE_FISCAL
- Desde el portal ARCA hace click en "SICNEA Abogados" → abre 2 popups
- El segundo popup tiene botón "Ingresar" para entrar al sistema real
- Navega sidebar → "Consulta/Consultas" → click "Buscar" → espera tabla `dgdNotificacion`
- Por cada fila: abre detalle con botón "Ver" (abre otro popup), extrae campos del form, descarga PDF de "Imprimir" + adjuntos de `dgdArchivoAdjuntos`
- Solo corre sábados o domingos al iniciar la plataforma

## Scheduler de causas

Al iniciar el servidor:
1. Corre PJN + TAD en paralelo inmediatamente
2. Si es sábado/domingo, también corre SICNEA
3. Después de cada ciclo de scrapers:
   - `autoCrearCausas()` → por cada número de expediente nuevo en notificaciones, crea causa en tabla `causas`
   - `vincularNotificacionesPendientes()` → actualiza `causa_id` en notificaciones donde el expediente ya tiene causa
   - `inferirTodos()` → para causas sin cliente: parsea carátula (PJN), mensaje/PDF (TAD), razon_social (SICNEA) e intenta vincular/crear cliente
4. Repite PJN + TAD cada 30 minutos (configurable con CAUSAS_INTERVALO_MIN)
5. Resumen diario de notificaciones se envía a las 18:00hs
6. Aviso de pendientes del día se envía a las 9:00hs

## Inferencia de clientes (inferirCliente.js)

Cuando una causa no tiene cliente vinculado, el sistema intenta inferirlo:
- **SICNEA**: toma `razon_social` directamente (es explícito)
- **PJN**: parsea la carátula buscando patrones como `IMPUTADO: X`, `CONTRIBUYENTE: X`, `X (TF...) c/`, etc.
- **TAD**: primero intenta extraer nombre del campo `mensaje`; si falla, lee el PDF de la notificación y busca la línea `Referencia:` (que contiene el nombre del expediente en el TFN)
- Busca el cliente por nombre exacto normalizado (mayúsculas, sin puntos ni comas). Si no existe, intenta fuzzy match (uno contiene al otro). Si no hay match, crea el cliente nuevo.

## Mails

Hay dos tipos de mails enviados por el módulo de causas:
1. **Resumen diario a las 18hs**: todas las notificaciones que llegaron durante el día (filtra por `date(created_at, '-3 hours') = date('now', '-3 hours')` para hora argentina)
2. **Aviso pendientes a las 9hs**: pendientes cuya `fecha_aviso` es hoy y no están completados

## Configuración (.env)

Variables que usa el sistema:
- `PORT` (default 3000)
- `CUIT` / `CLAVE_FISCAL` → para ARCA, TAD y SICNEA
- `PJN_USUARIO` / `PJN_CLAVE` → para el portal PJN
- `MAIL_USER` / `MAIL_PASS` / `MAIL_TO` / `MAIL_HOST` / `MAIL_PORT` → Gmail con App Password
- `CAUSAS_INTERVALO_MIN` (default 30)

La página de configuración (`/configuracion`) permite editar CUIT, MAIL_TO, PJN_USUARIO y las claves (CLAVE_FISCAL, PJN_CLAVE) directamente desde el navegador, sin tocar el .env a mano. Los campos sensibles nunca se exponen en el GET.

## Rutas API

```
GET/POST /api/configuracion
GET      /api/clientes
GET      /api/facturas
GET      /api/pagos
GET      /api/recurrentes
GET      /api/estadisticas
POST     /api/importar               ← dispara scraper ARCA manualmente
GET      /api/causas/notificaciones
GET      /api/causas/biblioteca
GET      /api/causas/pendientes
```

---

## Flujo de Git

### Ramas
- `main` — producción. Solo recibe merges desde `development` cuando el código está probado y listo para lanzar.
- `development` — rama principal de trabajo. Todo parte de acá.
- `feature/*`, `fix/*`, `refactor/*` — ramas temporales que salen de `development` para trabajo específico.

### Regla de trabajo
1. El trabajo del día a día va en `development` directamente (cambios chicos, correcciones, ajustes).
2. Para cambios más grandes o funcionalidades nuevas, crear una rama desde `development`:
   ```
   git checkout development
   git checkout -b feature/nombre-descriptivo
   ```
3. Al terminar, hacer PR hacia `development`, mergear, y **eliminar la rama inmediatamente** (remota y local):
   ```
   git push origin --delete feature/nombre-descriptivo
   git branch -D feature/nombre-descriptivo
   git checkout development && git pull
   ```
4. Cuando el código en `development` está probado y se quiere lanzar, se hace PR hacia `main`.
5. Después de mergear `development` → `main`, volver a `development`. **No eliminar `development`**.

### Resumen: después de cada merge
- Si se mergeó una rama feature → eliminarla, volver a `development`.
- Si se mergeó `development` → `main` → volver a `development`. No eliminar nada.

---

## Mensajes de commits

Usar el formato **Conventional Commits**:

```
<tipo>(<scope>): <descripción corta en imperativo>

[cuerpo opcional — qué cambió y por qué, si no es obvio]
```

### Tipos
| Tipo | Cuándo usarlo |
|---|---|
| `feat` | Nueva funcionalidad |
| `fix` | Corrección de bug |
| `refactor` | Cambio de código sin agregar funcionalidad ni corregir bug |
| `chore` | Tareas de mantenimiento (deps, config, CI) |
| `docs` | Solo documentación |
| `style` | Formato, espacios, punto y coma (sin cambio de lógica) |
| `test` | Agregar o corregir tests |

### Scope
El módulo o área afectada: `causas`, `facturacion`, `scrapers`, `db`, `scheduler`, `frontend`, etc.

### Ejemplos correctos
```
feat(causas): agregar módulo de pendientes con aviso por mail
fix(scrapers): corregir timeout post-login SSO en PJN
refactor(causas): cambiar mails a resumen único diario a las 18hs
fix(calendario): corregir fechas en vista mensual por offset UTC-3
chore(deps): actualizar playwright a v1.44
```

### Reglas
- La descripción va en **minúsculas**, en **imperativo** ("agregar", "corregir", "cambiar" — no "agregado" ni "se agregó").
- Máximo 72 caracteres en la primera línea.
- Si el cambio necesita más contexto, agregar cuerpo separado por una línea en blanco.
- Siempre incluir `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` al final.

---

## Mensajes de PR y merge

### Título del PR
Mismo formato que el commit: `tipo(scope): descripción corta`.

### Cuerpo del PR
```
## Summary
- Bullet points con los cambios principales

## Test plan
- [ ] Qué se probó manualmente
- [ ] Qué hay que verificar antes de mergear
```
