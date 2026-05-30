const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  parcelx: {
    basicUser: process.env.PARCELX_BASIC_USER,
    basicPass: process.env.PARCELX_BASIC_PASS,
    formUser:  process.env.PARCELX_FORM_USER,
    formPass:  process.env.PARCELX_FORM_PASS,
  },
};

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get today's date in dd-mm-yyyy format (ParcelX format)
function getToday() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
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

  // Click "Non Mandatory Fields" to expand it
  log('Expanding Non Mandatory Fields...');
  await page.evaluate(() => {
    const el = document.querySelector('h4.dropdown_mis_el');
    if (el) el.click();
  });
  await sleep(1500);

  // Check "Select All" checkbox
  log('Selecting all fields...');
  const selectAll = await page.$('#selectAll');
  if (selectAll) {
    const isChecked = await selectAll.isChecked();
    if (!isChecked) await selectAll.click();
  }
  await sleep(500);

  // Check NDR checkbox (#box8)
  log('Selecting NDR checkbox...');
  const ndrBox = await page.$('#box8');
  if (ndrBox) {
    const isChecked = await ndrBox.isChecked();
    if (!isChecked) await ndrBox.click();
  }
  await sleep(500);

  // Set today's date in both From and To date fields
  const today = getToday();
  log(`Setting date range: ${today} to ${today}`);
  await page.evaluate((date) => {
    const fromDate = document.querySelector('#from_date');
    const toDate   = document.querySelector('#to_date');
    if (fromDate) { fromDate.value = date; fromDate.dispatchEvent(new Event('change')); }
    if (toDate)   { toDate.value   = date; toDate.dispatchEvent(new Event('change'));   }
  }, today);
  await sleep(500);

  // Click Search button
  log('Clicking Search...');
  await page.evaluate(() => {
    const btn = document.querySelector('#searchbtn');
    if (btn) btn.click();
  });

  // Wait for data to load (spinner disappears)
  log('Waiting for data to load...');
  await page.waitForFunction(() => {
    const loader = document.querySelector('#loader');
    return !loader || loader.style.display === 'none';
  }, { timeout: 60000 });
  await sleep(3000);

  // Click Export button and capture download
  log('Clicking Export to download CSV...');
  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 60000 }),
    page.evaluate(() => {
      const btn = document.querySelector('#btn_exportexcel');
      if (btn) btn.click();
    })
  ]);

  // Wait for download to finish and save
  const suggestedName = download.suggestedFilename() || `mis_${Date.now()}.csv`;
  const savePath = path.join(DOWNLOAD_DIR, suggestedName);
  await download.saveAs(savePath);

  log(`MIS downloaded ✅ → ${savePath}`);
  return savePath;
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
    log(`=== Done! MIS file: ${misFile} ===`);
    // NEXT: Upload to Google Sheets → will be added here
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
