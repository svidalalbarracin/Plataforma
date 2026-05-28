const { Router } = require('express');
const db = require('../../../../core/database');

const router = Router();

function getMonthStats(anio, mes) {
  const y = String(anio);
  const m = String(mes).padStart(2, '0');

  const base = db.prepare(`
    SELECT
      COUNT(CASE WHEN tipo IS NULL OR tipo NOT LIKE 'NC%' THEN 1 END)                         AS total_facturas,
      COALESCE(SUM(CASE WHEN tipo LIKE 'NC%' THEN -monto_total ELSE monto_total END), 0)      AS total_facturado,
      COUNT(CASE WHEN estado = 'pagada' AND (tipo IS NULL OR tipo NOT LIKE 'NC%') THEN 1 END) AS cobradas,
      COUNT(CASE WHEN estado = 'impaga' AND (tipo IS NULL OR tipo NOT LIKE 'NC%') THEN 1 END) AS pendientes
    FROM facturas
    WHERE strftime('%Y', fecha) = ? AND strftime('%m', fecha) = ?
  `).get(y, m);

  const cobros = db.prepare(`
    SELECT
      COALESCE(SUM(p.monto), 0)                        AS total_cobrado,
      COALESCE(SUM(p.retencion), 0)                    AS total_retenciones
    FROM pagos p
    JOIN facturas f ON f.id = p.factura_id
    WHERE strftime('%Y', f.fecha) = ? AND strftime('%m', f.fecha) = ?
  `).get(y, m);

  return { ...base, ...cobros };
}

// GET /api/estadisticas/mes?mes=5&anio=2026
router.get('/mes', (req, res) => {
  const hoy  = new Date();
  const mes  = Number(req.query.mes  ?? hoy.getMonth() + 1);
  const anio = Number(req.query.anio ?? hoy.getFullYear());

  const actual   = getMonthStats(anio, mes);
  const prevDate = new Date(anio, mes - 2); // mes-2 porque Date usa 0-index
  const anterior = getMonthStats(prevDate.getFullYear(), prevDate.getMonth() + 1);

  res.json({ actual, anterior, mes, anio });
});

// GET /api/estadisticas/anio?anio=2026
router.get('/anio', (req, res) => {
  const hoy  = new Date();
  const anio = Number(req.query.anio ?? hoy.getFullYear());
  const y    = String(anio);

  const facturadoPorMes = db.prepare(`
    SELECT
      CAST(strftime('%m', fecha) AS INTEGER)                                                        AS mes,
      COUNT(CASE WHEN tipo IS NULL OR tipo NOT LIKE 'NC%' THEN 1 END)                              AS total_facturas,
      COALESCE(SUM(CASE WHEN tipo LIKE 'NC%' THEN -monto_total ELSE monto_total END), 0)           AS total_facturado,
      COUNT(CASE WHEN estado = 'pagada' AND (tipo IS NULL OR tipo NOT LIKE 'NC%') THEN 1 END)      AS cobradas,
      COUNT(CASE WHEN estado = 'impaga' AND (tipo IS NULL OR tipo NOT LIKE 'NC%') THEN 1 END)      AS pendientes
    FROM facturas
    WHERE strftime('%Y', fecha) = ?
    GROUP BY mes
  `).all(y);

  const cobrosPorMes = db.prepare(`
    SELECT
      CAST(strftime('%m', f.fecha) AS INTEGER) AS mes,
      COALESCE(SUM(p.monto), 0)               AS total_cobrado,
      COALESCE(SUM(p.retencion), 0)           AS total_retenciones
    FROM pagos p
    JOIN facturas f ON f.id = p.factura_id
    WHERE strftime('%Y', f.fecha) = ?
    GROUP BY mes
  `).all(y);

  const meses = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const f = facturadoPorMes.find(r => r.mes === m);
    const c = cobrosPorMes.find(r => r.mes === m);
    return {
      mes:               m,
      total_facturas:    f?.total_facturas    ?? 0,
      total_facturado:   f?.total_facturado   ?? 0,
      cobradas:          f?.cobradas          ?? 0,
      pendientes:        f?.pendientes        ?? 0,
      total_cobrado:     c?.total_cobrado     ?? 0,
      total_retenciones: c?.total_retenciones ?? 0,
    };
  });

  res.json({ anio, meses });
});

// GET /api/estadisticas/clientes-pendientes
router.get('/clientes-pendientes', (req, res) => {
  const rows = db.prepare(`
    SELECT c.nombre, c.cuit,
      COUNT(f.id)           AS facturas_count,
      SUM(f.monto_total)    AS monto_pendiente
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    WHERE f.estado = 'impaga'
    GROUP BY c.id
    ORDER BY monto_pendiente DESC
  `).all();
  res.json(rows);
});

module.exports = router;
