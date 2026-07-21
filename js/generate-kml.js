#!/usr/bin/env node
/**
 * BirdCount KML + GPX generator (batch / CI version)
 * -------------------------------------------------------------
 * Reads a MASTER sheet listing regions (name + link to a per-region
 * spreadsheet). For each region it reads the Coordinates, Planning and
 * "Birds Lists" tabs, joins them on the sub-cell id, DROPS any cell whose
 * `Reviewed` flag is truthy, and writes one .kml AND one .gpx per region.
 *
 * KML: filled polygons, coloured by list Count, with HTML popups.
 * GPX: one closed <trk> per cell (GPX has no polygon type), metadata in
 *      <desc>, eBird checklists as <link> elements.
 *
 * Sheet layout is fixed in CONFIG below. If a tab name or column ever
 * moves, edit CONFIG only.
 * -------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

/* ======================= CONFIG (edit me) ======================= */
const MASTER_SHEET_ID = '16K0-1DoiM2B6EcBSaG8YaIUCOzQ5YbxWh-yzsEnUlRo';
const MASTER_GID = '0';
const OUTPUT_KML = 'kml';
const OUTPUT_GPX = 'gpx';

// Master sheet columns (region name + link to its spreadsheet)
const MASTER_COLS = { name: 0, link: 2 };

// Tab (worksheet) names inside each region's spreadsheet (case-sensitive).
const TABS = { coordinates: 'Coordinates', planning: 'Planning', status: 'Birds Lists' };

// Coordinates tab: Subcell, then repeating Longitude,Latitude pairs (a closed ring)
const COORD_COLS = { subCell: 0, firstCoord: 1 };

// Birds Lists tab: Sub-cell | Cluster | List1..List4 | Reviewed | Count | Priority
const STATUS_COLS = { subCell: 0, url1: 2, url2: 3, url3: 4, url4: 5, reviewed: 6, count: 7, priority: 8 };

// Planning tab: Sub-cell | Cluster | Village/Site | Approach | Walk-paths | Owner | F/NF
const PLAN_COLS = { subCell: 0, cluster: 1, site: 2, approach: 3, walkpaths: 4, owner: 5, fnf: 6 };

const REVIEWED_PATTERN = ['yes', 'y', 'reviewed', '1', 'true'];
/* ================================================================ */

// KML polygon fill colours (AABBGGRR), keyed by list Count.
const COUNT_COLORS = {
  '1': '99F27CC5', '2': '99E246A6', '3': '99B22A7E', '4': '9947002B', '0': '99999999'
};

/* ----------------------------- helpers ----------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
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
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toMap(rows, col) {
  const m = {};
  for (const r of rows) { const id = normId(r[col]); if (id) m[id] = r; }
  return m;
}

// Extract [lng, lat] pairs from a Coordinates row; ensures a closed ring.
function pointsFromCoordRow(row) {
  const pts = [];
  for (let i = COORD_COLS.firstCoord; i + 1 < row.length; i += 2) {
    const lng = row[i], lat = row[i + 1];
    if (lng === '' || lat === '' || isNaN(parseFloat(lng)) || isNaN(parseFloat(lat))) continue;
    pts.push([lng, lat]);
  }
  const n = pts.length;
  if (n && (pts[0][0] !== pts[n - 1][0] || pts[0][1] !== pts[n - 1][1])) pts.push(pts[0]);
  return pts;
}

function cellMeta(plan, status) {
  const m = { cluster: '', site: '', owner: '', approach: '', walk: '', lists: [] };
  if (plan) {
    m.cluster = clean(plan[PLAN_COLS.cluster]);
    m.site = clean(plan[PLAN_COLS.site]);
    m.owner = clean(plan[PLAN_COLS.owner]);
    m.approach = clean(plan[PLAN_COLS.approach]);
    m.walk = clean(plan[PLAN_COLS.walkpaths]);
  }
  if (status) {
    m.lists = [status[STATUS_COLS.url1], status[STATUS_COLS.url2], status[STATUS_COLS.url3], status[STATUS_COLS.url4]]
      .map(fixListUrl).filter(Boolean);
  }
  return m;
}

// Filtered, shared cell list used by BOTH exporters.
function collectCells(coordRows, statusMap, planMap) {
  const cells = [];
  let skipped = 0;
  for (const c of coordRows) {
    const rawId = c[COORD_COLS.subCell];
    const id = normId(rawId);
    if (!id) continue;
    const status = statusMap[id];
    const plan = planMap[id];
    if (status && isReviewed(status[STATUS_COLS.reviewed])) { skipped++; continue; } // drop reviewed
    const points = pointsFromCoordRow(c);
    if (!points.length) continue;
    const count = (status && status[STATUS_COLS.count]) || '0';
    cells.push({ rawId, points, count, meta: cellMeta(plan, status) });
  }
  return { cells, skipped };
}

/* --------------------------- KML building --------------------------- */

function styleBlock(id, color) {
  return `  <Style id="${id}"><LineStyle><color>641400FF</color><width>1</width></LineStyle>` +
         `<PolyStyle><color>${color}</color></PolyStyle></Style>`;
}

function descHtml(m) {
  const parts = [];
  if (m.cluster)  parts.push(`<b>Cluster</b>: ${xmlEscape(m.cluster)}`);
  if (m.site)     parts.push(`<b>Site</b>: ${xmlEscape(m.site)}`);
  if (m.owner)    parts.push(`<b>Owner</b>: ${xmlEscape(m.owner)}`);
  if (m.approach) parts.push(`<b>Approach</b>: ${xmlEscape(m.approach)}`);
  if (m.walk)     parts.push(`<b>Walk-paths</b>: ${xmlEscape(m.walk)}`);
  let html = parts.join('<br/>');
  m.lists.forEach((u, i) => { html += `<br/><a target="_blank" href="${xmlEscape(u)}">List${i + 1}</a>`; });
  return html;
}

function buildKml(name, cells) {
  const styles = Object.entries(COUNT_COLORS).map(([k, c]) => styleBlock('count-' + k, c)).join('\n');
  const placemarks = cells.map(cell => {
    const ring = cell.points.map(p => `${p[0]},${p[1]},0`).join(' ');
    const styleId = 'count-' + (COUNT_COLORS[cell.count] ? cell.count : '0');

    const subCellName = cell.rawId;
    const siteName = cell.meta.site;
    const displayName = subCellName + (siteName && String(siteName).trim() !== '' ? ', ' + siteName : '');

return `  <Placemark>\n` +
      `    <name>${xmlEscape(displayName)}</name>\n` +
      `    <description><![CDATA[${descHtml(cell.meta)}]]></description>\n` +
      `    <styleUrl>#${styleId}</styleUrl>\n` +
      `    <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>\n` +
      `  </Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>${xmlEscape(name)}</name>
${styles}
${placemarks.join('\n')}
</Document>
</kml>`;
}

/* --------------------------- GPX building --------------------------- */

function descText(m) {
  const parts = [];
  if (m.cluster)  parts.push(`Cluster: ${m.cluster}`);
  if (m.site)     parts.push(`Site: ${m.site}`);
  if (m.owner)    parts.push(`Owner: ${m.owner}`);
  if (m.approach) parts.push(`Approach: ${m.approach}`);
  if (m.walk)     parts.push(`Walk-paths: ${m.walk}`);
  return parts.join('; ');
}

function buildGpx(name, cells) {
  const trks = cells.map(cell => {
    const pts = cell.points
      .map(p => `      <trkpt lat="${p[1]}" lon="${p[0]}"></trkpt>`).join('\n');
    const desc = descText(cell.meta);
    const links = cell.meta.lists
      .map((u, i) => `    <link href="${xmlEscape(u)}"><text>List${i + 1}</text></link>`).join('\n');
    const subCellName = cell.rawId;
    const siteName = cell.meta.site;
    const displayName = subCellName + (siteName && String(siteName).trim() !== '' ? ', ' + siteName : '');

    return `  <trk>\n` +
      `    <name>${xmlEscape(displayName)}</name>\n` +
      (desc ? `    <desc>${xmlEscape(desc)}</desc>\n` : '') +
      (links ? links + '\n' : '') +
      `    <trkseg>\n${pts}\n    </trkseg>\n` +
      `  </trk>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="BirdCount" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata><name>${xmlEscape(name)}</name></metadata>
${trks.join('\n')}
</gpx>`;
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

  const { cells, skipped } = collectCells(coordRows, statusMap, planMap);
  const safe = name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
  fs.writeFileSync(path.join(OUTPUT_KML, `${safe}.kml`), buildKml(name, cells));
  fs.writeFileSync(path.join(OUTPUT_GPX, `${safe}.gpx`), buildGpx(name, cells));
  console.log(`  -> ${safe}.kml + ${safe}.gpx  (${cells.length} cells, ${skipped} reviewed skipped)`);
}

function getArg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function run() {
  fs.mkdirSync(OUTPUT_KML, { recursive: true });
  fs.mkdirSync(OUTPUT_GPX, { recursive: true });

  const cliRegion = getArg('region');
  const cliLink = getArg('link');
  if (cliRegion && cliLink) {
    console.log(`Single-region test: ${cliRegion}`);
    try { await processRegion(cliRegion, cliLink); console.log('\nDone (1 region).'); }
    catch (e) { console.error(`  x ${cliRegion}: ${e.message}`); process.exit(1); }
    return;
  }

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
