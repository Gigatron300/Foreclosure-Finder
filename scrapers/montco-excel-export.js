const ExcelJS = require('exceljs');
const { parseCSVLine } = require('./camden-enrichment');

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function caseKey(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * Preserve the uploaded MontCo table while applying only two verified pipeline
 * updates: a resolved parcel number and a newer closed status.
 */
function buildUpdatedMontcoRows(sourceCsv, pipelineCases) {
  const lines = String(sourceCsv || '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error('Uploaded MontCo CSV is empty');

  const headers = parseCSVLine(lines[0]);
  if (headers.length) headers[0] = String(headers[0] || '').replace(/^\uFEFF/, '');
  const normalized = headers.map(normalizeHeader);
  const caseIndex = normalized.findIndex(h => h === 'casenumber' || h === 'caseno' || h === 'case');
  const parcelIndex = normalized.findIndex(h => h === 'parcelnumber' || h === 'parcel' || h === 'pin');
  const statusIndex = normalized.findIndex(h => h === 'status' || h === 'casestatus');
  if (caseIndex < 0 || parcelIndex < 0 || statusIndex < 0) {
    throw new Error('Uploaded MontCo CSV must contain CaseNumber, ParcelNumber, and Status columns');
  }

  const latestByCase = new Map();
  for (const c of Array.isArray(pipelineCases) ? pipelineCases : []) {
    const key = caseKey(c && c.caseNumber);
    if (key) latestByCase.set(key, c);
  }

  let parcelUpdates = 0;
  let statusUpdates = 0;
  const rows = [];
  for (const line of lines.slice(1)) {
    const fields = parseCSVLine(line);
    while (fields.length < headers.length) fields.push('');
    const current = latestByCase.get(caseKey(fields[caseIndex]));
    if (current) {
      const parcel = String(current.parcelNumber || '').trim();
      if (parcel && parcel !== String(fields[parcelIndex] || '').trim()) {
        fields[parcelIndex] = parcel;
        parcelUpdates++;
      }

      if (current.liveClosed) {
        const closedStatus = String(current.liveStatus || '').trim() || 'CLOSED';
        if (closedStatus !== String(fields[statusIndex] || '').trim()) {
          fields[statusIndex] = closedStatus;
          statusUpdates++;
        }
      }
    }
    rows.push(fields);
  }

  return { headers, rows, caseIndex, parcelIndex, statusIndex, parcelUpdates, statusUpdates };
}

async function buildUpdatedMontcoWorkbook(sourceCsv, pipelineCases) {
  const updated = buildUpdatedMontcoRows(sourceCsv, pipelineCases);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Foreclosure Finder';
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet('MontCo Cases', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  sheet.addRow(updated.headers);
  for (const row of updated.rows) sheet.addRow(row);

  sheet.eachRow(row => {
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: 'Arial', size: 10, color: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'top' };
    });
  });

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell(cell => {
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { vertical: 'middle' };
  });

  for (let i = 0; i < updated.headers.length; i++) {
    const values = [updated.headers[i], ...updated.rows.map(row => row[i] || '')];
    const width = Math.max(...values.map(value => String(value).length));
    sheet.getColumn(i + 1).width = Math.min(45, Math.max(11, width + 2));
  }
  sheet.getColumn(updated.caseIndex + 1).numFmt = '@';
  sheet.getColumn(updated.parcelIndex + 1).numFmt = '@';
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: updated.headers.length }
  };

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    rowCount: updated.rows.length,
    parcelUpdates: updated.parcelUpdates,
    statusUpdates: updated.statusUpdates
  };
}

module.exports = { buildUpdatedMontcoRows, buildUpdatedMontcoWorkbook };
