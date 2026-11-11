// Collapsible property map shared by the pipeline pages.
//
// The page hands it the properties that pass its other filters (setItems) and
// asks it for a location filter (getFilter) to apply to the cards: a shape the user
// drew (a radius or a free-form area), or else the area the map is showing once the
// user has panned or zoomed. The map calls onChange whenever that filter changes.
//
// Leaflet and the map tiles are only downloaded the first time the panel opens.
(function () {
    const LEAFLET_BASE = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
    const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
    const METERS_PER_MILE = 1609.344;
    const DEFAULT_RADIUS_MILES = 1;
    // Drawn radius / area outline. Blue, because the map and the dots already use
    // red, orange, tan and green.
    const SHAPE_COLOR = '#1D4ED8';

    let leafletPromise = null;
    function loadLeaflet() {
        if (window.L) return Promise.resolve(window.L);
        if (leafletPromise) return leafletPromise;
        leafletPromise = new Promise((resolve, reject) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = LEAFLET_BASE + 'leaflet.css';
            css.integrity = LEAFLET_CSS_SRI;
            css.crossOrigin = 'anonymous';
            document.head.appendChild(css);

            const js = document.createElement('script');
            js.src = LEAFLET_BASE + 'leaflet.js';
            js.integrity = LEAFLET_JS_SRI;
            js.crossOrigin = 'anonymous';
            js.onload = () => resolve(window.L);
            js.onerror = () => { leafletPromise = null; reject(new Error('Could not load the map library')); };
            document.head.appendChild(js);
        });
        return leafletPromise;
    }

    function injectStyles() {
        if (document.getElementById('caseMapStyles')) return;
        const style = document.createElement('style');
        style.id = 'caseMapStyles';
        style.textContent = `
            .case-map-panel { background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); margin-bottom: 1.5rem; }
            .case-map-header { width: 100%; display: flex; align-items: center; gap: 12px; padding: 14px 20px; background: none; border: 0; cursor: pointer; font: inherit; color: var(--ink); text-align: left; }
            .case-map-header:hover { background: var(--surface-2); }
            .case-map-title { font-size: 0.85rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
            .case-map-summary { font-size: 0.8rem; color: var(--muted); flex: 1; min-width: 0; }
            .case-map-arrow { color: var(--muted); font-size: 0.7rem; transition: transform 0.3s; }
            .case-map-panel.open .case-map-arrow { transform: rotate(180deg); }
            .case-map-body { display: none; border-top: 1px solid var(--border); }
            .case-map-panel.open .case-map-body { display: block; }
            .case-map-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 10px 20px; background: var(--surface-2); font-size: 0.8rem; color: var(--ink); }
            .case-map-toolbar label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
            .case-map-btn { font: inherit; font-size: 0.78rem; padding: 5px 12px; background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong); cursor: pointer; }
            .case-map-btn:hover { border-color: var(--brand-gold); }
            .case-map-btn.is-active { background: var(--brand-gold); border-color: var(--brand-gold); color: var(--on-gold); }
            .case-map-radius { display: inline-flex; align-items: center; gap: 6px; }
            .case-map-radius[hidden] { display: none; }
            .case-map-radius input { width: 68px; font: inherit; font-size: 0.78rem; padding: 4px 6px; background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong); }
            .case-map-legend { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; margin-left: auto; color: var(--muted); }
            .case-map-legend span { display: inline-flex; align-items: center; gap: 5px; }
            .case-map-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
            /* Leaflet stacks its layers at z-index 400-1000. Keep those inside the panel so
               the page's filter dropdowns open in front of the map, not behind it. */
            .case-map-panel { isolation: isolate; }
            .case-map-canvas { position: relative; z-index: 0; height: 440px;background: var(--surface-3, var(--surface-2)); }
            .case-map-canvas.is-drawing, .case-map-canvas.is-drawing .leaflet-interactive { cursor: crosshair !important; }
            .case-map-message { padding: 24px 20px; color: var(--muted); font-size: 0.85rem; }
            .case-map-popup-title { font-weight: 600; font-size: 0.9rem; color: #232323; }
            .case-map-popup-sub, .case-map-popup-meta { font-size: 0.78rem; color: #5b564d; margin-top: 2px; }
            [data-theme="dark"] .case-map-canvas .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9); }
            @media (max-width: 700px) { .case-map-canvas { height: 320px; } .case-map-legend { margin-left: 0; } }
        `;
        document.head.appendChild(style);
    }

    // A colour is either a literal ("#F28C28") or the name of a theme variable ("muted").
    function cssColor(name) {
        if (String(name).startsWith('#')) return name;
        const value = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
        return value || '#7C756A';
    }

    /**
     * @param {object} opts
     *   mount        element the panel is built in
     *   storageKey   localStorage prefix for the open / closed state
     *   defaultView  { center: [lat, lng], zoom } used when nothing is plotted
     *   legend       [{ color: '#F28C28', label: 'Mortgage' }]  (hex, or a CSS variable name)
     *   onChange()   the location filter changed (view, shape, panel opened / closed); re-filter the cards
     *   onSelect(id) a dot was clicked
     */
    function create(opts) {
        injectStyles();
        const storageKey = (opts.storageKey || 'caseMap') + ':open';
        const defaultView = opts.defaultView || { center: [40.2, -75.35], zoom: 10 };

        const panel = document.createElement('div');
        panel.className = 'case-map-panel';
        panel.innerHTML = `
            <button type="button" class="case-map-header" aria-expanded="false">
                <span class="case-map-title">Map</span>
                <span class="case-map-summary"></span>
                <span class="case-map-arrow">&#9660;</span>
            </button>
            <div class="case-map-body">
                <div class="case-map-toolbar">
                    <label title="Show only the properties inside the area the map is showing"><input type="checkbox" data-role="follow" checked> Cards follow the map</label>
                    <button type="button" class="case-map-btn" data-role="drawRadius" title="Show only the properties inside a circle. Click the map for a 1 mile circle, or click and drag to size your own.">Draw radius</button>
                    <button type="button" class="case-map-btn" data-role="drawArea" title="Show only the properties inside an area you outline. Click each corner, then double-click (or click the first corner again) to finish.">Draw area</button>
                    <span class="case-map-radius" data-role="radiusBox" hidden>
                        <input type="number" data-role="miles" min="0.05" step="0.25" aria-label="Radius in miles"> mi
                    </span>
                    <button type="button" class="case-map-btn" data-role="clear" title="Remove the radius or area and show every property again" hidden>Clear shape</button>
                    <button type="button" class="case-map-btn" data-role="reset" title="Zoom back out to every property, remove any radius or area, and stop filtering by map area">Reset view</button>
                    <span class="case-map-legend"></span>
                </div>
                <div class="case-map-canvas"></div>
            </div>`;
        opts.mount.appendChild(panel);

        const el = role => panel.querySelector(`[data-role="${role}"]`);
        const header = panel.querySelector('.case-map-header');
        const summary = panel.querySelector('.case-map-summary');
        const canvas = panel.querySelector('.case-map-canvas');
        const legend = panel.querySelector('.case-map-legend');
        const followBox = el('follow');
        const radiusBtn = el('drawRadius');
        const areaBtn = el('drawArea');
        const clearBtn = el('clear');
        const radiusBox = el('radiusBox');
        const milesInput = el('miles');

        for (const entry of opts.legend || []) {
            const item = document.createElement('span');
            const dot = document.createElement('i');
            dot.style.background = cssColor(entry.color);
            item.append(dot, entry.label);
            legend.appendChild(item);
        }

        let open = false;
        let map = null;
        let L = null;
        let dotLayer = null;
        let dotRenderer = null;
        let shapeRenderer = null;   // drawn radius / area, underneath the dots
        let ringRenderer = null;    // hover ring, above the dots
        let highlightMarker = null;
        // A drawn shape filters the cards and takes over from the map's view:
        //   { kind: 'radius', center: LatLng, meters }  or  { kind: 'polygon', points: [[lat, lng], ...] }
        let shape = null;
        let shapeLayer = null;
        let drawMode = null;        // 'radius' | 'polygon' while the user is drawing
        let draft = null;           // polygon in progress: { points, line, band }
        let lastDrawEnd = 0;
        let userMoved = false;      // the user has panned / zoomed since the last fit
        let baseline = null;        // view the map itself last set (fit, resize)
        let selfMoving = false;
        let items = [];
        let itemsById = new Map();
        let drawnSignature = null;
        let fittedSignature = null;

        let changeTimer = null;

        const notify = () => { if (opts.onChange) opts.onChange(); };
        const notifySoon = () => {
            clearTimeout(changeTimer);
            changeTimer = setTimeout(notify, 220);
        };

        function markBaseline() {
            baseline = { center: map.getCenter(), zoom: map.getZoom() };
        }

        // Run a view change the map makes itself, so "moveend" does not read it as the user.
        function selfMove(change) {
            selfMoving = true;
            try { change(); } finally { selfMoving = false; }
            markBaseline();
        }

        // True while the map still shows the view it set itself. A window resize
        // re-fires "moveend" without the user touching anything; this tells the two apart.
        function atBaseline() {
            if (!baseline || map.getZoom() !== baseline.zoom) return false;
            const a = map.latLngToContainerPoint(baseline.center);
            const b = map.latLngToContainerPoint(map.getCenter());
            return a.distanceTo(b) < 2;
        }

        // Returns false when the panel has no size yet (page still hidden behind the
        // sign-in), so the caller knows to fit again once it does.
        function fitToItems() {
            if (!map || !canvas.clientWidth || !canvas.clientHeight) return false;
            selfMove(() => {
                if (items.length) {
                    const bounds = L.latLngBounds(items.map(item => [item.lat, item.lng]));
                    map.fitBounds(bounds.pad(0.08), { animate: false, maxZoom: 16 });
                } else {
                    map.setView(defaultView.center, defaultView.zoom, { animate: false });
                }
            });
            return true;
        }

        // A drawn shape wins. Without one, the cards follow the area in view, but only
        // once the user has moved the map: just opening the panel filters nothing.
        function currentFilter() {
            if (!open || !map) return null;
            if (!shape) {
                if (!followBox.checked || !userMoved) return null;
                const bounds = map.getBounds();
                return (lat, lng) => bounds.contains([lat, lng]);
            }
            if (shape.kind === 'radius') {
                const { center, meters } = shape;
                return (lat, lng) => map.distance([lat, lng], center) <= meters;
            }
            const points = shape.points;
            return (lat, lng) => {
                let inside = false;
                for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
                    const [latI, lngI] = points[i];
                    const [latJ, lngJ] = points[j];
                    if ((latI > lat) !== (latJ > lat) && lng < (lngJ - lngI) * (lat - latI) / (latJ - latI) + lngI) inside = !inside;
                }
                return inside;
            };
        }

        function draw(force) {
            if (!map) return;
            const itemKey = items.map(item => `${item.id}:${item.color}${item.onTop ? '!' : ''}`).join('|');
            const signature = itemKey + '#' + (shape ? JSON.stringify(shape) : '');
            if (!force && signature === drawnSignature) return;
            drawnSignature = signature;

            dotLayer.clearLayers();
            const stroke = cssColor('surface');
            const inShape = shape ? currentFilter() : null;
            const colors = {};
            // Marked dots (item.onTop) are drawn last, at the same size, so a
            // neighbour never hides them.
            const ordered = items.some(item => item.onTop)
                ? [...items.filter(item => !item.onTop), ...items.filter(item => item.onTop)]
                : items;
            for (const item of ordered) {
                const fill = colors[item.color] || (colors[item.color] = cssColor(item.color));
                const dimmed = inShape && !inShape(item.lat, item.lng);
                const marker = L.circleMarker([item.lat, item.lng], {
                    renderer: dotRenderer,
                    radius: 5.5,
                    color: stroke,
                    weight: 1,
                    opacity: dimmed ? 0.4 : 1,
                    fillColor: fill,
                    fillOpacity: dimmed ? 0.25 : 0.9
                });
                marker.on('click', () => showPopup(item));
                dotLayer.addLayer(marker);
            }

            // Until the user takes over the view, keep everything that is plotted in frame
            // (so picking a town in the filters zooms the map to that town).
            if (!userMoved && !shape && itemKey !== fittedSignature) {
                if (fitToItems()) fittedSignature = itemKey;
            }
        }

        function showPopup(item) {
            // A click that places or finishes a shape must not also open the dot under it.
            if (drawMode || Date.now() - lastDrawEnd < 400) return;
            const box = document.createElement('div');
            const add = (className, text) => {
                if (!text) return;
                const line = document.createElement('div');
                line.className = className;
                line.textContent = text;
                box.appendChild(line);
            };
            add('case-map-popup-title', item.title);
            add('case-map-popup-sub', item.subtitle);
            add('case-map-popup-meta', item.meta);
            L.popup({ offset: [0, -4] }).setLatLng([item.lat, item.lng]).setContent(box).openOn(map);
            if (opts.onSelect) opts.onSelect(item.id);
        }

        function setShape(next) {
            shape = next;
            if (shapeLayer) { shapeLayer.remove(); shapeLayer = null; }
            if (shape) {
                const style = { renderer: shapeRenderer, color: SHAPE_COLOR, weight: 3, fillColor: SHAPE_COLOR, fillOpacity: 0.12, interactive: false };
                shapeLayer = (shape.kind === 'radius'
                    ? L.circle(shape.center, { radius: shape.meters, ...style })
                    : L.polygon(shape.points, style)).addTo(map);
            }
            const isRadius = !!shape && shape.kind === 'radius';
            if (isRadius) milesInput.value = (shape.meters / METERS_PER_MILE).toFixed(2);
            radiusBox.hidden = !isRadius;
            clearBtn.hidden = !shape;
        }

        function dropDraft() {
            if (!draft) return;
            draft.line.remove();
            draft.band.remove();
            draft = null;
        }

        function setDrawMode(mode) {
            dropDraft();
            if (drawMode && !mode) lastDrawEnd = Date.now();
            drawMode = mode;
            radiusBtn.classList.toggle('is-active', mode === 'radius');
            radiusBtn.textContent = mode === 'radius' ? 'Click or drag on the map\u2026' : 'Draw radius';
            areaBtn.classList.toggle('is-active', mode === 'polygon');
            areaBtn.textContent = mode === 'polygon' ? 'Click corners, double-click to finish\u2026' : 'Draw area';
            canvas.classList.toggle('is-drawing', !!mode);
            if (!map) return;
            // A radius is dragged out, so the map must hold still; an area is clicked
            // corner by corner, so the map can still be panned between clicks.
            if (mode === 'radius') map.dragging.disable(); else map.dragging.enable();
            if (mode === 'polygon') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
            if (mode) map.closePopup();
        }

        function onRadiusStart(e) {
            if (drawMode !== 'radius') return;
            if (e.originalEvent) e.originalEvent.preventDefault();
            const center = e.latlng;
            const startPoint = e.containerPoint;
            let meters = 0;
            let dragged = false;
            const onMove = (move) => {
                dragged = dragged || move.containerPoint.distanceTo(startPoint) > 6;
                if (!dragged) return;
                meters = map.distance(center, move.latlng);
                setShape({ kind: 'radius', center, meters });
            };
            const onUp = () => {
                map.off('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (!dragged) meters = DEFAULT_RADIUS_MILES * METERS_PER_MILE;
                setShape({ kind: 'radius', center, meters });
                setDrawMode(null);
                if (!dragged) selfMove(() => map.fitBounds(shapeLayer.getBounds().pad(0.1), { animate: false }));
                draw(true);
                notify();
            };
            map.on('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        function finishPolygon() {
            if (!draft || draft.points.length < 3) return;
            const points = draft.points.map(p => [p.lat, p.lng]);
            setDrawMode(null);
            setShape({ kind: 'polygon', points });
            draw(true);
            notify();
        }

        function onPolygonClick(e) {
            if (drawMode !== 'polygon') return;
            if (!draft) {
                draft = {
                    points: [],
                    line: L.polyline([], { renderer: shapeRenderer, color: SHAPE_COLOR, weight: 3, interactive: false }).addTo(map),
                    band: L.polyline([], { renderer: shapeRenderer, color: SHAPE_COLOR, weight: 2, dashArray: '5 5', interactive: false }).addTo(map)
                };
            }
            const points = draft.points;
            if (points.length) {
                const here = e.containerPoint;
                // The second click of a double-click lands on the corner just placed.
                if (map.latLngToContainerPoint(points[points.length - 1]).distanceTo(here) < 4) return;
                // Clicking the first corner again closes the area.
                if (points.length >= 3 && map.latLngToContainerPoint(points[0]).distanceTo(here) < 12) { finishPolygon(); return; }
            }
            points.push(e.latlng);
            draft.line.setLatLngs(points);
        }

        function onPolygonMove(e) {
            if (!draft || !draft.points.length) return;
            const points = draft.points;
            draft.band.setLatLngs(points.length > 1
                ? [points[points.length - 1], e.latlng, points[0]]
                : [points[0], e.latlng]);
        }

        async function ensureMap() {
            if (map) return;
            try {
                L = await loadLeaflet();
            } catch (error) {
                canvas.innerHTML = '<div class="case-map-message">The map could not be loaded. Check the connection and reopen this panel.</div>';
                throw error;
            }
            if (map) return;
            map = L.map(canvas, { preferCanvas: true, zoomSnap: 0.5 });
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
            }).addTo(map);
            dotRenderer = L.canvas({ padding: 0.3 });
            // The drawn shape and the hover ring each get their own layer that ignores the
            // mouse. Left on Leaflet's default layer they would sit over the dots and
            // swallow every hover and click meant for them.
            const passThroughRenderer = (name, zIndex) => {
                const pane = map.createPane(name);
                pane.style.zIndex = zIndex;
                pane.style.pointerEvents = 'none';
                return L.canvas({ pane: name, padding: 0.3 });
            };
            shapeRenderer = passThroughRenderer('caseMapShapes', 350);
            ringRenderer = passThroughRenderer('caseMapRing', 450);
            dotLayer = L.layerGroup().addTo(map);
            map.setView(defaultView.center, defaultView.zoom, { animate: false });
            markBaseline();

            // Opening a popup near the edge nudges the map to fit it. Before the user has
            // taken over the view, that nudge must not start filtering the cards.
            let autoPanning = false;
            map.on('autopanstart', () => { if (!userMoved) autoPanning = true; });
            map.on('moveend', () => {
                if (autoPanning) { autoPanning = false; markBaseline(); return; }
                if (selfMoving || atBaseline()) return;
                userMoved = true;
                if (followBox.checked && !shape) notifySoon();
            });

            // Never repaint the cards in the middle of a gesture: a new drag or zoom
            // cancels the pending update, and the one after it settles is enough.
            map.on('movestart zoomstart', () => clearTimeout(changeTimer));

            map.on('mousedown', onRadiusStart);
            map.on('click', onPolygonClick);
            map.on('mousemove', onPolygonMove);
            map.on('dblclick', () => { if (drawMode === 'polygon') finishPolygon(); });

            // Leaflet cannot see its container being shown or resized by the page
            // (sign-in reveal, panel reopened), so re-measure whenever that happens.
            new ResizeObserver(() => {
                if (!open || !canvas.clientWidth) return;
                selfMove(() => map.invalidateSize({ animate: false }));
                if (!userMoved && !shape) { fittedSignature = null; drawnSignature = null; draw(false); }
            }).observe(canvas);

            // Dot colours come from the theme, so repaint when it switches.
            new MutationObserver(() => draw(true))
                .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        }

        async function setOpen(next) {
            open = next;
            panel.classList.toggle('open', open);
            header.setAttribute('aria-expanded', String(open));
            try { localStorage.setItem(storageKey, open ? '1' : '0'); } catch (e) {}
            if (open) {
                try { await ensureMap(); } catch (e) { return; }
                // The container was display:none, so Leaflet has to re-measure it. Before
                // the user has moved, also re-centre: the earlier fit used the wrong size.
                selfMove(() => map.invalidateSize({ animate: false }));
                if (!userMoved && !shape) { fittedSignature = null; drawnSignature = null; }
            } else if (drawMode) {
                setDrawMode(null);
            }
            notify();
        }

        header.addEventListener('click', () => setOpen(!open));
        followBox.addEventListener('change', notify);
        radiusBtn.addEventListener('click', () => setDrawMode(drawMode === 'radius' ? null : 'radius'));
        areaBtn.addEventListener('click', () => setDrawMode(drawMode === 'polygon' ? null : 'polygon'));
        clearBtn.addEventListener('click', () => { setShape(null); draw(true); notify(); });
        el('reset').addEventListener('click', () => {
            if (!map) return;
            setDrawMode(null);
            setShape(null);
            userMoved = false;
            fittedSignature = null;
            drawnSignature = null;
            notify();
        });
        milesInput.addEventListener('change', () => {
            const miles = parseFloat(milesInput.value);
            if (!shape || shape.kind !== 'radius' || !Number.isFinite(miles) || miles <= 0) return;
            setShape({ kind: 'radius', center: shape.center, meters: miles * METERS_PER_MILE });
            selfMove(() => map.fitBounds(shapeLayer.getBounds().pad(0.1), { animate: false }));
            draw(true);
            notify();
        });
        document.addEventListener('keydown', (e) => {
            if (!drawMode) return;
            if (e.key === 'Escape') setDrawMode(null);
            else if (e.key === 'Enter' && drawMode === 'polygon') finishPolygon();
        });

        let startOpen = false;
        try { startOpen = localStorage.getItem(storageKey) === '1'; } catch (e) {}
        if (startOpen) setOpen(true);

        return {
            isOpen: () => open,
            /** True once the map exists, i.e. dots can be drawn and a filter can apply. */
            isReady: () => !!map,
            /** Frame every plotted dot now, whether or not the user has moved the map. */
            fit() { if (open && map) fitToItems(); },
            /** items: [{ id, lat, lng, color, title, subtitle, meta, onTop }] */
            setItems(next) {
                items = next || [];
                itemsById = new Map(items.map(item => [item.id, item]));
                if (open) draw(false);
            },
            /** null when the map is not filtering, else (lat, lng) => boolean. */
            getFilter: currentFilter,
            /** 'radius' | 'area' (drawn) | 'view' (what the map is showing) | null */
            filterKind: () => (!currentFilter() ? null : !shape ? 'view' : shape.kind === 'radius' ? 'radius' : 'area'),
            setSummary(text) { summary.textContent = text || ''; },
            highlight(id) {
                if (!map || !open) return;
                const item = id != null ? itemsById.get(id) : null;
                if (!item) {
                    if (highlightMarker) { highlightMarker.remove(); highlightMarker = null; }
                    return;
                }
                if (!highlightMarker) {
                    highlightMarker = L.circleMarker([item.lat, item.lng], {
                        renderer: ringRenderer, radius: 11, color: cssColor('brand-gold'), weight: 3, fill: false, interactive: false
                    }).addTo(map);
                } else {
                    highlightMarker.setLatLng([item.lat, item.lng]);
                }
            }
        };
    }

    window.CaseMap = { create };
})();
