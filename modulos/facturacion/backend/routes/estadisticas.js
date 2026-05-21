const { Router } = require('express');
const db = require('../../../../core/database');

const router = Router();

function getMonthStats(anio, mes) {
  const y = String(anio);
  const m = String(mes).padStart(2, '0');

  const base = db.prepare(`
    SELECT
      COUNT(*)                                          AS total_facturas,
      COALESCE(SUM(monto_total), 0)                    AS total_facturado,
      COUNT(CASE WHEN estado = 'pagada' THEN 1 END)    AS cobradas,
      COUNT(CASE WHEN estado = 'impaga' THEN 1 END)    AS pendientes
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
