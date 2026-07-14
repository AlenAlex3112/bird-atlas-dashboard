#!/usr/bin/env node
/**
 * BirdCount KML generator (batch / CI version)
 * -------------------------------------------------------------
 * Reads a MASTER sheet listing regions (name + link to a per-region
 * spreadsheet). For each region it reads the Coordinates, Planning and
 * "Birds Lists" tabs, joins them on the sub-cell id, DROPS any cell whose
 * `Reviewed` flag is truthy, and writes one .kml per region.
 *
 * Sheet layout is fixed in CONFIG below (from the real sheets). If a tab
 * name or column ever moves, edit CONFIG only.
 * -------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

/* ======================= CONFIG (edit me) ======================= */
const MASTER_SHEET_ID = '16K0-1DoiM2B6EcBSaG8YaIUCOzQ5YbxWh-yzsEnUlRo';
const MASTER_GID = '0';
const OUTPUT_DIR = 'kml';

// Master sheet columns (region name + link to its spreadsheet)
const MASTER_COLS = { name: 0, link: 2 };

// Tab (worksheet) names inside each region's spreadsheet.
// NOTE: these must match the tab names EXACTLY (case-sensitive).
const TABS = { coordinates: 'Coordinates', planning: 'Planning', status: 'Birds Lists' };

// Coordinates tab: Subcell, then repeating Longitude,Latitude pairs (a closed ring)
const COORD_COLS = { subCell: 0, firstCoord: 1 };

// Birds Lists tab: Sub-cell | Cluster | List1..List4 | Reviewed | Count | Priority
const STATUS_COLS = { subCell: 0, url1: 2, url2: 3, url3: 4, url4: 5, reviewed: 6, count: 7, priority: 8 };

// Planning tab: Sub-cell | Cluster | Village/Site | Approach | Walk-paths | Owner | F/NF
const PLAN_COLS = { subCell: 0, cluster: 1, site: 2, approach: 3, walkpaths: 4, owner: 5, fnf: 6 };

const REVIEWED_PATTERN = ['yes', 'y', 'reviewed', '1', 'true'];
/* ================================================================ */

// KML polygon fill colours (AABBGGRR), keyed by list Count. Mirrors the app legend.
const COUNT_COLORS = {
  '1': '99F27CC5', '2': '99E246A6', '3': '99B22A7E', '4': '9947002B', '0': '99999999'
};

/* ----------------------------- helpers ----------------------------- */

// Minimal RFC-4180-ish CSV parser: handles quotes, embedded commas & newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(s => s.trim()));
}

function gvizUrl(sheetId, { gid, sheet } = {}) {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
  if (sheet) return `${base}&sheet=${encodeURIComponent(sheet)}`;
  if (gid != null) return `${base}&gid=${gid}`;
  return base;
}

function extractSheetId(link) {
  const m = String(link).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

async function fetchRows(sheetId, opts) {
  const { data } = await axios.get(gvizUrl(sheetId, opts));
  return parseCsv(data).slice(1); // drop header
}

// Normalise sub-cell ids for joining across tabs (tolerate spacing differences).
function normId(id) { return String(id || '').replace(/\s+/g, ''); }

function isReviewed(val) {
  return !!val && REVIEWED_PATTERN.indexOf(String(val).trim().toLowerCase()) >= 0;
}

function fixListUrl(url) {
  if (!url) return '';
  url = String(url).trim();
  if (!url) return '';
  return /^http/.test(url) ? url : 'http://ebird.org/ebird/view/checklist?subID=' + url;
}

function clean(v) { return String(v == null ? '' : v).replace(/^[\s,]+|[\s,]+$/g, ''); }

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toMap(rows, col) {
  const m = {};
  for (const r of rows) {
    const id = normId(r[col]);
    if (id) m[id] = r;
  }
  return m;
}

// Build a KML coordinate ring from a Coordinates row (all Lng,Lat pairs).
function ringFromCoordRow(row) {
  const pts = [];
  for (let i = COORD_COLS.firstCoord; i + 1 < row.length; i += 2) {
    const lng = row[i], lat = row[i + 1];
    if (lng === '' || lat === '' || isNaN(parseFloat(lng)) || isNaN(parseFloat(lat))) continue;
    pts.push(`${lng},${lat},0`);
  }
  if (pts.length && pts[0] !== pts[pts.length - 1]) pts.push(pts[0]); // close ring
  return pts.join(' ');
}

function description(plan, status) {
  const parts = [];
  if (plan) {
    const cluster = clean(plan[PLAN_COLS.cluster]);
    const site    = clean(plan[PLAN_COLS.site]);
    const owner   = clean(plan[PLAN_COLS.owner]);
    const approach = clean(plan[PLAN_COLS.approach]);
    const walk     = clean(plan[PLAN_COLS.walkpaths]);
    if (cluster)  parts.push(`<b>Cluster</b>: ${cluster}`);
    if (site)     parts.push(`<b>Site</b>: ${site}`);
    if (owner)    parts.push(`<b>Owner</b>: ${owner}`);
    if (approach) parts.push(`<b>Approach</b>: ${approach}`);
    if (walk)     parts.push(`<b>Walk-paths</b>: ${walk}`);
  }
  let html = parts.join('<br/>');
  if (status) {
    [status[STATUS_COLS.url1], status[STATUS_COLS.url2], status[STATUS_COLS.url3], status[STATUS_COLS.url4]]
      .map(fixListUrl)
      .forEach((u, i) => { if (u) html += `<br/><a target="_blank" href="${u}">List${i + 1}</a>`; });
  }
  return html;
}

/* --------------------------- KML building --------------------------- */

function styleBlock(id, color) {
  return `  <Style id="${id}"><LineStyle><color>641400FF</color><width>1</width></LineStyle>` +
         `<PolyStyle><color>${color}</color></PolyStyle></Style>`;
}

function buildKml(name, coordRows, statusMap, planMap) {
  const styles = Object.entries(COUNT_COLORS)
    .map(([k, c]) => styleBlock('count-' + k, c)).join('\n');

  const placemarks = [];
  let kept = 0, skipped = 0;

  for (const c of coordRows) {
    const rawId = c[COORD_COLS.subCell];
    const id = normId(rawId);
    if (!id) continue;

    const status = statusMap[id];
    const plan = planMap[id];

    if (status && isReviewed(status[STATUS_COLS.reviewed])) { skipped++; continue; } // <-- drop reviewed
    kept++;

    const count = (status && status[STATUS_COLS.count]) || '0';
    const styleId = 'count-' + (COUNT_COLORS[count] ? count : '0');

    placemarks.push(
      `  <Placemark>\n` +
      `    <name>${xmlEscape(rawId)}</name>\n` +
      `    <description><![CDATA[${description(plan, status)}]]></description>\n` +
      `    <styleUrl>#${styleId}</styleUrl>\n` +
      `    <Polygon><outerBoundaryIs><LinearRing><coordinates>` +
      `${ringFromCoordRow(c)}` +
      `</coordinates></LinearRing></outerBoundaryIs></Polygon>\n` +
      `  </Placemark>`
    );
  }

  const kml =
`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>${xmlEscape(name)}</name>
${styles}
${placemarks.join('\n')}
</Document>
</kml>`;

  return { kml, kept, skipped };
}

/* ------------------------------- main ------------------------------- */

async function processRegion(name, link) {
  const sheetId = extractSheetId(link);
  if (!sheetId) throw new Error(`could not parse sheet id from link: ${link}`);

  const coordRows = await fetchRows(sheetId, { sheet: TABS.coordinates });

  let statusMap = {}, planMap = {};
  if (TABS.status) {
    try { statusMap = toMap(await fetchRows(sheetId, { sheet: TABS.status }), STATUS_COLS.subCell); }
    catch (e) { console.warn(`  ! could not read "${TABS.status}" — reviewed filter disabled for ${name}`); }
  }
  if (TABS.planning) {
    try { planMap = toMap(await fetchRows(sheetId, { sheet: TABS.planning }), PLAN_COLS.subCell); }
    catch (e) { console.warn(`  ! could not read "${TABS.planning}" for ${name}`); }
  }

  const { kml, kept, skipped } = buildKml(name, coordRows, statusMap, planMap);
  const safe = name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
  fs.writeFileSync(path.join(OUTPUT_DIR, `${safe}.kml`), kml);
  console.log(`  -> ${safe}.kml  (${kept} cells, ${skipped} reviewed skipped)`);
}

// Tiny CLI arg reader: --key value
function getArg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // --- Single-region test mode: node generate-kml.js --region "Name" --link "<sheet url or id>"
  const cliRegion = getArg('region');
  const cliLink = getArg('link');
  if (cliRegion && cliLink) {
    console.log(`Single-region test: ${cliRegion}`);
    try { await processRegion(cliRegion, cliLink); console.log('\nDone (1 region).'); }
    catch (e) { console.error(`  x ${cliRegion}: ${e.message}`); process.exit(1); }
    return;
  }
  // --- Otherwise: full run from the master sheet ---

  const masterRows = await fetchRows(MASTER_SHEET_ID, { gid: MASTER_GID });
  let ok = 0, fail = 0;

  for (const row of masterRows) {
    const name = row[MASTER_COLS.name];
    const link = row[MASTER_COLS.link];
    if (!name || !link || !/^https?:/.test(link)) continue;

    console.log(`Region: ${name}`);
    try { await processRegion(name, link); ok++; }
    catch (e) { console.error(`  x ${name}: ${e.message}`); fail++; }
  }

  console.log(`\nDone. ${ok} generated, ${fail} failed.`);
  if (fail && !ok) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
