// --- birdcount.js (Phase 7: All Features - Leaflet Native) ---

const BirdCount = (function () {
    const $ = jQuery;

    const infoBoxTemplate = _.template('<span><b><%=subCell%></b></span>' + // Changed to subCell
        '<%if (clusterName && !_.isEmpty(clusterName.trim())){%><br/><b>Cluster</b>: <%=clusterName%><%}%>' + // Optional: Moved Cluster Name here
        '<%if (site && !_.isEmpty(site.trim())){%><br/><b>Site</b>: <%=site%><%}%>' +
        '<%if (owner && !_.isEmpty(owner.trim())){%><br/><b>Owner</b>: <%=owner%><%}%>' +
        '<%if (!_.isEmpty(listUrl["1"])){%><br/><a target="_blank" href="<%=listUrl["1"]%>">List1</a><%}%>' +
        '<%if (!_.isEmpty(listUrl["2"])){%> <a target="_blank" href="<%=listUrl["2"]%>">List2</a><%}%>' +
        '<%if (!_.isEmpty(listUrl["3"])){%> <a target="_blank" href="<%=listUrl["3"]%>">List3</a><%}%>' +
        '<%if (!_.isEmpty(listUrl["4"])){%> <a target="_blank" href="<%=listUrl["4"]%>">List4</a><%}%>');

    const kmlDescription = _.template('<%if (owner && !_.isEmpty(owner.trim())){%><b>Owner</b>: <%=owner%><%}%>' +
        '<%if (!_.isEmpty(listUrl["1"])){%><br/><a target="_blank" href="<%=listUrl["1"]%>">List1</a><%}%>' +
        '<%if (!_.isEmpty(listUrl["2"])){%><br/><a target="_blank" href="<%=listUrl["2"]%>">List2</a><%}%>' +
        '<%if (!_.isEmpty(listUrl["3"])){%><br/><a target="_blank" href="<%=listUrl["3"]%>">List3</a><%}%>' +
        '<%if (!_.isEmpty(listUrl["4"])){%><br/><a target="_blank" href="<%=listUrl["4"]%>">List4</a><%}%>');

    const customMapControlTemplate = _.template('<div class="settings-dropdown dropdown"> \
        <button class="btn btn-default dropdown-toggle" type="button" data-toggle="dropdown" style="border:none; background:transparent; padding: 0; width: 100%; height: 100%;"> \
            <span class="glyphicon glyphicon-menu-hamburger"></span></button> \
        <ul class="dropdown-menu dropdown-menu-right" style="right: 0; left: auto;"> \
            <li><button type="button" class="btn btn-sm exportKmlBtn" title="Export"><span class="glyphicon glyphicon-download-alt"></span> Export KML</button> \
                <button type="button" class="btn btn-sm gotoCurrentLocation" title="Find Me"><span class="glyphicon glyphicon-record"></span> Find Me</button> \
                <button type="button" class="btn btn-sm districtCenter" title="Re-Centre"><span class="glyphicon glyphicon-flag"></span> Center</button> \
            </li> \
            <li><label><input type="checkbox" class="clusterChkBox"/> Show Clusters</label></li> \
            \
            <li style="padding-left: 5px; font-weight: bold; margin-top: 5px;">Legend:</li> \
            <li style="display: flex; align-items: center; padding: 2px 5px;"><span style="display: inline-block; width: 20px; height: 20px; background-color: #999999; margin-right: 10px; border: 1px solid #ccc;"></span>No Lists</li> \
            <li style="display: flex; align-items: center; padding: 2px 5px;"><span style="display: inline-block; width: 20px; height: 20px; background-color: #C57CF2; margin-right: 10px;"></span>1 List</li> \
            <li style="display: flex; align-items: center; padding: 2px 5px;"><span style="display: inline-block; width: 20px; height: 20px; background-color: #A646E2; margin-right: 10px;"></span>2 Lists</li> \
            <li style="display: flex; align-items: center; padding: 2px 5px;"><span style="display: inline-block; width: 20px; height: 20px; background-color: #7E2AB2; margin-right: 10px;"></span>3 Lists</li> \
            <li style="display: flex; align-items: center; padding: 2px 5px;"><span style="display: inline-block; width: 20px; height: 20px; background-color: #2B0047; margin-right: 10px;"></span>4 Lists</li> \
            <li style="display: flex; align-items: center; padding: 2px 5px;"><span style="display: inline-block; width: 20px; height: 20px; background-color: #008000; margin-right: 10px;"></span>Reviewed</li> \
        </ul> \
    </div>');

    const REVIEWED_PATTERN = ['yes', 'y', 'reviewed', '1', 'true'];
    const NS_KML = 'http://www.opengis.net/kml/2.2';
    const NS_GX = 'http://www.google.com/kml/ext/2.2';

    const RectangleInfo = function (options) {
        this.options = _.extend({
            subCell: null, bounds: null, clusterName: null, site: null, owner: null,
            listUrl: {}, reviewed: 'no', priority: null, status: 0
        }, options);
    };

    RectangleInfo.prototype = {
        setValue: function (name, value) { this.options[name] = value; },
        getValue: function (name) { return this.options[name]; },
        isReviewed: function () {
            return this.getValue('reviewed') ? _.indexOf(REVIEWED_PATTERN, this.getValue('reviewed').toLowerCase()) >= 0 : false;
        },
        getFillColor: function () {
            if (this.isReviewed()) return '#008000';
            switch (this.getValue('status')) {
                case '1': return '#C57CF2';
                case '2': return '#A646E2';
                case '3': return '#7E2AB2';
                case '4': return '#2B0047';
                default: return '#999999';
            }
        },
        getFillOpacity: function () { return 0.6; }
    };

    const BirdMap = function (options) {
        this.options = _.extend({
            mapContainerId: 'map-canvas', mapSpreadSheetId: null, name: 'visualization', boundaryLink: null
        }, options);
        if (!this.options.mapSpreadSheetId) throw "the option 'mapSpreadSheetId' is mandatory";
    };

    BirdMap.prototype = {
        options: null, map: null, rectangleInfos: {}, gridLayers: {}, clusterLayerGroup: null, userLocationMarker: null,

        render: function () {
            const spreadSheetUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + this.options.mapSpreadSheetId + "/values:batchGet";
            $.ajax({
                url: spreadSheetUrl, jsonp: "callback",
                data: { key: API_KEY, ranges: ["Coordinates", "Planning", "Birds Lists"] },
                traditional: true, dataType: "jsonp", context: this,
                success: function (response) {
                    if (response.error) { this.options.alert(response.error.message); return; }
                    const sheetData = {
                        "coordinates": this._parseRows(response.valueRanges[0].values),
                        "planning": this._parseRows(response.valueRanges[1].values),
                        "status": this._parseRows(response.valueRanges[2].values)
                    };
                    this.drawMap(sheetData);
                },
                error: function(error) { console.log(error); }
            });
        },

        _parseRows: function (entries) {
            if (!entries || entries.length === 0) return [];
            const [header, ...rows] = entries;
            return rows;
        },

        drawMap: function (sheetData) {
            // 1. Calculate bounds for initial zoom
            const dataBounds = this._calculateBounds(sheetData['coordinates']);
            
            if (!this.map) {
                const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '© OpenStreetMap'
                });

                const satelliteBase = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                    attribution: 'Tiles &copy; Esri'
                });
                
                const satelliteLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}');
                const satelliteHybrid = L.layerGroup([satelliteBase, satelliteLabels]);

                // --- DEFINE THE HARD LIMITS HERE ---
                    const restrictedBounds = [[5.0, 65.0], [33.0, 100.0]];

                this.map = L.map(this.options.mapContainerId, {
                    layers: [osm],
                    zoomControl: true,
                    fullscreenControl: true,
                    maxBounds: restrictedBounds,
                    maxBoundsViscosity: 1.0, // Makes the edge solid (no bouncing)
                    minZoom: 15, // (Decrease if more zoom out rquired)
                    inertia: false,           // Stops momentum panning (no sliding after let go)
                    bounceAtZoomLimits: false
                });

                const baseMaps = {
                    "Streets": osm,
                    "Satellite Hybrid": satelliteHybrid
                };
                L.control.layers(baseMaps).addTo(this.map);
                this._addCustomControls();
            }
            
            if (dataBounds) {
                this.map.fitBounds(dataBounds);
            }

            this.processCoordinates(sheetData['coordinates']);
            this.processStatusData(sheetData['status']);
            this.processPlanningData(sheetData['planning']);
        },

        processCoordinates: function (rows) {
            if (this.options.boundaryLink) {
                const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(this.options.boundaryLink);
                const customLayer = L.geoJson(null, {
                    style: function() { return { color: 'red', weight: 3, fillOpacity: 0 }; },
                    interactive: false 
                });
                omnivore.kml(proxyUrl, null, customLayer).addTo(this.map);
            }

            this.rectangleInfos = {};
            this.gridLayers = {};

            _(rows).each(function (row) {
                const subCellId = row[0];
                const bounds = [[row[2], row[1]], [row[6], row[5]]];
                this.rectangleInfos[subCellId] = new RectangleInfo({ subCell: subCellId, bounds: bounds }); 
                
                const rect = L.rectangle(bounds, {
                    color: '#505050', weight: 1, fillColor: '#999999', fillOpacity: 0.6
                }).addTo(this.map);

                rect.bindPopup("Loading...");
                this.gridLayers[subCellId] = rect;
            }, this);

            $('#' + this.options.mapContainerId).removeClass("spinner");
        },

        // --- CLUSTER LOGIC (Turf.js) ---
        createClusterBoundaries: function () {
            const clusterLayers = [];
            const grouped = _.chain(this.rectangleInfos)
                .filter(function (info) {
                    const cName = info.getValue('clusterName');
                    return cName && cName.trim() !== '' && cName !== 'F';
                })
                .groupBy(function (info) { return info.getValue('clusterName'); })
                .value();

            _.each(grouped, function(infos, clusterName) {
                const points = [];
                _.each(infos, function(info) {
                    const b = info.options.bounds; 
                    points.push(turf.point([parseFloat(b[0][1]), parseFloat(b[0][0])])); // SW [Lng, Lat]
                    points.push(turf.point([parseFloat(b[0][1]), parseFloat(b[1][0])])); // NW
                    points.push(turf.point([parseFloat(b[1][1]), parseFloat(b[1][0])])); // NE
                    points.push(turf.point([parseFloat(b[1][1]), parseFloat(b[0][0])])); // SE
                });

                const fc = turf.featureCollection(points);
                const hull = turf.convex(fc);

               if (hull) {
                    const layer = L.geoJSON(hull, {
                        style: { color: '#0000FF', weight: 2, fillColor: '#FF0000', fillOpacity: 0.2 },
                        interactive: false // <--- ADD THIS LINE. This lets clicks pass through!
                    });
                    
                    // Note: Tooltips won't trigger on hover if interactive is false.
                    // If you really need the cluster name, we can add a permanent label later.
                    // layer.bindTooltip(clusterName, { permanent: false, direction: 'center' });
                    
                    clusterLayers.push(layer);
                }
            });
            return clusterLayers;
        },

        clusterCheckboxClicked: function (e) {
            const show = e.target.checked;
            if (show) {
                if (!this.clusterLayerGroup) {
                    const layers = this.createClusterBoundaries();
                    this.clusterLayerGroup = L.layerGroup(layers);
                }
                this.clusterLayerGroup.addTo(this.map);
            } else {
                if (this.clusterLayerGroup) {
                    this.map.removeLayer(this.clusterLayerGroup);
                }
            }
        },

        processStatusData: function (rows) {
            _(rows).each(function (row) {
                const id = row[0];
                const info = this.rectangleInfos[id];
                const layer = this.gridLayers[id];
                if (info && layer) {
                    info.setValue('reviewed', row[6]);
                    info.setValue('status', row[7]);
                    info.setValue('priority', row[8]);
                    info.setValue('listUrl', {
                        1: this._fixPartialBirdListURL(row[2]),
                        2: this._fixPartialBirdListURL(row[3]),
                        3: this._fixPartialBirdListURL(row[4]),
                        4: this._fixPartialBirdListURL(row[5])
                    });
                    layer.setStyle({ fillColor: info.getFillColor() });
                }
            }, this);
        },

        processPlanningData: function (rows) {
            rows = _(rows).filter(function(r) { return r; });
            _(rows).each(function (row) {
                const id = row[0];
                const info = this.rectangleInfos[id];
                const layer = this.gridLayers[id];
                if (info && layer) {
                    info.setValue('clusterName', row[1]);
                    info.setValue('owner', row[5]);
                    info.setValue('site', row[2]);
                    // Use Leaflet bindPopup instead of Google InfoBox
                    layer.bindPopup(infoBoxTemplate(info.options));
                }
            }, this);
        },

        // --- KML EXPORT FUNCTIONS ---
        _addTextNode: function (parentNode, elem, value, ns) {
            const ownerDocument = parentNode.ownerDocument;
            const node = ownerDocument.createElementNS(ns, elem);
            const txtNode = ownerDocument.createTextNode(value || "");
            node.appendChild(txtNode);
            parentNode.appendChild(node);
        },

        _addKmlStyles: function (documentNode, id, color) {
            const ownerDocument = documentNode.ownerDocument;
            const styleNode = ownerDocument.createElementNS(NS_KML, "Style");
            const lineStyleNode = ownerDocument.createElementNS(NS_KML, "LineStyle");
            const polyStyleNode = ownerDocument.createElementNS(NS_KML, "PolyStyle");
            
            this._addTextNode(lineStyleNode, 'color', '641400FF', NS_KML);
            this._addTextNode(lineStyleNode, 'width', '1', NS_KML);
            styleNode.appendChild(lineStyleNode);
            
            this._addTextNode(polyStyleNode, 'color', color, NS_KML);
            styleNode.appendChild(polyStyleNode);
            styleNode.setAttribute("id", id);
            documentNode.appendChild(styleNode);
        },

        polygonPathsFromBounds: function (bounds) {
            const lat1 = parseFloat(bounds[0][0]);
            const lng1 = parseFloat(bounds[0][1]);
            const lat2 = parseFloat(bounds[1][0]);
            const lng2 = parseFloat(bounds[1][1]);
            
            // KML expects Lng,Lat,Alt
            const coords = [
                [lng1, lat1], [lng1, lat2], [lng2, lat2], [lng2, lat1], [lng1, lat1]
            ];

            let pathString = '';
            coords.forEach(function(pt) {
                pathString += pt[0] + "," + pt[1] + ",0 ";
            });
            return pathString;
        },

        addPlacemark: function (documentNode, options) {
            const ownerDocument = documentNode.ownerDocument;
            const placemarkNode = ownerDocument.createElementNS(NS_KML, 'Placemark');
            const descriptionNode = ownerDocument.createElementNS(NS_KML, 'description');
            const polygonNode = ownerDocument.createElementNS(NS_KML, 'Polygon');
            const outerBoundaryNode = ownerDocument.createElementNS(NS_KML, 'outerBoundaryIs');
            const linearRingNode = ownerDocument.createElementNS(NS_KML, 'LinearRing');
            const descriptionCdata = ownerDocument.createCDATASection(options.description);
            
            this._addTextNode(placemarkNode, 'name', options.name, NS_KML);
            descriptionNode.appendChild(descriptionCdata);
            placemarkNode.appendChild(descriptionNode);

            this._addTextNode(placemarkNode, 'styleUrl', '#' + options.style, NS_KML);
            this._addTextNode(linearRingNode, 'coordinates', options.pathString, NS_KML);
            this._addTextNode(polygonNode, "gx:drawOrder", options.drawOrder, NS_GX);
            
            outerBoundaryNode.appendChild(linearRingNode);
            polygonNode.appendChild(outerBoundaryNode);
            placemarkNode.appendChild(polygonNode);
            documentNode.appendChild(placemarkNode);
        },

        createKml: function () {
            const xmlString = '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document/></kml>';
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlString, "text/xml");
            const serializer = new XMLSerializer();
            const documentNode = xmlDoc.getElementsByTagName("Document")[0];

            this._addTextNode(documentNode, 'name', this.options.name, NS_KML);
            
            this._addKmlStyles(documentNode, 'reviewed', '99008000'); 
            this._addKmlStyles(documentNode, 'status-1', '99F27CC5'); 
            this._addKmlStyles(documentNode, 'status-2', '99E246A6'); 
            this._addKmlStyles(documentNode, 'status-3', '99B22A7E'); 
            this._addKmlStyles(documentNode, 'status-4', '9947002B'); 
            this._addKmlStyles(documentNode, 'status-0', '99999999'); 
            this._addKmlStyles(documentNode, 'cluster', '66ff9900'); 

            _(this.rectangleInfos).each(function (rectangleInfo) {
                const options = {
                    pathString: this.polygonPathsFromBounds(rectangleInfo.options.bounds),
                    description: kmlDescription(rectangleInfo.options),
                    name: rectangleInfo.options.subCell + (rectangleInfo.options.clusterName ? ' ' + rectangleInfo.options.clusterName : ''),
                    style: rectangleInfo.isReviewed() ? 'reviewed' : ('status-' + rectangleInfo.getValue('status')),
                    drawOrder: 2
                };
                this.addPlacemark(documentNode, options);
            }, this);

            if (this.showCluster && this.clusterLayerGroup) {
                this.clusterLayerGroup.eachLayer(function (layer) {
                    const latlngs = layer.getLatLngs()[0]; 
                    let pathString = '';
                    latlngs.forEach(function(ll) {
                        // Check if latlng is array (Turf output) or object (Leaflet output)
                        const lng = Array.isArray(ll) ? ll[1] : ll.lng;
                        const lat = Array.isArray(ll) ? ll[0] : ll.lat;
                        pathString += lng + "," + lat + ",0 ";
                    });
                    // Close loop
                    const first = latlngs[0];
                    const fLng = Array.isArray(first) ? first[1] : first.lng;
                    const fLat = Array.isArray(first) ? first[0] : first.lat;
                    pathString += fLng + "," + fLat + ",0 ";

                    const name = layer.getTooltip() ? layer.getTooltip().getContent() : "Cluster";
                    const options = {
                        pathString: pathString,
                        description: '',
                        name: name,
                        style: 'cluster',
                        drawOrder: 1
                    };
                    this.addPlacemark(documentNode, options);
                }, this);
            }
            return serializer.serializeToString(xmlDoc);
        },

        _exportKml: function (e) {
            e.preventDefault();
            const kmlString = this.createKml();
            const bb = new Blob([kmlString], {type: 'application/vnd.google-earth.kml+xml'});
            const url = window.URL.createObjectURL(bb);
            const a = document.createElement('a');
            a.setAttribute('href', url);
            a.setAttribute('download', this.options.name + '.kml');
            a.setAttribute('style', 'display: none;');
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            }, 100);
        },

        _addCustomControls: function() {
            const self = this;
            const CustomControl = L.Control.extend({
                options: { position: 'topright' },
                onAdd: function (map) {
                    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                    container.innerHTML = customMapControlTemplate({});
                    L.DomEvent.disableClickPropagation(container);
                    
                    $(container).find('.exportKmlBtn').on('click', _.bind(self._exportKml, self));
                    $(container).find('.districtCenter').on('click', function() { self.recenter(); });
                    $(container).find('.clusterChkBox').on('click', _.bind(self.clusterCheckboxClicked, self));
                    
                    $(container).find('.gotoCurrentLocation').on('click', function() {
                        self.map.locate({setView: true, maxZoom: 12});
                    });
                    self.map.on('locationfound', function(e) {
                        if (self.userLocationMarker) { self.map.removeLayer(self.userLocationMarker); }
                        self.userLocationMarker = L.circleMarker(e.latlng, {
                            radius: 8, fillColor: "#3388ff", color: "#fff", weight: 2, fillOpacity: 1
                        }).addTo(self.map).bindPopup("You are here").openPopup();
                    });
                    self.map.on('locationerror', function(e) {
                        alert("Could not find your location: " + e.message);
                    });
                    return container;
                }
            });
            this.map.addControl(new CustomControl());
        },

        _fixPartialBirdListURL: function (url) {
            if (!url) return '';
            url = url.trim();
            if (_.isEmpty(url)) return '';
            return /^http/.test(url) ? url : 'http://ebird.org/ebird/view/checklist?subID=' + url
        },

        _calculateBounds: function(rows) {
            if (!rows || rows.length === 0) return null;
            let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
            rows.forEach(row => {
                const lat1 = parseFloat(row[2]);
                const lng1 = parseFloat(row[1]);
                const lat2 = parseFloat(row[6]);
                const lng2 = parseFloat(row[5]);
                if (lat1 < minLat) minLat = lat1;
                if (lat1 > maxLat) maxLat = lat1;
                if (lat2 < minLat) minLat = lat2; 
                if (lat2 > maxLat) maxLat = lat2;
                if (lng1 < minLng) minLng = lng1;
                if (lng1 > maxLng) maxLng = lng1;
                if (lng2 < minLng) minLng = lng2;
                if (lng2 > maxLng) maxLng = lng2;
            });
            return [[minLat, minLng], [maxLat, maxLng]];
        },

        recenter: function () {
            if (this.map && this.dataBounds) {
                // FIX: Actually move the camera back to the data bounds
                this.map.fitBounds(this.dataBounds);
            }
        }
    };

    return {
        BirdMap: BirdMap,
        createMap: function (options) {
            options = _.extend({}, options);
            const map = new BirdCount.BirdMap({
                mapContainerId: options.mapContainerId,
                mapSpreadSheetId: options.mapSpreadSheetId,
                name: options.name,
                boundaryLink: options.boundaryLink,
                alert: function (message) {
                    $('.page-alert-box .modal-body').html('<p>' + message + '</p>')
                    $('.page-alert-box').modal('show');
                }
            });
            map.render();
            return map;
        }
    };
})();