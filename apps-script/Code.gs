// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Target Google Sheet → "Daily Dump" tab (gid 911828997)
const SPREADSHEET_ID = '1bCdyUs2-2_f-Trgujczmn7gXkZc44z3XZRiG6uucvsI';
const SHEET_GID      = 911828997;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getSheet() {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet  = ss.getSheets().find(s => s.getSheetId() === SHEET_GID);
  if (!sheet)  throw new Error('Sheet with gid ' + SHEET_GID + ' not found!');
  return sheet;
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── doPost: receives data from GitHub Actions ────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // ── MIS Upload (chunked rows) ─────────────────────────────────────────────
    if (payload.rows !== undefined) {
      const { rows, chunk, totalChunks } = payload;
      const sheet = getSheet();

      // First chunk → clear entire sheet (overwrite mode)
      if (chunk === 0) {
        sheet.clearContents();
        SpreadsheetApp.flush();
      }

      // Append this chunk's rows
      if (rows && rows.length > 0) {
        const startRow = sheet.getLastRow() + 1;
        sheet.getRange(startRow, 1, rows.length, rows[0].length)
             .setValues(rows);
        SpreadsheetApp.flush();
      }

      // Log last chunk completion time in cell A1 area
      if (chunk + 1 === totalChunks) {
        const lastRow = sheet.getLastRow();
        Logger.log('✅ Upload complete: ' + lastRow + ' rows at ' + new Date().toISOString());
      }

      return respond({
        status:   'success',
        message:  'Chunk ' + (chunk + 1) + '/' + totalChunks + ' written',
        rowsAdded: rows ? rows.length : 0,
      });
    }

    return respond({ status: 'error', message: 'Unknown payload structure' });

  } catch (err) {
    return respond({ status: 'error', message: err.message });
  }
}

// ─── doGet: health check ──────────────────────────────────────────────────────
function doGet(e) {
  return respond({
    status:  'ok',
    message: 'ParcelX MIS Web App is running ✅',
    sheet:   SPREADSHEET_ID,
    gid:     SHEET_GID,
  });
}
