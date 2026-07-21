// --- js/coord-resolver.js ---
//
// Resolves a lat/lng to an atlas *leaf-map path* (e.g. "kerala/wet/alappuzha")
// so that a plain deep link of the form
//
//     .../#/?coords=LAT,LNG        (no path - emitted by the eBird extension)
//
// can be sent to the correct district/habitat map automatically.
//
// How it works: it crawls the same nested Google Sheets tree the router walks,
// collects every leaf map, and tests the point against each leaf's actual grid
// cells (the "Coordinates" tab). The leaf whose grid contains the point wins -
// which resolves district AND habitat at once, because wet cells live in the wet
// spreadsheet and dry cells in the dry one. Boundary polygons can't distinguish
// wet vs dry (same district outline), so grid membership is the source of truth.
//
// Requires: gapi.client.sheets already initialised (navbar.js does this before
// the router runs). Results are cached in-memory for the session.

const CoordResolver = (function () {

    let _rootData = null;
    let _leavesPromise = null;      // cached crawl -> Promise<[{path, mapSheetId}]>
    const _cellsCache = {};         // mapSheetId -> Promise<[{latMin,latMax,lngMin,lngMax}]>

    function getSheetId(input) {
        if (!input) return null;
        const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
        if (m && m[1]) return m[1];
        if (input.match(/^[a-zA-Z0-9_-]+$/) && input.length > 30) return input;
        return null;
    }

    async function fetchValues(sheetId, range) {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range
        });
        return (resp.result && resp.result.values) || [];
    }

    // Parse a container sheet (Sheet1!A2:E) into child items - same shape/rules
    // the router uses (name, last_sheet, link, default, boundary).
    function parseItems(rows) {
        const items = [];
        rows.forEach(function (row) {
            const name = row[0], last_sheet = row[1], link = row[2];
            if (name && last_sheet && link) {
                items.push({
                    name: name.trim(),
                    last_sheet: last_sheet.trim(),
                    sheetId: getSheetId(link.trim())
                });
            }
        });
        return items;
    }

    // Walk the entire tree, collecting each leaf's path + map-data spreadsheet id.
    async function crawl() {
        const leaves = [];
        async function walk(items, prefix) {
            for (const item of items) {
                const parts = prefix.concat([item.name.trim().toLowerCase()]);
                if (item.last_sheet === '1') {
                    if (item.sheetId) leaves.push({ path: parts.join('/'), mapSheetId: item.sheetId });
                } else if (item.sheetId) {
                    let childRows = [];
                    try {
                        childRows = await fetchValues(item.sheetId, 'Sheet1!A2:E');
                    } catch (e) {
                        console.warn('CoordResolver: could not read container', item.sheetId, e);
                    }
                    await walk(parseItems(childRows), parts);
                }
            }
        }
        await walk(_rootData, []);
        return leaves;
    }

    function getLeaves() {
        if (!_leavesPromise) _leavesPromise = crawl();
        return _leavesPromise;
    }

    // Fetch + parse a leaf's "Coordinates" tab into axis-aligned cell boxes.
    // Row layout (matches birdcount.js): [subCell, lng1, lat1, ..., lng3, lat3]
    // -> the rectangle spans (row[1],row[2]) to (row[5],row[6]).
    function getCells(mapSheetId) {
        if (!_cellsCache[mapSheetId]) {
            _cellsCache[mapSheetId] = (async function () {
                let rows = [];
                try {
                    rows = await fetchValues(mapSheetId, 'Coordinates');
                } catch (e) {
                    console.warn('CoordResolver: no Coordinates tab for', mapSheetId, e);
                    return [];
                }
                if (rows.length) rows = rows.slice(1); // drop header
                const cells = [];
                rows.forEach(function (row) {
                    const lng1 = parseFloat(row[1]), lat1 = parseFloat(row[2]);
                    const lng2 = parseFloat(row[5]), lat2 = parseFloat(row[6]);
                    if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) return;
                    cells.push({
                        latMin: Math.min(lat1, lat2), latMax: Math.max(lat1, lat2),
                        lngMin: Math.min(lng1, lng2), lngMax: Math.max(lng1, lng2)
                    });
                });
                return cells;
            })();
        }
        return _cellsCache[mapSheetId];
    }

    function leafContains(cells, lat, lng) {
        for (let i = 0; i < cells.length; i++) {
            const c = cells[i];
            if (lat >= c.latMin && lat <= c.latMax && lng >= c.lngMin && lng <= c.lngMax) return true;
        }
        return false;
    }

    // Small "locating..." overlay so the user isn't staring at a blank map
    // while the sheets are fetched on the first deep link of the session.
    function setBusy(on) {
        let el = document.getElementById('coord-resolving');
        if (on) {
            if (!el) {
                el = document.createElement('div');
                el.id = 'coord-resolving';
                el.textContent = 'Locating nearest atlas map\u2026';
                el.style.cssText =
                    'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' +
                    'z-index:2000;background:rgba(255,255,255,0.95);padding:14px 22px;' +
                    'border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.3);' +
                    'font-size:16px;color:#333;white-space:nowrap;';
                (document.querySelector('.map-parent') || document.body).appendChild(el);
            }
        } else if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
    }

    return {
        // Called once by the router with the master-sheet rows.
        init: function (rootData) { _rootData = rootData; },

        // Promise<string|null>: the leaf path whose grid contains the point
        // (e.g. "kerala/wet/alappuzha"), or null if no leaf grid contains it.
        resolve: async function (lat, lng) {
            if (isNaN(lat) || isNaN(lng) || !_rootData) return null;
            const leaves = await getLeaves();
            const results = await Promise.all(leaves.map(async function (leaf) {
                const cells = await getCells(leaf.mapSheetId);
                return leafContains(cells, lat, lng) ? leaf : null;
            }));
            const match = results.find(function (r) { return r; });
            return match ? match.path : null;
        },

        setBusy: setBusy
    };

})();
