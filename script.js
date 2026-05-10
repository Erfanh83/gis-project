/* ══════════════════════════════════════════════════
   SMART NEIGHBORHOOD GIS — SCRIPT.JS  v3 (Bug-Fixed)
   ──────────────────────────────────────────────────
   BUGS FIXED in this version:
   [1] Overpass API body must use 'data=' prefix (was silently 400ing)
   [2] Mosque query now uses compound tag filter (was matching churches)
   [3] resolveCategory mosque special-case was matching non-mosques
   [4] Slider dir="ltr" set in HTML; gradient now goes left→right
   [5] OSM element deduplication by ID (was double-counting POIs)

   NEW IN v3:
   [+] Nominatim geocoding / address search
   [+] GeoJSON export
   [+] Score breakdown panel (shows WHY you got that number)
   [+] Per-category layer visibility toggles
   [+] Animated stat counters (roll-up animation)
   [+] Overpass mirror fallback (overpass.kumi.systems)
   [+] Fetch result cache (avoids re-fetching same area)
   ══════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────────
// 1. MAP INITIALIZATION
// ─────────────────────────────────────────────────

const map = L.map('map', {
  center: [35.6892, 51.3890],
  zoom: 14,
  zoomControl: false,
  attributionControl: false,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
}).addTo(map);

L.control.attribution({ prefix: false })
  .addAttribution('© OpenStreetMap | Leaflet + Turf.js | Overpass API')
  .addTo(map);

L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

// ─────────────────────────────────────────────────
// 2. CATEGORY CONFIGURATION
// ─────────────────────────────────────────────────

/**
 * Each category has:
 *   tags         – primary OSM tags to match (any one is sufficient)
 *   extraFilters – ADDITIONAL tag pairs that ALL must be present
 *                  (used for mosque: amenity=place_of_worship AND religion=muslim)
 *   color / icon / score / diversityWeight – visual & scoring config
 *
 * BUG-FIX [2][3]: mosque now uses extraFilters so the Overpass query
 * emits `["amenity"="place_of_worship"]["religion"="muslim"]` and
 * resolveCategory() checks both conditions before returning 'مسجد'.
 */
/**
 * importanceWeight — academically grounded on a 1–10 scale:
 *
 *  بیمارستان     9  — WHO Essential Health Service; life-critical
 *  مدرسه         8  — Education is a fundamental right (UN SDG 4)
 *  داروخانه      7  — Daily health access
 *  پارک          7  — WHO recommends ≥9m² green space per person
 *  ایستگاه مترو  9  — Tehran traffic makes public transport the key mobility factor
 *  نانوایی       6  — Daily staple; culturally central in Iran
 *  سوپرمارکت     6  — Daily shopping needs
 *  مسجد          5  — Core community & religious infrastructure in Iran
 *  کتابخانه      4  — Cultural/educational access
 *  بانک          4  — Financial services access
 *
 * Total weight = 65  →  normalised to 0–100 by the scoring formula.
 */
const CATEGORIES = {
  'بیمارستان':    { tags:[['amenity','hospital']],
                    color:'#f44336', icon:'🏥', importanceWeight:9,  threshold:1000 },
  'داروخانه':     { tags:[['amenity','pharmacy']],
                    color:'#40c4ff', icon:'💊', importanceWeight:7,  threshold:400  },
  'نانوایی':      { tags:[['shop','bakery']],
                    color:'#ff9100', icon:'🥖', importanceWeight:6,  threshold:400  },
  'مدرسه':        { tags:[['amenity','school'],['amenity','kindergarten']],
                    color:'#d500f9', icon:'🏫', importanceWeight:8,  threshold:500  },
  'پارک':         { tags:[['leisure','park'],['leisure','garden']],
                    color:'#18703d', icon:'🌳', importanceWeight:7,  threshold:300  },
  'بانک':         { tags:[['amenity','bank']],
                    color:'#ffd600', icon:'🏦', importanceWeight:4,  threshold:500  },
  'سوپرمارکت':    { tags:[['shop','supermarket'],['shop','convenience']],
                    color:'#1de9b6', icon:'🛒', importanceWeight:6,  threshold:500  },
  'کتابخانه':     { tags:[['amenity','library']],
                    color:'#75481e', icon:'📚', importanceWeight:4,  threshold:600  },
  // compound filter: amenity=place_of_worship AND religion=muslim
  'مسجد':         { tags:[['amenity','place_of_worship']],
                    extraFilters:[['religion','muslim']],
                    color:'#536dfe', icon:'🕌', importanceWeight:5,  threshold:600  },
  'ایستگاه مترو': { tags:[['railway','station'],['railway','subway_entrance'],['station','subway']],
                    color:'#ea80fc', icon:'🚇', importanceWeight:9,  threshold:600  },
};

// ─────────────────────────────────────────────────
// 3. APPLICATION STATE
// ─────────────────────────────────────────────────

const state = {
  studyPoint:       null,
  radius:           500,
  fetchedPOIs:      [],
  hiddenCategories: new Set(),
  studyMarker:      null,
  bufferLayer:      null,
  lineLayer:        null,
  routeLayer:       null,
  routeMarkers:     L.layerGroup().addTo(map),
  heatmapLayer:     null,
  heatmapActive:    false,
  poiLayerGroup:    L.layerGroup().addTo(map),
  fetchController:  null,
  fetchCache:       new Map(),
  lastCatDetails:   null,  // Issue 7: stores last WPI details for POI breakdown
  routeMode:        'straight', // 'straight' | 'walking' | 'driving'
};

// ─────────────────────────────────────────────────
// 4. RADIUS SLIDER
// ─────────────────────────────────────────────────

const radiusSlider = document.getElementById('radius-slider');
const radiusBadge  = document.getElementById('radius-badge');

function updateSliderUI(value) {
  state.radius = parseInt(value, 10);
  radiusBadge.textContent = toPersianNum(state.radius) + ' متر';

  // FIX [4]: slider has dir="ltr" so gradient goes left (min) → right (max)
  const pct = ((state.radius - 100) / (2000 - 100)) * 100;
  radiusSlider.style.background =
    `linear-gradient(to right, #00e5ff ${pct}%, #1e2d3d ${pct}%)`;

  if (state.bufferLayer && state.studyPoint && state.fetchedPOIs.length > 0) {
    drawBuffer(state.studyPoint[0], state.studyPoint[1]);
    runBufferAnalysis(false);
  }
}

radiusSlider.addEventListener('input', (e) => updateSliderUI(e.target.value));
updateSliderUI(500);

// ─────────────────────────────────────────────────
// 5. LAYER TOGGLES
// ─────────────────────────────────────────────────

function buildLayerToggles() {
  const container = document.getElementById('layer-toggles');
  container.innerHTML = '';

  Object.entries(CATEGORIES).forEach(([name, cfg]) => {
    const btn = document.createElement('button');
    btn.className = 'layer-toggle active';
    btn.dataset.cat = name;
    btn.innerHTML = `<span class="toggle-dot" style="background:${cfg.color}"></span>${cfg.icon} ${name}`;

    btn.addEventListener('click', () => {
      if (state.hiddenCategories.has(name)) {
        state.hiddenCategories.delete(name);
        btn.classList.add('active');
        addLog(`لایه «${name}» فعال شد.`, 'success');
      } else {
        state.hiddenCategories.add(name);
        btn.classList.remove('active');
        addLog(`لایه «${name}» مخفی شد.`, 'warn');
      }

      if (state.fetchedPOIs.length === 0) return;

      // Redraw map markers (renderAllPOIs already respects hiddenCategories)
      renderAllPOIs(state.fetchedPOIs);

      if (state.bufferLayer && state.studyPoint) {
        // Re-run full buffer analysis so score/breakdown/stats
        // only count currently VISIBLE categories
        runBufferAnalysis(false);
      } else {
        // No active buffer — wipe stale stats so nothing misleading shows
        resetStatsUI();
      }

      // Gap 2 fix (toggle): rebuild heatmap if active so it also respects the change
      if (state.heatmapActive && state.heatmapLayer) {
        map.removeLayer(state.heatmapLayer);
        const pts = state.fetchedPOIs
          .filter(f => !state.hiddenCategories.has(f.properties.category))
          .map(f => {
            const [flng, flat] = f.geometry.coordinates;
            return [flat, flng, Math.min(1, (f.properties.importanceWeight || 5) / 10)];
          });
        state.heatmapLayer = L.heatLayer(pts, {
          radius: 45, blur: 30, maxZoom: 17,
          gradient: { 0.0:'#001f3f', 0.2:'#0d47a1', 0.4:'#006064', 0.6:'#69f0ae', 0.8:'#ffab40', 1.0:'#ff1744' },
        }).addTo(map);
      }

      // If proximity line belongs to a now-hidden category, remove it cleanly
      const selectedCat = document.getElementById('category-select').value;
      if (state.lineLayer && state.hiddenCategories.has(selectedCat)) {
        map.removeLayer(state.lineLayer);
        state.lineLayer = null;
        document.getElementById('btn-nearest').classList.remove('active');
        document.getElementById('val-nearest').textContent = '—';
        document.getElementById('lbl-nearest').textContent = 'فاصله نزدیک‌ترین';
        document.getElementById('src-nearest').textContent = '—';
        addLog(`خط نزدیک‌ترین حذف شد — لایه «${selectedCat}» مخفی است.`, 'warn');
      }
    });

    container.appendChild(btn);
  });
}
buildLayerToggles();

// ── Route mode toggle buttons ──────────────────────────────────────────────────
function setRouteMode(mode) {
  state.routeMode = mode;
  ['mode-straight','mode-walking','mode-driving'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === 'mode-' + mode);
  });
  const labels = { straight:'فاصله هوایی', walking:'مسیر پیاده‌روی', driving:'مسیر ماشین' };
  addLog('حالت نمایش: ' + labels[mode], 'info');
}
// Null-guarded: if any button is missing in the HTML, skip without crashing
['mode-straight','mode-walking','mode-driving'].forEach((id, i) => {
  const modes = ['straight','walking','driving'];
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => setRouteMode(modes[i]));
  else console.warn('[GIS] Button not found:', id);
});

// ─────────────────────────────────────────────────
// 6. MAP CLICK → PLACE STUDY POINT
// ─────────────────────────────────────────────────

map.on('click', (e) => placeStudyPoint(e.latlng.lat, e.latlng.lng));

function placeStudyPoint(lat, lng) {
  state.studyPoint = [lat, lng];
  if (state.studyMarker) map.removeLayer(state.studyMarker);

  state.studyMarker = L.marker([lat, lng], {
    icon: L.divIcon({ html: '<div class="study-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9], className: '' }),
    zIndexOffset: 1000,
  }).addTo(map).bindPopup(`
    <h4>📍 نقطه مطالعاتی</h4>
    <p>عرض: ${lat.toFixed(5)}</p>
    <p>طول: ${lng.toFixed(5)}</p>
    <span class="popup-tag">دریافت داده OSM را بزنید</span>
  `);

  // Only reset POI data if point moved meaningfully (> ~50m)
  const cacheKey = makeCacheKey(lat, lng, state.radius);
  if (state.fetchCache.has(cacheKey)) {
    const cached = state.fetchCache.get(cacheKey);
    state.fetchedPOIs = cached;
    renderAllPOIs(cached);
    setButtonsEnabled(true);
    setAnalysisButtonsEnabled(true);
    setBadge('fetch-badge', 'done', toPersianNum(cached.length) + ' (کش)');
    addLog(`نقطه مطالعاتی ثبت شد. ${toPersianNum(cached.length)} مکان از کش بارگذاری شد.`, 'success');
  } else {
    state.fetchedPOIs = [];
    clearAnalysisLayers();
    resetStatsUI();
    setButtonsEnabled(true);
    setAnalysisButtonsEnabled(false);
    setBadge('fetch-badge', '', 'آماده');
    addLog(`نقطه مطالعاتی: (${lat.toFixed(4)}, ${lng.toFixed(4)})`, 'info');
    addLog('«دریافت داده از OSM» را بزنید.', 'warn');
  }
}

function makeCacheKey(lat, lng, radius) {
  // Round to ~100m grid for cache lookup
  return `${(lat).toFixed(3)},${(lng).toFixed(3)},${radius}`;
}

// ─────────────────────────────────────────────────
// 7. OVERPASS API — FETCH REAL POI DATA
// ─────────────────────────────────────────────────

/**
 * Builds Overpass QL query.
 * BUG-FIX [2]: mosque uses compound filter ["amenity"="place_of_worship"]["religion"="muslim"]
 */
function buildOverpassQuery(lat, lng, radius) {
  // Fetch within the larger of: user's buffer radius OR the biggest category threshold.
  // This ensures WPI can always find POIs up to each category's standard threshold
  // regardless of what buffer radius the user has selected.
  const maxThreshold = Math.max(...Object.values(CATEGORIES).map(c => c.threshold));
  const r = Math.max(radius, maxThreshold) + 200;
  const lines = new Set();

  Object.values(CATEGORIES).forEach(cfg => {
    cfg.tags.forEach(([k, v]) => {
      // Compound extra filter string (e.g. for mosque)
      const extra = (cfg.extraFilters || []).map(([ek, ev]) => `["${ek}"="${ev}"]`).join('');
      lines.add(`node["${k}"="${v}"]${extra}(around:${r},${lat},${lng});`);
      lines.add(`way["${k}"="${v}"]${extra}(around:${r},${lat},${lng});`);
    });
  });

  return `[out:json][timeout:30];\n(\n  ${[...lines].join('\n  ')}\n);\nout body center;`;
}

/**
 * FIX [3]: resolveCategory now checks extraFilters before returning a category.
 * A node tagged amenity=place_of_worship without religion=muslim → NOT مسجد.
 */
function resolveCategory(tags) {
  for (const [catName, cfg] of Object.entries(CATEGORIES)) {
    for (const [k, v] of cfg.tags) {
      if (tags[k] !== v) continue;
      // Check all extra filters (if defined)
      if (cfg.extraFilters) {
        const allMatch = cfg.extraFilters.every(([ek, ev]) => {
          const tagVal = (tags[ek] || '').toLowerCase();
          return tagVal === ev || tagVal === 'islam';
        });
        if (!allMatch) continue;
      }
      return catName;
    }
  }
  return null;
}

function parseOverpassResponse(data) {
  // FIX [5]: deduplicate by OSM element ID
  const seen     = new Set();
  const features = [];

  data.elements.forEach(el => {
    if (seen.has(el.id)) return;
    seen.add(el.id);

    let lat, lng;
    if (el.type === 'node') {
      lat = el.lat; lng = el.lon;
    } else if (el.type === 'way' && el.center) {
      lat = el.center.lat; lng = el.center.lon;
    } else {
      return;
    }

    const tags    = el.tags || {};
    const catName = resolveCategory(tags);
    if (!catName) return;

    const cfg  = CATEGORIES[catName];
    const name = tags['name:fa'] || tags.name || tags['name:en'] || catName;

    features.push({
      type: 'Feature',
      properties: { id: el.id, name, category: catName, icon: cfg.icon, color: cfg.color, importanceWeight: cfg.importanceWeight, osmTags: tags },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    });
  });

  return features;
}

// ── UI event bindings ─────────────────────────────────────────────────────────
document.getElementById('btn-fetch').addEventListener('click', fetchOSMData);

// Mirror endpoints: try primary, fall back if it fails
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOSMData() {
  if (!state.studyPoint) return;
  const [lat, lng] = state.studyPoint;

  // Check cache first
  const cacheKey = makeCacheKey(lat, lng, state.radius);
  if (state.fetchCache.has(cacheKey)) {
    const cached = state.fetchCache.get(cacheKey);
    state.fetchedPOIs = cached;
    renderAllPOIs(cached);
    setAnalysisButtonsEnabled(true);
    setBadge('fetch-badge', 'done', toPersianNum(cached.length) + ' (کش)');
    addLog(`${toPersianNum(cached.length)} مکان از حافظه کش بارگذاری شد.`, 'success');
    return;
  }

  if (state.fetchController) state.fetchController.abort();
  state.fetchController = new AbortController();

  setBadge('fetch-badge', 'fetching', 'در حال دریافت…');
  showLoading('در حال دریافت داده از OpenStreetMap…');
  document.getElementById('btn-fetch').classList.add('active');
  setAnalysisButtonsEnabled(false);

  // BUG-FIX [1]: body must be 'data=' + encoded query, NOT raw query text
  const query   = buildOverpassQuery(lat, lng, state.radius);
  const body    = 'data=' + encodeURIComponent(query);

  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        body,
        signal:  state.fetchController.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} از ${endpoint}`);

      const data     = await res.json();
      const features = parseOverpassResponse(data);

      state.fetchedPOIs = features;
      // Store in cache
      state.fetchCache.set(cacheKey, features);
      if (state.fetchCache.size > 20) {
        const firstKey = state.fetchCache.keys().next().value;
        state.fetchCache.delete(firstKey);
      }

      renderAllPOIs(features);
      setBadge('fetch-badge', 'done', toPersianNum(features.length) + ' مکان');
      hideLoading();
      setAnalysisButtonsEnabled(true);
      document.getElementById('btn-fetch').classList.remove('active');
      addLog(`✓ ${toPersianNum(features.length)} مکان از OSM دریافت شد.`, 'success');
      if (features.length === 0) showToast('هیچ مکانی یافت نشد. شعاع را بیشتر کنید.', 'warn');
      // Gap 2 fix: if heatmap was active, rebuild it with the fresh data
      if (state.heatmapActive && state.heatmapLayer) {
        map.removeLayer(state.heatmapLayer);
        const pts = features
          .filter(f => !state.hiddenCategories.has(f.properties.category))
          .map(f => {
            const [flng, flat] = f.geometry.coordinates;
            return [flat, flng, Math.min(1, (f.properties.importanceWeight || 5) / 10)];
          });
        state.heatmapLayer = L.heatLayer(pts, {
          radius: 45, blur: 30, maxZoom: 17,
          gradient: { 0.0:'#001f3f', 0.2:'#0d47a1', 0.4:'#006064', 0.6:'#69f0ae', 0.8:'#ffab40', 1.0:'#ff1744' },
        }).addTo(map);
        addLog('نقشه حرارتی با داده‌های جدید بازسازی شد.', 'info');
      }
      return;

    } catch (err) {
      if (err.name === 'AbortError') {
        hideLoading();
        document.getElementById('btn-fetch').classList.remove('active');
        setBadge('fetch-badge', '', 'لغو شد');
        addLog('درخواست لغو شد.', 'warn');
        return;
      }
      lastError = err;
      addLog(`تلاش با ${endpoint} ناموفق بود، در حال تلاش مجدد…`, 'warn');
    }
  }

  // All mirrors failed
  hideLoading();
  document.getElementById('btn-fetch').classList.remove('active');
  setBadge('fetch-badge', 'error', 'خطا');
  addLog(`خطا: ${lastError?.message}`, 'error');
  showToast('اتصال به Overpass API ناموفق بود. اینترنت را بررسی کنید.', 'error');
}

// ─────────────────────────────────────────────────
// 8. RENDER POIs ON MAP
// ─────────────────────────────────────────────────

function renderAllPOIs(features, highlightSet = null) {
  state.poiLayerGroup.clearLayers();

  features.forEach(feature => {
    const [flng, flat] = feature.geometry.coordinates;
    const { name, category, icon, color, osmTags } = feature.properties;

    // Respect layer toggle visibility
    if (state.hiddenCategories.has(category)) return;

    const isHighlighted = highlightSet ? highlightSet.has(feature) : true;

    const marker = L.circleMarker([flat, flng], {
      radius:      isHighlighted ? 10 : 6,
      fillColor:   isHighlighted ? color : '#1e2d3d',
      color:       isHighlighted ? 'rgba(255,255,255,0.3)' : 'transparent',
      weight:      isHighlighted ? 1.5 : 0,
      fillOpacity: isHighlighted ? 0.9 : 0.35,
    });

    let extra = '';
    if (osmTags.opening_hours) extra += `<p>ساعت کاری: ${osmTags.opening_hours}</p>`;
    if (osmTags.phone || osmTags['contact:phone']) extra += `<p>☎ ${osmTags.phone || osmTags['contact:phone']}</p>`;
    if (osmTags.website)  extra += `<p>🌐 وب‌سایت موجود</p>`;
    if (osmTags.operator) extra += `<p>اپراتور: ${osmTags.operator}</p>`;

    marker.bindPopup(`
      <h4>${icon} ${name}</h4>
      <p>دسته: <strong style="color:${color}">${category}</strong></p>
      <p>مختصات: ${flat.toFixed(4)}, ${flng.toFixed(4)}</p>
      ${extra}
      <a class="popup-osm-link" href="https://www.openstreetmap.org/${feature.properties.id}" target="_blank">🔗 نمایش در OSM</a>
    `);

    marker.addTo(state.poiLayerGroup);
  });
}

// ─────────────────────────────────────────────────
// 9. BUFFER ANALYSIS
// ─────────────────────────────────────────────────

document.getElementById('btn-buffer').addEventListener('click', () => {
  if (!state.studyPoint || state.fetchedPOIs.length === 0) {
    showToast('ابتدا داده را از OSM دریافت کنید.', 'warn'); return;
  }
  showLoading('در حال اجرای تحلیل بافر…');
  setTimeout(() => { runBufferAnalysis(true); hideLoading(); }, 120);
});

function drawBuffer(lat, lng) {
  if (state.bufferLayer) map.removeLayer(state.bufferLayer);
  const buffered = turf.buffer(turf.point([lng, lat]), state.radius / 1000, { units: 'kilometers', steps: 64 });
  state.bufferLayer = L.geoJSON(buffered, {
    style: { color: '#00e5ff', fillColor: '#00e5ff', fillOpacity: 0.07, weight: 2, dashArray: '6 4' },
  }).addTo(map);
  return buffered;
}

function runBufferAnalysis(fitBounds = true) {
  const [lat, lng] = state.studyPoint;
  const buffered   = drawBuffer(lat, lng);

  const inside    = [];
  const insideSet = new Set();

  state.fetchedPOIs.forEach(f => {
    // Skip hidden categories — they must not count toward score or breakdown
    if (state.hiddenCategories.has(f.properties.category)) return;
    if (turf.booleanPointInPolygon(f, buffered)) { inside.push(f); insideSet.add(f); }
  });

  // Full POI list passed so hidden ones render dimmed; insideSet contains only visible+inside
  renderAllPOIs(state.fetchedPOIs, insideSet);

  const breakdown = {};
  inside.forEach(f => { breakdown[f.properties.category] = (breakdown[f.properties.category] || 0) + 1; });

  // WPI uses ALL fetched POIs (not just those inside the buffer polygon)
  // because it measures distance from the study point, not membership.
  const { total, rawScore, catDetails, coveragePct, criticalPct, presentCount, visibleCatCount }
        = calcLivabilityScore(state.fetchedPOIs, state.studyPoint);
  state.lastCatDetails = catDetails;  // stored for POI breakdown WPI labels
  const uniqueCats  = Object.keys(breakdown).length;
  const hiddenCount = state.hiddenCategories.size;

  animateCounter('val-pois',      0, inside.length);
  animateCounter('val-score',     0, total);
  animateCounter('val-diversity', 0, uniqueCats);

  updateGauge(total);
  updateScoreBreakdown(coveragePct, criticalPct, total, rawScore);
  renderPOIBreakdown(breakdown);
  renderProximityBars(catDetails);

  const hiddenNote = hiddenCount > 0 ? ` — ${toPersianNum(hiddenCount)} لایه مخفی` : '';
  addLog(`بافر ${toPersianNum(state.radius)}م: ${toPersianNum(inside.length)} خدمت / ${toPersianNum(uniqueCats)} دسته${hiddenNote}`, 'success');
  addLog(`WPI (Gaussian) = ${toPersianNum(total)}/۱۰۰ | خام: ${toPersianNum(rawScore)} | پوشش: ${toPersianNum(coveragePct)}٪ | خدمات حیاتی: ${toPersianNum(criticalPct)}٪`, total >= 60 ? 'success' : total >= 30 ? 'warn' : 'error');

  document.getElementById('btn-buffer').classList.add('active');
  if (fitBounds && state.bufferLayer) map.fitBounds(state.bufferLayer.getBounds(), { padding: [40, 40] });
}

// ─────────────────────────────────────────────────
// 10. LIVABILITY SCORE — Weighted Proximity Index (WPI)
// ─────────────────────────────────────────────────

/**
 * Weighted Proximity Index (WPI) — upgraded to academic standard v2.
 *
 * UPGRADE 1 — Gaussian decay (replaces linear):
 *   f(d) = exp( −d² / 2σ² )   where σ = category threshold / 2
 *
 *   Behaviour:
 *     d = 0          → f = 1.000  (service is right here)
 *     d = σ          → f = 0.607  (half-threshold, still very accessible)
 *     d = threshold  → f = 0.135  (at standard limit, very low accessibility)
 *     d > threshold  → f → 0      (continuous, never hard-zero)
 *
 *   This matches observed human spatial behaviour (Neutens 2010, Paez 2012):
 *   people barely notice the difference between 50m and 150m, but accessibility
 *   drops sharply beyond the standard threshold.
 *
 * UPGRADE 2 — Fixed per-category thresholds (replaces user-defined radius):
 *   Each category has its own σ grounded in WHO/UN Habitat literature.
 *   The WPI is now reproducible regardless of what buffer the user selects.
 *
 * UPGRADE 3 — Critical service penalty multiplier:
 *   The 4 critical services (hospital, pharmacy, park, metro) get an additional
 *   multiplier applied to the final score:
 *     criticalPenalty = 0.70 + 0.30 × (criticalPresent / visibleCritical)
 *   → All 4 present:   × 1.00  (no penalty)
 *   → 3 of 4 present:  × 0.925
 *   → 2 of 4 present:  × 0.85
 *   → 1 of 4 present:  × 0.775
 *   → None present:    × 0.70  (30% penalty on top of the weight-based drag)
 *
 * WPI = ( Σ w_c × f(d_c) / Σ w_c ) × 100 × criticalPenalty   → 0–100
 *
 * Returns { total, rawScore, catDetails, coveragePct, criticalPct }
 */
function calcLivabilityScore(allPOIs, studyPoint) {
  const [lat, lng] = studyPoint;
  const pt         = turf.point([lng, lat]);

  const CRITICAL = new Set(['بیمارستان', 'داروخانه', 'پارک', 'ایستگاه مترو']);

  let totalWeight     = 0;
  let weightedProxSum = 0;
  let presentCount    = 0;
  let criticalPresent = 0;
  let visibleCatCount = 0;
  let visibleCritical = 0;
  const catDetails    = {};

  for (const [catName, cfg] of Object.entries(CATEGORIES)) {
    if (state.hiddenCategories.has(catName)) continue;

    const w         = cfg.importanceWeight;
    const sigma     = cfg.threshold / 2;   // Gaussian σ = threshold / 2
    totalWeight    += w;
    visibleCatCount++;
    if (CRITICAL.has(catName)) visibleCritical++;

    const catPOIs = allPOIs.filter(f => f.properties.category === catName);

    if (catPOIs.length === 0) {
      catDetails[catName] = {
        proximity: 0, distM: null, contribution: 0,
        present: false, weight: w, threshold: cfg.threshold,
      };
      continue;
    }

    const nearest  = turf.nearestPoint(pt, { type: 'FeatureCollection', features: catPOIs });
    const distM    = turf.distance(pt, nearest, { units: 'kilometers' }) * 1000;

    // ── Gaussian decay ──────────────────────────────────────────────────────
    // f(d) = exp( −d² / 2σ² )
    // σ = threshold/2 so the curve drops to ~0.135 exactly at the threshold.
    const proximity    = Math.exp(-(distM * distM) / (2 * sigma * sigma));
    const contribution = w * proximity;

    weightedProxSum += contribution;
    presentCount++;
    if (CRITICAL.has(catName)) criticalPresent++;

    catDetails[catName] = {
      proximity,
      distM:       Math.round(distM),
      contribution,
      present:     true,
      weight:      w,
      threshold:   cfg.threshold,
      nearestName: nearest.properties.name,
      nearestLat:  nearest.geometry.coordinates[1],
      nearestLng:  nearest.geometry.coordinates[0],
    };
  }

  // ── Critical service penalty ─────────────────────────────────────────────
  // Missing critical services apply a multiplier penalty on top of their
  // weight-based drag, because their absence is disproportionately harmful.
  const criticalRatio   = visibleCritical > 0 ? criticalPresent / visibleCritical : 1;
  const criticalPenalty = 0.70 + 0.30 * criticalRatio;

  const rawScore = totalWeight > 0
    ? (weightedProxSum / totalWeight) * 100
    : 0;
  const total = Math.min(100, Math.round(rawScore * criticalPenalty));

  const coveragePct = visibleCatCount > 0
    ? Math.round((presentCount    / visibleCatCount) * 100) : 0;
  const criticalPct = visibleCritical > 0
    ? Math.round((criticalPresent / visibleCritical) * 100) : 0;

  return { total, rawScore: Math.round(rawScore), catDetails, coveragePct, criticalPct, presentCount, visibleCatCount };
}

// ─────────────────────────────────────────────────
// 11. PROXIMITY ANALYSIS — NEAREST OF SELECTED CATEGORY
// ─────────────────────────────────────────────────

document.getElementById('btn-nearest').addEventListener('click', () => {
  if (!state.studyPoint || state.fetchedPOIs.length === 0) {
    showToast('ابتدا داده را از OSM دریافت کنید.', 'warn'); return;
  }
  showLoading('در حال محاسبه نزدیک‌ترین…');
  // Bug 5 fix: await the async function so hideLoading fires AFTER OSRM fetch
  setTimeout(async () => {
    try {
      await runProximityAnalysis();
    } catch (err) {
      addLog('خطای داخلی در تحلیل نزدیک‌ترین: ' + err.message, 'error');
    } finally {
      hideLoading(); // always runs — even if runProximityAnalysis throws
    }
  }, 120);
});

async function runProximityAnalysis() {
  const [lat, lng]  = state.studyPoint;
  const selectedCat = document.getElementById('category-select').value;

  // Guard: hidden category
  if (state.hiddenCategories.has(selectedCat)) {
    const cfg = CATEGORIES[selectedCat] || { icon: '🚫' };
    showToast(
      `${cfg.icon} لایه «${selectedCat}» توسط شما خاموش شده است. ابتدا این لایه را در بخش «لایه‌های نمایش» روشن کنید.`,
      'warn', 6000
    );
    addLog(`⛔ تحلیل نزدیک‌ترین لغو شد — لایه «${selectedCat}» خاموش است.`, 'warn');
    const toggleBtn = document.querySelector(`.layer-toggle[data-cat="${selectedCat}"]`);
    if (toggleBtn) {
      toggleBtn.style.transition = 'box-shadow 0.15s';
      let i = 0;
      const pulse = setInterval(() => {
        toggleBtn.style.boxShadow = i % 2 === 0
          ? `0 0 0 3px ${CATEGORIES[selectedCat]?.color || '#ffd740'}` : 'none';
        if (++i >= 6) { clearInterval(pulse); toggleBtn.style.boxShadow = 'none'; }
      }, 180);
    }
    return;
  }

  const pt = turf.point([lng, lat]);
  const fc = {
    type: 'FeatureCollection',
    features: state.fetchedPOIs.filter(f => f.properties.category === selectedCat),
  };

  if (fc.features.length === 0) {
    showToast(`هیچ «${selectedCat}»ی در داده‌های دریافتی یافت نشد. شعاع را افزایش دهید.`, 'warn');
    addLog(`دسته «${selectedCat}» در محدوده یافت نشد.`, 'warn');
    return;
  }

  const nearest = turf.nearestPoint(pt, fc);
  const [nlng, nlat] = nearest.geometry.coordinates;
  const straightDistM = Math.round(turf.distance(pt, nearest, { units: 'kilometers' }) * 1000);
  const cfg = CATEGORIES[selectedCat];
  const [midLat, midLng] = [(lat + nlat) / 2, (lng + nlng) / 2];

  // Clear previous line/route
  if (state.lineLayer) { map.removeLayer(state.lineLayer); state.lineLayer = null; }
  if (state.routeLayer){ map.removeLayer(state.routeLayer); state.routeLayer = null; }
  state.routeMarkers.clearLayers();
  state.lineLayer = L.featureGroup().addTo(map);

  // ── Destination ring (shown in both modes) ─────────────────────────────────
  L.circleMarker([nlat, nlng], {
    radius: 18, color: cfg.color, fillColor: 'transparent', weight: 2.5, dashArray: '4 3', opacity: 0.9,
  }).addTo(state.lineLayer);

  // ── MODE: Straight line (فاصله هوایی) ─────────────────────────────────────
  if (state.routeMode === 'straight') {
    L.geoJSON(turf.lineString([[lng, lat], nearest.geometry.coordinates]), {
      style: { color: '#40c4ff', weight: 2.5, dashArray: '10 6', opacity: 0.85 },
    }).addTo(state.lineLayer);

    L.marker([midLat, midLng], {
      icon: L.divIcon({
        html: `<div style="background:rgba(11,23,36,0.93);border:1px solid #40c4ff;color:#40c4ff;font-family:Vazirmatn,sans-serif;font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px;white-space:nowrap;direction:rtl;">📐 ${toPersianNum(straightDistM)} متر (هوایی)</div>`,
        className: '', iconAnchor: [60, 12],
      }),
    }).addTo(state.lineLayer);

    animateCounter('val-nearest', 0, straightDistM, 700, ' متر');
    addLog(`📐 فاصله هوایی تا ${selectedCat}: ${toPersianNum(straightDistM)} متر`, 'info');
    map.fitBounds(L.latLngBounds([lat, lng], [nlat, nlng]), { padding: [70, 70] });

  // ── MODE: Walking or Driving route ─────────────────────────────────────────
  } else {
    const isWalking   = state.routeMode === 'walking';
    const routeMode   = isWalking ? 'foot' : 'driving';
    const routeColor  = isWalking ? '#69f0ae' : '#ffab40'; // green=walk, orange=drive
    const routeEmoji  = isWalking ? '🚶' : '🚗';
    const routeLabel  = isWalking ? 'پیاده' : 'با ماشین';

    // Placeholder dashed line while fetching
    L.geoJSON(turf.lineString([[lng, lat], nearest.geometry.coordinates]), {
      style: { color: routeColor, weight: 2, dashArray: '8 5', opacity: 0.35 },
    }).addTo(state.lineLayer);
    L.marker([midLat, midLng], {
      icon: L.divIcon({
        html: `<div style="background:rgba(11,23,36,0.93);border:1px solid ${routeColor};color:${routeColor};font-family:Vazirmatn,sans-serif;font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;direction:rtl;opacity:0.7;">${routeEmoji} در حال دریافت مسیر…</div>`,
        className: '', iconAnchor: [80, 12],
      }),
    }).addTo(state.lineLayer);
    map.fitBounds(L.latLngBounds([lat, lng], [nlat, nlng]), { padding: [70, 70] });

    document.getElementById('loading-msg').textContent =
      isWalking ? 'در حال دریافت مسیر پیاده‌روی از Valhalla…' : 'در حال دریافت مسیر ماشین از Valhalla…';

    // Fetch real route: Valhalla primary, OSRM fallback
    const route = await fetchRoute(lat, lng, nlat, nlng, routeMode);

    // Clear placeholder, draw final route
    if (state.lineLayer) { map.removeLayer(state.lineLayer); state.lineLayer = null; }
    state.lineLayer = L.featureGroup().addTo(map);

    L.circleMarker([nlat, nlng], {
      radius: 18, color: routeColor, fillColor: 'transparent', weight: 2.5, dashArray: '4 3', opacity: 0.9,
    }).addTo(state.lineLayer);

    if (route) {
      L.geoJSON(route.geometry, {
        style: { color: routeColor, weight: 5, opacity: 0.92, lineJoin: 'round', lineCap: 'round' },
      }).addTo(state.lineLayer);

      const distText = route.distanceM < 1000
        ? toPersianNum(route.distanceM) + ' متر'
        : toPersianNum((route.distanceM / 1000).toFixed(1)) + ' کیلومتر';
      const timeText = toPersianNum(route.durationMin) + ' دقیقه ' + routeLabel;

      L.marker([midLat, midLng], {
        icon: L.divIcon({
          html: `<div style="background:rgba(11,23,36,0.95);border:1px solid ${routeColor};color:${routeColor};font-family:Vazirmatn,sans-serif;font-size:11px;font-weight:700;padding:4px 10px;border-radius:8px;white-space:nowrap;direction:rtl;">${routeEmoji} ${distText} | ⏱ ${timeText}</div>`,
          className: '', iconAnchor: [70, 12],
        }),
      }).addTo(state.lineLayer);

      animateCounter('val-nearest', 0, route.distanceM, 700, ' متر');
      addLog(`${routeEmoji} مسیر ${routeLabel} به ${selectedCat}: ${distText} (${timeText})`, 'success');
      map.fitBounds(state.lineLayer.getBounds(), { padding: [70, 70] });

    } else {
      // All routing servers failed — show straight line fallback
      L.geoJSON(turf.lineString([[lng, lat], nearest.geometry.coordinates]), {
        style: { color: routeColor, weight: 2.5, dashArray: '8 5', opacity: 0.7 },
      }).addTo(state.lineLayer);
      L.marker([midLat, midLng], {
        icon: L.divIcon({
          html: `<div style="background:rgba(11,23,36,0.93);border:1px solid ${routeColor};color:${routeColor};font-family:Vazirmatn,sans-serif;font-size:11px;padding:3px 9px;border-radius:6px;direction:rtl;">📐 ${toPersianNum(straightDistM)} متر (سرور مسیریابی در دسترس نیست)</div>`,
          className: '', iconAnchor: [100, 12],
        }),
      }).addTo(state.lineLayer);
      animateCounter('val-nearest', 0, straightDistM, 700, ' متر');
      addLog('سرورهای مسیریابی پاسخ ندادند — فاصله هوایی نمایش داده شد.', 'warn');
      map.fitBounds(L.latLngBounds([lat, lng], [nlat, nlng]), { padding: [70, 70] });
    }
  }

  // Update stat card labels (distance value is already set inside each branch)
  document.getElementById('lbl-nearest').textContent = `نزدیک‌ترین ${selectedCat}`;
  document.getElementById('src-nearest').textContent  = nearest.properties.name;
  document.getElementById('stat-nearest').classList.add('updated');
  addLog(`${cfg.icon} نزدیک‌ترین ${selectedCat}: ${nearest.properties.name}`, 'success');
  document.getElementById('btn-nearest').classList.add('active');

}

// ─────────────────────────────────────────────────
// 12. HEATMAP
// ─────────────────────────────────────────────────

document.getElementById('btn-heatmap').addEventListener('click', () => {
  if (!state.studyPoint || state.fetchedPOIs.length === 0) {
    showToast('ابتدا داده را از OSM دریافت کنید.', 'warn'); return;
  }

  if (state.heatmapActive) {
    if (state.heatmapLayer) map.removeLayer(state.heatmapLayer);
    state.heatmapActive = false;
    document.getElementById('btn-heatmap').classList.remove('active');
    addLog('نقشه حرارتی غیرفعال شد.', 'info');
    return;
  }

  const heatPoints = state.fetchedPOIs
    .filter(f => !state.hiddenCategories.has(f.properties.category)) // Gap 1 fix: respect layer toggles
    .map(f => {
      const [flng, flat] = f.geometry.coordinates;
      // importanceWeight 4–9 → normalised to 0.4–0.9 heat intensity
      return [flat, flng, Math.min(1, (f.properties.importanceWeight || 5) / 10)];
    });

  state.heatmapLayer = L.heatLayer(heatPoints, {
    radius: 45, blur: 30, maxZoom: 17,
    gradient: { 0.0:'#001f3f', 0.2:'#0d47a1', 0.4:'#006064', 0.6:'#69f0ae', 0.8:'#ffab40', 1.0:'#ff1744' },
  }).addTo(map);

  state.heatmapActive = true;
  document.getElementById('btn-heatmap').classList.add('active');
  addLog(`نقشه حرارتی فعال شد (${toPersianNum(state.fetchedPOIs.length)} نقطه).`, 'success');
});

// ─────────────────────────────────────────────────
// 13. REAL ROAD ROUTING  (OSRM — walking)
// ─────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// ROUTING ENGINE
// Primary:  Valhalla (valhalla1.openstreetmap.de) — proper pedestrian/car engine
//           Uses OSM footways, alleys, crossings for pedestrian mode
//           Uses real road network with turn restrictions for driving mode
// Fallback: routing.openstreetmap.de OSRM instances
// ══════════════════════════════════════════════════════════════════════════════

const ROUTE_TIMEOUT_MS     = 9000;  // abort after 9 seconds
const WALK_SPEED_M_PER_MIN = 75;    // 4.5 km/h — emergency fallback only

/**
 * Decode a Valhalla/Google encoded polyline to a GeoJSON LineString.
 * Valhalla uses precision=6 (1e6 factor) by default.
 */
function decodePolyline(encoded, precision = 6) {
  const factor = Math.pow(10, precision);
  const coordinates = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; }
    while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; }
    while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lng / factor, lat / factor]); // GeoJSON: [lng, lat]
  }
  return { type: 'LineString', coordinates };
}

/**
 * Primary routing: Valhalla public instance by Geofabrik.
 *  mode='pedestrian' → uses footways, crossings, alleys (NOT car roads)
 *  mode='auto'       → uses car roads with turn restrictions & speed limits
 */
async function fetchValhalla(fromLat, fromLng, toLat, toLng, costing) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch('https://valhalla1.openstreetmap.de/route', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  controller.signal,
      body: JSON.stringify({
        locations: [
          { lon: fromLng, lat: fromLat },
          { lon: toLng,   lat: toLat   },
        ],
        costing,
        directions_options: { units: 'kilometers' },
      }),
    });
    clearTimeout(timer);
    const data = await res.json();
    if (!data.trip?.legs?.length) return null;
    const distanceM  = Math.round(data.trip.summary.length * 1000);
    const durationMin = Math.max(1, Math.round(data.trip.summary.time / 60));
    const geometry   = decodePolyline(data.trip.legs[0].shape);
    return { geometry, distanceM, durationMin };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fallback routing: OSRM instances on routing.openstreetmap.de.
 */
async function fetchOSRM(fromLat, fromLng, toLat, toLng, profile) {
  const base = profile === 'foot'
    ? 'https://routing.openstreetmap.de/routed-foot/route/v1/driving'
    : 'https://routing.openstreetmap.de/routed-car/route/v1/driving';
  const url  = `${base}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res  = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    const distanceM  = Math.round(data.routes[0].distance);
    const osrmSecs   = data.routes[0].duration;
    const durationMin = profile === 'foot'
      ? Math.max(1, Math.round(distanceM / WALK_SPEED_M_PER_MIN))
      : Math.max(1, Math.round(osrmSecs / 60));
    return { geometry: data.routes[0].geometry, distanceM, durationMin };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Main routing function.
 *  mode = 'foot'    → Valhalla pedestrian → OSRM foot fallback
 *  mode = 'driving' → Valhalla auto       → OSRM car fallback
 */
async function fetchRoute(fromLat, fromLng, toLat, toLng, mode = 'foot') {
  const vCosting = mode === 'foot' ? 'pedestrian' : 'auto';
  const result = await fetchValhalla(fromLat, fromLng, toLat, toLng, vCosting);
  if (result) return result;
  addLog('Valhalla پاسخ نداد — در حال تلاش با OSRM…', 'warn');
  return fetchOSRM(fromLat, fromLng, toLat, toLng, mode);
}

/** Clear any displayed route from the map. */
function clearRoute() {
  if (state.routeLayer) { map.removeLayer(state.routeLayer); state.routeLayer = null; }
  state.routeMarkers.clearLayers();
}

/**
 * Show the real walking route to the nearest POI of a given category.
 * Called when the user clicks the 🗺 button on a proximity bar row.
 */
async function showRouteTo(catName, detail) {
  clearRoute();
  // Bug B fix: also clear lineLayer (walking-mode nearest route lives there)
  if (state.lineLayer) { map.removeLayer(state.lineLayer); state.lineLayer = null; }
  if (!detail?.present || !state.studyPoint) return;

  const cfg = CATEGORIES[catName];
  const [fromLat, fromLng] = state.studyPoint;

  // Show a loading toast
  addLog(`📡 در حال دریافت مسیر به ${catName}…`, 'info');

  const route = await fetchRoute(fromLat, fromLng, detail.nearestLat, detail.nearestLng, 'foot');

  if (!route) {
    addLog('مسیریابی ناموفق — شاید سرور OSRM در دسترس نیست.', 'warn');
    return;
  }

  // ── Draw route polyline ──────────────────────────────────────────────────
  state.routeLayer = L.geoJSON(route.geometry, {
    style: {
      color:     cfg.color,
      weight:    5,
      opacity:   0.92,
      lineJoin:  'round',
      lineCap:   'round',
    },
  }).addTo(map);

  // ── Distance + time label at destination ────────────────────────────────
  const distText = route.distanceM < 1000
    ? toPersianNum(route.distanceM) + ' متر'
    : toPersianNum((route.distanceM / 1000).toFixed(1)) + ' کیلومتر';
  const timeText = toPersianNum(route.durationMin) + ' دقیقه پیاده';

  L.marker([detail.nearestLat, detail.nearestLng], {
    icon: L.divIcon({
      html: `<div style="
        background:${cfg.color};color:#0b1724;
        font-family:Vazirmatn,sans-serif;font-size:11px;font-weight:800;
        padding:5px 11px;border-radius:10px;
        white-space:nowrap;direction:rtl;
        box-shadow:0 2px 8px rgba(0,0,0,0.5);
      ">🚶 ${distText} | ⏱ ${timeText}</div>`,
      className: '',
      iconAnchor: [0, 30],
    }),
  }).addTo(state.routeMarkers);

  // ── Origin pulse marker ──────────────────────────────────────────────────
  L.circleMarker([fromLat, fromLng], {
    radius: 8, color: cfg.color, fillColor: cfg.color,
    fillOpacity: 0.4, weight: 2.5,
  }).addTo(state.routeMarkers);

  // ── Fit map to route ─────────────────────────────────────────────────────
  map.fitBounds(state.routeLayer.getBounds(), { padding: [60, 60] });

  addLog(`${cfg.icon} مسیر به ${catName}: ${distText} (${timeText})`, 'success');
  addLog(`📍 مقصد: ${detail.nearestName || catName}`, 'info');
}



document.getElementById('btn-export').addEventListener('click', exportGeoJSON);

function exportGeoJSON() {
  if (!state.fetchedPOIs.length) {
    showToast('هیچ داده‌ای برای خروجی وجود ندارد.', 'warn'); return;
  }

  const fc = {
    type: 'FeatureCollection',
    metadata: {
      generated:  new Date().toISOString(),
      studyPoint: state.studyPoint,
      radius:     state.radius,
      source:     'OpenStreetMap via Overpass API',
      project:    'محله هوشمند | GIS دانشگاهی',
      developers: ['محمد عرفان حمزه‌ای', 'حسین اقدم'],
    },
    features: state.fetchedPOIs.map(f => ({
      type: f.type,
      properties: {
        id:       f.properties.id,
        name:     f.properties.name,
        category: f.properties.category,
        icon:     f.properties.icon,
        importanceWeight: f.properties.importanceWeight,
      },
      geometry: f.geometry,
    })),
  };

  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `gis-analysis-${Date.now()}.geojson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  addLog(`خروجی GeoJSON (${toPersianNum(state.fetchedPOIs.length)} مکان) ذخیره شد.`, 'success');
  showToast(`فایل GeoJSON با ${toPersianNum(state.fetchedPOIs.length)} مکان دانلود شد.`, 'success', 3000);
}

// ─────────────────────────────────────────────────
// 14. NOMINATIM GEOCODING
// ─────────────────────────────────────────────────

const geocodeInput   = document.getElementById('geocode-input');
const geocodeResults = document.getElementById('geocode-results');
let geocodeDebounce  = null;

document.getElementById('geocode-btn').addEventListener('click', () => doGeocode(geocodeInput.value));

geocodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doGeocode(geocodeInput.value);
});

geocodeInput.addEventListener('input', () => {
  clearTimeout(geocodeDebounce);
  if (geocodeInput.value.length < 3) { geocodeResults.style.display = 'none'; return; }
  geocodeDebounce = setTimeout(() => doGeocode(geocodeInput.value), 500);
});

async function doGeocode(query) {
  if (!query.trim()) return;
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=fa`;
    const res = await fetch(url, { headers: { 'User-Agent': 'SmartNeighborhood GIS Academic Project' } });
    const data = await res.json();

    geocodeResults.innerHTML = '';
    if (data.length === 0) {
      geocodeResults.innerHTML = '<div class="geocode-result-item">نتیجه‌ای یافت نشد.</div>';
      geocodeResults.style.display = 'block';
      return;
    }

    data.forEach(result => {
      const item = document.createElement('div');
      item.className = 'geocode-result-item';
      const name = result.display_name.split(',').slice(0, 3).join('، ');
      item.innerHTML = `<strong>${result.name || name}</strong>${result.display_name}`;
      item.addEventListener('click', () => {
        const lat = parseFloat(result.lat);
        const lng = parseFloat(result.lon);
        map.setView([lat, lng], 15);
        placeStudyPoint(lat, lng);
        geocodeResults.style.display = 'none';
        geocodeInput.value = result.display_name.split(',')[0];
        addLog(`مکان‌یابی: ${result.display_name.split(',')[0]}`, 'success');
      });
      geocodeResults.appendChild(item);
    });

    geocodeResults.style.display = 'block';
  } catch (err) {
    addLog('خطا در جستجوی آدرس.', 'error');
  }
}

// Close geocode results on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-section')) geocodeResults.style.display = 'none';
});

// ─────────────────────────────────────────────────
// 15. CLEAR ALL
// ─────────────────────────────────────────────────

document.getElementById('btn-clear').addEventListener('click', clearAll);

function clearAll() {
  if (state.studyMarker)  { map.removeLayer(state.studyMarker);  state.studyMarker  = null; }
  clearAnalysisLayers();
  state.fetchedPOIs    = [];
  state.studyPoint     = null;
  state.poiLayerGroup.clearLayers();

  resetStatsUI();
  setButtonsEnabled(false);
  ['btn-buffer','btn-nearest','btn-heatmap','btn-fetch','btn-export'].forEach(id =>
    document.getElementById(id).classList.remove('active')
  );
  state.fetchCache.clear();          // Bug 4 fix: clear stale cache on reset
  setBadge('fetch-badge', '', 'آماده');
  map.setView([35.6892, 51.3890], 14);
  addLog('نقشه پاک شد. آماده برای تحلیل جدید.', 'warn');
}

function clearAnalysisLayers() {
  if (state.bufferLayer)  { map.removeLayer(state.bufferLayer);  state.bufferLayer  = null; }
  if (state.lineLayer)    { map.removeLayer(state.lineLayer);     state.lineLayer    = null; }
  if (state.heatmapLayer) { map.removeLayer(state.heatmapLayer); state.heatmapLayer = null; }
  clearRoute();
  state.heatmapActive = false;
  state.poiLayerGroup.clearLayers();
}

// ─────────────────────────────────────────────────
// 16. GAUGE + SCORE BREAKDOWN
// ─────────────────────────────────────────────────

function updateGauge(score) {
  const wrap = document.getElementById('gauge-wrap');
  wrap.style.display = 'block';
  wrap.classList.add('fade-in');

  const filled = (score / 100) * 251;
  document.getElementById('gauge-fill').setAttribute('stroke-dasharray', `${filled} 251`);

  const angle = -Math.PI + (score / 100) * Math.PI;
  document.getElementById('gauge-dot').setAttribute('cx', 100 + 80 * Math.cos(angle));
  document.getElementById('gauge-dot').setAttribute('cy', 100 + 80 * Math.sin(angle));

  let label, color;
  if      (score >= 75) { label = 'عالی 🌟';       color = '#69f0ae'; }
  else if (score >= 55) { label = 'خوب ✓';          color = '#40c4ff'; }
  else if (score >= 35) { label = 'متوسط ⚠';       color = '#ffab40'; }
  else if (score >= 15) { label = 'ضعیف ↓';        color = '#ffd740'; }
  else                  { label = 'بسیار ضعیف ✕';  color = '#ff5252'; }

  animateCounter('gauge-number', 0, score);
  document.getElementById('gauge-label').textContent = label;
  document.getElementById('gauge-label').style.color  = color;
  document.getElementById('gauge-number').style.color  = color;
}

/**
 * Score breakdown panel — 3 high-level bars:
 *   پوشش خدمات  : % of visible categories that have at least one nearby POI
 *   خدمات حیاتی : % of the 4 critical categories (hospital/pharmacy/park/metro) present
 *   شاخص WPI    : the final weighted proximity score (= gauge number)
 */
function updateScoreBreakdown(coveragePct, criticalPct, total, rawScore) {
  const section = document.getElementById('score-breakdown');
  section.style.display = 'block';

  const setBar = (barId, valId, val, suffix = '٪') => {
    document.getElementById(valId).textContent = toPersianNum(val) + suffix;
    setTimeout(() => {
      document.getElementById(barId).style.width = `${val}%`;
    }, 50);
  };

  setBar('br-diversity', 'bv-diversity', coveragePct);
  setBar('br-count',     'bv-count',     criticalPct);
  setBar('br-volume',    'bv-volume',    total, '');

  // Show raw vs penalized score if a critical-service penalty was applied
  const penaltyEl = document.getElementById('wpi-penalty-note');
  if (penaltyEl) {
    if (rawScore !== undefined && rawScore !== total) {
      penaltyEl.textContent = `(خام: ${toPersianNum(rawScore)} ← جریمه خدمات حیاتی)`;
      penaltyEl.style.display = 'block';
    } else {
      penaltyEl.style.display = 'none';
    }
  }
}

/**
 * Per-category proximity bars — the heart of the WPI visualisation.
 * Each row shows:
 *   • Category icon + name
 *   • Animated bar (width = proximity %, colour = category colour, fades if missing)
 *   • Distance in metres (or "یافت نشد" if absent)
 *   • Proximity % label
 *
 * Colour coding for the bar:
 *   ≥ 70% (very close)  → category colour, full opacity
 *   40–69%              → category colour, 75% opacity
 *   < 40%               → category colour, 40% opacity
 *   missing             → grey dashed placeholder
 */
function renderProximityBars(catDetails) {
  const container = document.getElementById('diversity-bars');
  container.innerHTML = '';

  // Sort: present categories first (by proximity desc), then missing
  const entries = Object.entries(catDetails).sort((a, b) => {
    if (a[1].present !== b[1].present) return a[1].present ? -1 : 1;
    return b[1].proximity - a[1].proximity;
  });

  entries.forEach(([catName, detail]) => {
    const cfg   = CATEGORIES[catName] || { color: '#607d8b', icon: '•' };
    const row   = document.createElement('div');
    row.className = 'prox-row';

    if (!detail.present) {
      // Missing — show greyed-out row
      row.innerHTML = `
        <div class="prox-name">${cfg.icon} <span>${catName}</span></div>
        <div class="prox-bar-track prox-missing">
          <span class="prox-missing-label">یافت نشد</span>
        </div>
        <div class="prox-meta prox-meta--absent">—</div>`;
    } else {
      // Bar = linear distance-vs-threshold (intuitive %). WPI uses Gaussian internally.
      const pct      = Math.max(0, Math.round((1 - detail.distM / detail.threshold) * 100));
      const gaussPct = Math.round(detail.proximity * 100);
      const opacity  = pct >= 70 ? 1 : pct >= 40 ? 0.75 : 0.45;
      const distText = detail.distM < 1000
        ? toPersianNum(detail.distM) + ' م'
        : toPersianNum((detail.distM / 1000).toFixed(1)) + ' کیلومتر';

      row.innerHTML = `
        <div class="prox-name">${cfg.icon} <span>${catName}</span></div>
        <div class="prox-bar-track">
          <div class="prox-bar-fill" data-pct="${pct}"
               style="width:0%;background:${cfg.color};opacity:${opacity}"></div>
        </div>
        <div class="prox-meta">
          <span class="prox-dist">${distText}</span>
          <span class="prox-pct" style="color:${cfg.color}">${toPersianNum(pct)}٪</span>
          <button class="prox-route-btn" title="نمایش مسیر واقعی پیاده‌روی" style="--cat-color:${cfg.color}">🗺</button>
        </div>`;

      row.title = `${catName} | فاصله: ${detail.distM}م | آستانه: ${detail.threshold}م | دسترسی (Gaussian): ${gaussPct}٪ | وزن: ${toPersianNum(detail.weight)}`;

      row.querySelector('.prox-route-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showRouteTo(catName, detail);
      });
    }

    container.appendChild(row);

    // Animate bar fill after paint
    if (detail.present) {
      const fill = row.querySelector('.prox-bar-fill');
      setTimeout(() => { fill.style.width = fill.dataset.pct + '%'; }, 60);
    }
  });
}

function renderPOIBreakdown(breakdown) {
  const section = document.getElementById('poi-section');
  const list    = document.getElementById('poi-list');
  list.innerHTML = '';

  if (Object.keys(breakdown).length === 0) {
    list.innerHTML = '<div class="log-entry log-warn">هیچ خدمتی در بافر یافت نشد.</div>';
    section.style.display = 'block'; return;
  }

  Object.entries(breakdown).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    const cfg    = CATEGORIES[cat] || { color: '#b0bec5', icon: '📍', importanceWeight: 0 };
    // Issue 7 fix: show real WPI proximity % instead of misleading count-based pts
    const detail = state.lastCatDetails?.[cat];
    const proxPct = detail ? Math.round(detail.proximity * 100) : null;
    const proxLabel = proxPct !== null
      ? `<span class="poi-item-score" title="دسترسی WPI">${toPersianNum(proxPct)}٪</span>`
      : '';
    const div = document.createElement('div');
    div.className = 'poi-item fade-in';
    div.innerHTML = `
      <div class="poi-item-left">
        <span class="poi-dot" style="background:${cfg.color}"></span>
        <span class="poi-item-name">${cfg.icon} ${cat}</span>
      </div>
      <div class="poi-item-right">
        <span class="poi-item-count">${toPersianNum(count)}</span>
        ${proxLabel}
      </div>`;
    list.appendChild(div);
  });

  section.style.display = 'block';
}

// ─────────────────────────────────────────────────
// 17. SIDEBAR TOGGLE
// ─────────────────────────────────────────────────

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('sidebar-open').style.display = 'flex';
  setTimeout(() => map.invalidateSize(), 380);
});
document.getElementById('sidebar-open').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('sidebar-open').style.display = 'none';
  setTimeout(() => map.invalidateSize(), 380);
});

// ─────────────────────────────────────────────────
// 18. UI HELPERS
// ─────────────────────────────────────────────────

function setButtonsEnabled(enabled) {
  ['btn-fetch', 'btn-clear', 'btn-export'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
  if (!enabled) setAnalysisButtonsEnabled(false);
}

function setAnalysisButtonsEnabled(enabled) {
  ['btn-buffer', 'btn-nearest', 'btn-heatmap'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
  document.getElementById('btn-export').disabled = !enabled;
}

/** Animated roll-up counter — shows the number incrementing from 0 */
function animateCounter(elId, from, to, duration = 700, suffix = '') {
  const el = document.getElementById(elId);
  if (!el) return;
  const start = performance.now();
  const update = (now) => {
    const t       = Math.min((now - start) / duration, 1);
    const eased   = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const current = Math.round(from + (to - from) * eased);
    el.textContent = toPersianNum(current) + suffix;
    if (t < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function resetStatsUI() {
  ['val-pois','val-score','val-nearest','val-diversity'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  const lbl = document.getElementById('lbl-nearest');
  if (lbl) lbl.textContent = 'فاصله نزدیک‌ترین';
  document.getElementById('src-nearest').textContent = '—';
  document.getElementById('gauge-wrap').style.display   = 'none';
  document.getElementById('poi-section').style.display  = 'none';
  document.getElementById('score-breakdown').style.display = 'none';
  const db = document.getElementById('diversity-bars'); if (db) db.innerHTML = '';
}

function setBadge(id, type, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className   = 'btn-badge' + (type ? ` ${type}` : '');
  el.textContent = text;
}

function addLog(msg, type = 'info') {
  const box = document.getElementById('log-box');
  if (!box) return;
  const div  = document.createElement('div');
  div.className   = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString('fa-IR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  div.textContent = `[${time}] ${msg}`;
  box.insertBefore(div, box.firstChild);
  while (box.children.length > 18) box.removeChild(box.lastChild);
}

function showLoading(msg = 'در حال پردازش…') {
  const el = document.getElementById('loading');
  const m  = document.getElementById('loading-msg');
  if (el) el.style.display = 'flex';
  if (m)  m.textContent    = msg;
}
function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.style.display = 'none';
}

let toastTimer = null;
function showToast(msg, type = 'error', duration = 5000) {
  const toast  = document.getElementById('api-toast');
  const msgEl  = document.getElementById('toast-msg');
  const iconEl = document.getElementById('toast-icon');
  if (!toast) return;
  msgEl.textContent  = msg;
  iconEl.textContent = type === 'error' ? '⚠' : type === 'warn' ? '⚡' : '✓';
  toast.className    = `api-toast${type === 'success' ? ' success' : type === 'warn' ? ' warn' : ''}`;
  toast.style.display = 'flex';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, duration);
}
document.getElementById('toast-close')?.addEventListener('click', () => {
  document.getElementById('api-toast').style.display = 'none';
});

function toPersianNum(n) {
  return String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}



// ─────────────────────────────────────────────────
// 19. KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  // Close geocode results on Escape regardless of focus
  if (e.key === 'Escape') {
    const results = document.getElementById('geocode-results');
    if (results && results.style.display !== 'none') {
      results.style.display = 'none';
      return;
    }
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (!state.studyPoint) return;
  switch (e.key) {
    case '1': document.getElementById('btn-fetch').click();   break;
    case '2': document.getElementById('btn-buffer').click();  break;
    case '3': document.getElementById('btn-nearest').click(); break;
    case '4': document.getElementById('btn-heatmap').click(); break;
    case '5': document.getElementById('btn-export').click();  break;
    case 'Escape': clearAll(); break;
  }
});

// ─────────────────────────────────────────────────
// 20. STARTUP
// ─────────────────────────────────────────────────

setTimeout(() => addLog('سامانه محله هوشمند آماده است.', 'success'), 400);
setTimeout(() => addLog('آدرس جستجو کنید یا روی نقشه کلیک کنید.', 'info'), 900);
setTimeout(() => addLog('کلیدهای میانبر: ۱=دریافت | ۲=بافر | ۳=نزدیک | ۴=حرارتی | ۵=خروجی | Esc=پاک', 'info'), 1500);