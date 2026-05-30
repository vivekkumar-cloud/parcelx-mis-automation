const { chromium } = require('playwright');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parse/sync');
require('dotenv').config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  parcelx: {
    basicUser: process.env.PARCELX_BASIC_USER,
    basicPass: process.env.PARCELX_BASIC_PASS,
    formUser:  process.env.PARCELX_FORM_USER,
    formPass:  process.env.PARCELX_FORM_PASS,
  },
  google: {
    sheetId:       '1yRYizP8nTBNaVco_WOBw9nFu0MknKdFZxTmucDLIDnM',
    sheetName:     'Daily Dump',
    credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE || './credentials.json',
  },
};

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getToday() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

// ─── STEP 1: LOGIN ────────────────────────────────────────────────────────────
async function loginParcelX(page) {
  log('Logging into ParcelX...');
  await page.goto(
    `https://${CONFIG.parcelx.basicUser}:${CONFIG.parcelx.basicPass}@panel.parcelx.in/`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await sleep(2000);
  await page.fill(
    'input[name="username"], input[placeholder*="Username" i], input[type="text"]',
    CONFIG.parcelx.formUser
  );
  await page.fill('input[type="password"]', CONFIG.parcelx.formPass);
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) btn.click();
  });
  await sleep(3000);
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  log('Login successful ✅');
}

// ─── STEP 2: DOWNLOAD MIS ─────────────────────────────────────────────────────
async function downloadMIS(page, context) {
  log('Navigating to MIS Report page...');
  await page.goto('https://panel.parcelx.in/mis_report', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await sleep(2000);

  // Expand Non Mandatory Fields
  log('Expanding Non Mandatory Fields...');
  await page.evaluate(() => {
    const el = document.querySelector('h4.dropdown_mis_el');
    if (el) el.click();
  });
  await sleep(1500);

  // Check Select All
  log('Checking Select All...');
  const selectAll = await page.$('#selectAll');
  if (selectAll && !(await selectAll.isChecked())) await selectAll.click();
  await sleep(500);

  // Check NDR checkbox
  log('Checking NDR checkbox...');
  const ndrBox = await page.$('#box8');
  if (ndrBox && !(await ndrBox.isChecked())) await ndrBox.click();
  await sleep(500);

  // Set today's date
  const today = getToday();
  log(`Setting date: ${today}`);
  await page.evaluate((date) => {
    const fromDate = document.querySelector('#from_date');
    const toDate   = document.querySelector('#to_date');
    if (fromDate) { fromDate.value = date; fromDate.dispatchEvent(new Event('change')); }
    if (toDate)   { toDate.value   = date; toDate.dispatchEvent(new Event('change')); }
  }, today);
  await sleep(500);

  // Click Search
  log('Clicking Search...');
  await page.evaluate(() => document.querySelector('#searchbtn')?.click());

  // Wait for data to load
  log('Waiting for results...');
  await page.waitForFunction(() => {
    const loader = document.querySelector('#loader');
    return !loader || loader.style.display === 'none';
  }, { timeout: 90000 });
  await sleep(3000);

  // Click Export and capture download
  log('Exporting CSV...');
  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 90000 }),
    page.evaluate(() => document.querySelector('#btn_exportexcel')?.click())
  ]);

  const savePath = path.join(DOWNLOAD_DIR, download.suggestedFilename() || `mis_${Date.now()}.csv`);
  await download.saveAs(savePath);
  log(`MIS downloaded ✅ → ${savePath}`);
  return savePath;
}

// ─── STEP 3: UPLOAD TO GOOGLE SHEETS ──────────────────────────────────────────
async function uploadToGoogleSheets(csvFilePath) {
  log('Uploading to Google Sheets...');

  // Auth with service account
  const credentials = JSON.parse(fs.readFileSync(CONFIG.google.credentialsFile, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Parse CSV
  const rawCsv = fs.readFileSync(csvFilePath, 'utf8');
  const records = csv.parse(rawCsv, {
    columns: false,
    skip_empty_lines: true,
    bom: true,
  });

  log(`Parsed ${records.length} rows (including header)`);

  // Clear existing data in "Daily Dump"
  log(`Clearing sheet "${CONFIG.google.sheetName}"...`);
  await sheets.spreadsheets.values.clear({
    spreadsheetId: CONFIG.google.sheetId,
    range: `'${CONFIG.google.sheetName}'`,
  });

  // Upload all data
  log(`Writing ${records.length} rows to Google Sheets...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.google.sheetId,
    range: `'${CONFIG.google.sheetName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: records },
  });

  log(`✅ Uploaded ${records.length} rows to "${CONFIG.google.sheetName}"`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== ParcelX MIS Automation Started ===');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    await loginParcelX(page);
    const misFile = await downloadMIS(page, context);
    await uploadToGoogleSheets(misFile);
    log('=== All Done! ✅ ===');
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
