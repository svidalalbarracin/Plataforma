const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('../../../../core/database');

const PDF_DIR = path.join(__dirname, '../../storage/facturas');

const router = Router();

function pdfUrl(pdfPath) {
  return pdfPath ? '/pdfs/' + path.basename(pdfPath) : null;
}

function addComputed(f) {
  f.pdf_url = pdfUrl(f.pdf_path);
  return f;
}

router.get('/', (req, res) => {
  const { cliente_id, estado } = req.query;
  let sql = `
    SELECT f.*, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit,
      (SELECT SUM(retencion) FROM pagos WHERE factura_id = f.id) AS retencion_total,
      (SELECT COALESCE(SUM(nc.monto_total), 0) FROM facturas nc
       WHERE nc.factura_asociada_numero = f.numero) AS monto_nc_asociado
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
  `;
  const params = [];
  const where = [];
  if (cliente_id) { where.push('f.cliente_id = ?'); params.push(cliente_id); }
  if (estado)     { where.push('f.estado = ?');      params.push(estado); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY f.fecha DESC';

  res.json(db.prepare(sql).all(...params).map(addComputed));
});

// ── Helpers de exportación ────────────────────────────────────────────────────

function buildExportQuery({ cliente_id, estado, mes, anio }) {
  let sql = `
    SELECT f.*, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit,
      (SELECT SUM(retencion) FROM pagos WHERE factura_id = f.id) AS retencion_total
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
  `;
  const params = [];
  const where = [];
  if (cliente_id) { where.push('f.cliente_id = ?');            params.push(cliente_id); }
  if (estado)     { where.push('f.estado = ?');                params.push(estado); }
  if (anio)       { where.push("strftime('%Y', f.fecha) = ?"); params.push(String(anio)); }
  if (mes)        { where.push("strftime('%m', f.fecha) = ?"); params.push(String(mes).padStart(2, '0')); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY f.fecha DESC';
  return db.prepare(sql).all(...params);
}

const COLS_EXPORT = [
  { header: 'Número',     key: 'numero',          width: 22 },
  { header: 'Tipo',       key: 'tipo',            width: 8  },
  { header: 'Cliente',    key: 'cliente_nombre',  width: 36 },
  { header: 'CUIT',       key: 'cliente_cuit',    width: 16 },
  { header: 'Fecha',      key: 'fecha',           width: 13 },
  { header: 'Monto Neto', key: 'monto_neto',      width: 18, money: true },
  { header: 'IVA',        key: 'iva',             width: 16, money: true },
  { header: 'Total',      key: 'monto_total',     width: 18, money: true },
  { header: 'Retención',  key: 'retencion_total', width: 16, money: true },
  { header: 'Estado',     key: 'estado',          width: 12 },
];

// ── GET /api/facturas/exportar/excel ──────────────────────────────────────────

router.get('/exportar/excel', async (req, res) => {
  try {
    const facturas = buildExportQuery(req.query);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Plataforma';
    const ws = wb.addWorksheet('Facturas');

    ws.columns = COLS_EXPORT.map(c => ({ header: c.header, key: c.key, width: c.width }));

    const hRow = ws.getRow(1);
    hRow.font   = { bold: true, color: { argb: 'FF1E3A8A' } };
    hRow.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
    hRow.height = 18;

    facturas.forEach(f => {
      ws.addRow({
        numero:          f.numero,
        tipo:            f.tipo          ?? '',
        cliente_nombre:  f.cliente_nombre,
        cliente_cuit:    f.cliente_cuit  ?? '',
        fecha:           f.fecha,
        monto_neto:      f.monto_neto,
        iva:             f.iva,
        monto_total:     f.monto_total,
        retencion_total: f.retencion_total,
        estado:          f.estado,
      });
    });

    // Fila de totales
    const sumNeto = facturas.reduce((s, f) => s + (f.monto_neto ?? 0), 0);
    const sumIva  = facturas.reduce((s, f) => s + (f.iva  ?? 0), 0);
    const sumTot  = facturas.reduce((s, f) => s + f.monto_total, 0);
    const sumRet  = facturas.reduce((s, f) => s + (f.retencion_total ?? 0), 0);
    const n = facturas.length;

    const totRow = ws.addRow({
      numero:          `${n} factura${n !== 1 ? 's' : ''}`,
      tipo:            '', cliente_nombre: '', cliente_cuit: '',
      fecha:           'TOTAL',
      monto_neto:      sumNeto,
      iva:             sumIva,
      monto_total:     sumTot,
      retencion_total: sumRet,
      estado:          '',
    });
    totRow.font = { bold: true, color: { argb: 'FF1E3A8A' } };
    totRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
    totRow.eachCell(cell => {
      cell.border = { top: { style: 'medium', color: { argb: 'FF1E3A8A' } } };
    });

    // Formato numérico para columnas de dinero
    COLS_EXPORT.forEach((c, i) => {
      if (c.money) ws.getColumn(i + 1).numFmt = '#,##0.00';
    });

    ws.eachRow((row, idx) => {
      if (idx === ws.rowCount) return; // totales ya tiene borde
      row.eachCell(cell => {
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      });
    });

    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="facturas-${fecha}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error exportando Excel:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/facturas/exportar/pdf ────────────────────────────────────────────

router.get('/exportar/pdf', (req, res) => {
  try {
    const facturas = buildExportQuery(req.query);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="facturas-${fecha}.pdf"`);
    doc.pipe(res);

    const nombreEstudio = process.env.NOMBRE_ESTUDIO || 'Estudio Jurídico';
    const fechaExport   = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const fmtMoney = n => n != null
      ? new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
      : '—';

    // Totales generales
    const MESES_PDF = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const pdfNeto = facturas.reduce((s, f) => s + (f.monto_neto ?? 0), 0);
    const pdfIva  = facturas.reduce((s, f) => s + (f.iva  ?? 0), 0);
    const pdfTot  = facturas.reduce((s, f) => s + f.monto_total, 0);
    const pdfRet  = facturas.reduce((s, f) => s + (f.retencion_total ?? 0), 0);

    // Filtros activos descripción
    const filtrosDesc = [];
    if (req.query.cliente_id) {
      const c = db.prepare('SELECT nombre FROM clientes WHERE id = ?').get(req.query.cliente_id);
      if (c) filtrosDesc.push(`Cliente: ${c.nombre}`);
    }
    if (req.query.mes)    filtrosDesc.push(`Mes: ${MESES_PDF[Number(req.query.mes)]}`);
    if (req.query.anio)   filtrosDesc.push(`Año: ${req.query.anio}`);
    if (req.query.estado) filtrosDesc.push(`Estado: ${req.query.estado.charAt(0).toUpperCase() + req.query.estado.slice(1)}`);

    // Encabezado del documento
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#1E3A8A').text(nombreEstudio);
    doc.font('Helvetica').fontSize(9).fillColor('#64748B')
       .text(`Listado de facturas — Exportado el ${fechaExport}`);

    if (filtrosDesc.length) {
      doc.fontSize(8).fillColor('#64748B')
         .text(`Filtros: ${filtrosDesc.join('  ·  ')}`);
    }

    // Resumen de totales
    doc.fontSize(8).fillColor('#1E3A8A').font('Helvetica-Bold')
       .text(
         `${facturas.length} factura${facturas.length !== 1 ? 's' : ''}  ·  ` +
         `Neto: ${fmtMoney(pdfNeto)}  ·  IVA: ${fmtMoney(pdfIva)}  ·  ` +
         `Total: ${fmtMoney(pdfTot)}  ·  Retenciones: ${fmtMoney(pdfRet)}`
       );
    doc.moveDown(0.6);

    // Definición de columnas del PDF
    const PDF_COLS = [
      { header: 'Número',     key: 'numero',          width: 92,  align: 'left'  },
      { header: 'Tipo',       key: 'tipo',            width: 28,  align: 'center'},
      { header: 'Cliente',    key: 'cliente_nombre',  width: 132, align: 'left'  },
      { header: 'CUIT',       key: 'cliente_cuit',    width: 78,  align: 'left'  },
      { header: 'Fecha',      key: 'fecha',           width: 58,  align: 'center'},
      { header: 'Monto Neto', key: 'monto_neto',      width: 72,  align: 'right', format: fmtMoney },
      { header: 'IVA',        key: 'iva',             width: 58,  align: 'right', format: fmtMoney },
      { header: 'Total',      key: 'monto_total',     width: 72,  align: 'right', format: fmtMoney },
      { header: 'Retención',  key: 'retencion_total', width: 70,  align: 'right', format: fmtMoney },
      { header: 'Estado',     key: 'estado',          width: 48,  align: 'center'},
    ];
    const TOTAL_W  = PDF_COLS.reduce((s, c) => s + c.width, 0);
    const MARGIN   = 40;
    const HEADER_H = 20;
    const ROW_H    = 15;
    const FONT_SZ  = 7;
    const PAD      = 3;

    function drawTableHeader(y) {
      doc.rect(MARGIN, y, TOTAL_W, HEADER_H).fill('#DBEAFE');
      doc.fillColor('#1E3A8A').font('Helvetica-Bold').fontSize(FONT_SZ);
      let x = MARGIN;
      PDF_COLS.forEach(col => {
        doc.text(col.header, x + PAD, y + 6, { width: col.width - PAD * 2, align: col.align, lineBreak: false });
        x += col.width;
      });
      return y + HEADER_H;
    }

    function drawTableRow(f, y, striped) {
      if (striped) doc.rect(MARGIN, y, TOTAL_W, ROW_H).fill('#F8FAFC');
      doc.fillColor('#0F172A').font('Helvetica').fontSize(FONT_SZ);
      let x = MARGIN;
      PDF_COLS.forEach(col => {
        const raw = f[col.key];
        const val = col.format ? col.format(raw) : String(raw ?? '—');
        doc.text(val, x + PAD, y + (ROW_H - FONT_SZ) / 2 + 1, {
          width: col.width - PAD * 2, align: col.align, lineBreak: false,
        });
        x += col.width;
      });
      doc.strokeColor('#E2E8F0').lineWidth(0.5)
         .moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + TOTAL_W, y + ROW_H).stroke();
      return y + ROW_H;
    }

    let y = drawTableHeader(doc.y);

    facturas.forEach((f, i) => {
      if (y + ROW_H > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        y = drawTableHeader(doc.page.margins.top);
      }
      y = drawTableRow(f, y, i % 2 === 0);
    });

    // Fila de totales al pie de la tabla
    if (y + ROW_H > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.rect(MARGIN, y, TOTAL_W, ROW_H).fill('#DBEAFE');
    doc.fillColor('#1E3A8A').font('Helvetica-Bold').fontSize(FONT_SZ);
    const totalesData = {
      numero: `${facturas.length} factura${facturas.length !== 1 ? 's' : ''}`,
      tipo: '', cliente_nombre: 'TOTAL', cliente_cuit: '', fecha: '',
      monto_neto:      pdfNeto,
      iva:             pdfIva,
      monto_total:     pdfTot,
      retencion_total: pdfRet,
      estado: '',
    };
    let xt = MARGIN;
    PDF_COLS.forEach(col => {
      const raw = totalesData[col.key];
      const val = col.format && raw != null && raw !== '' ? col.format(raw) : String(raw ?? '');
      doc.text(val, xt + PAD, y + (ROW_H - FONT_SZ) / 2 + 1, {
        width: col.width - PAD * 2, align: col.align, lineBreak: false,
      });
      xt += col.width;
    });
    y += ROW_H;

    doc.end();
  } catch (e) {
    console.error('Error exportando PDF:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  const factura = db.prepare(`
    SELECT f.*, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json(addComputed(factura));
});

router.post('/', (req, res) => {
  const { cliente_id, numero, fecha, monto, iva } = req.body;
  if (!cliente_id || !numero || !fecha || monto == null || iva == null)
    return res.status(400).json({ error: 'cliente_id, numero, fecha, monto e iva son requeridos' });

  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ?').get(cliente_id);
  if (!cliente) return res.status(400).json({ error: 'cliente_id no existe' });

  const monto_total = Number(monto) + Number(iva);
  const monto_neto  = Math.round((monto_total / 1.21) * 100) / 100;
  const iva_calc    = Math.round((monto_total - monto_neto) * 100) / 100;

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO facturas (cliente_id, numero, fecha, monto, iva, monto_neto, monto_total)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cliente_id, numero, fecha, monto_neto, iva_calc, monto_neto, monto_total);

  res.status(201).json({ id: lastInsertRowid, cliente_id, numero, fecha, monto: monto_neto, iva: iva_calc, monto_neto, monto_total, estado: 'impaga' });
});

router.patch('/:id/estado', (req, res) => {
  const { estado } = req.body;
  if (!['pagada', 'impaga'].includes(estado))
    return res.status(400).json({ error: 'estado debe ser "pagada" o "impaga"' });

  const { changes } = db.prepare('UPDATE facturas SET estado = ? WHERE id = ?').run(estado, req.params.id);
  if (!changes) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json({ id: Number(req.params.id), estado });
});

router.delete('/:id', (req, res) => {
  const factura = db.prepare('SELECT pdf_path FROM facturas WHERE id = ?').get(req.params.id);
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

  db.prepare('DELETE FROM pagos WHERE factura_id = ?').run(req.params.id);
  db.prepare('DELETE FROM facturas WHERE id = ?').run(req.params.id);

  if (factura.pdf_path) {
    const pdfFile = path.join(PDF_DIR, path.basename(factura.pdf_path));
    try { fs.unlinkSync(pdfFile); } catch { /* ya no existía */ }
  }

  res.status(204).send();
});

module.exports = router;
