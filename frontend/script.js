// ---- Configuration ----
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
const API_BASE = '/api';

// ---- Status Label Normalization (single language: Bahasa Indonesia, Title Case) ----
const STATUS_LABELS = {
    'pbreleased': 'Aman', 'release': 'Aman', 'aman': 'Aman', 'safe': 'Aman',
    'pbpressed': 'Bahaya', 'bahaya': 'Bahaya', 'danger': 'Bahaya',
    'hati-hati': 'Hati-hati', 'hati hati': 'Hati-hati', 'perhatian': 'Hati-hati', 'caution': 'Hati-hati', 'warning': 'Hati-hati'
};
const STATUS_CLASS = { 'Aman': 'status-aman', 'Hati-hati': 'status-hati-hati', 'Bahaya': 'status-bahaya' };
function formatStatusLabel(raw) {
    if (!raw) return '';
    const key = String(raw).trim().toLowerCase();
    return STATUS_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}
function statusClassFor(label) {
    return STATUS_CLASS[label] || '';
}

// ---- DAOP/DIVRE Grouping (derived from the JPL master's 'ba' business-area code) ----
const BA_DAOP_MAP = {
    'B010': 'DAOP 1', 'B020': 'DAOP 2', 'B030': 'DAOP 3', 'B040': 'DAOP 4', 'B050': 'DAOP 5',
    'B060': 'DAOP 6', 'B070': 'DAOP 7', 'B080': 'DAOP 8', 'B090': 'DAOP 9',
    'C010': 'DIVRE I', 'C020': 'DIVRE II', 'C031': 'DIVRE III', 'C032': 'DIVRE IV',
};
function getDAOPFromBA(ba) {
    if (!ba) return '-';
    return BA_DAOP_MAP[String(ba).trim().toUpperCase()] || '-';
}

// ---- Time Formatting (Indonesian format: DD/MM/YYYY HH:mm:ss) ----
function formatDateTime(isoString) {
    if (!isoString) return '-';
    try {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return isoString;
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
    } catch (e) {
        return isoString;
    }
}

// ---- Header Title Click: Reset Map View ----
const topBarTitle = document.getElementById('top-bar-title');
if (topBarTitle) {
    topBarTitle.addEventListener('click', () => {
        if (!sidebarContent.classList.contains('hidden')) {
            closeSidebarFn();
        }
        map.closePopup();
        map.fitBounds(JAVA_BOUNDS, { padding: [20, 20] });
    });
}

// ---- Popup "label: value" row layout (used by train & JPL popups) ----
// Rendered as a CSS table so the ':' column lines up across rows regardless of
// label length, instead of relying on manual space-padding (which HTML collapses).
function popupInfoRow(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="popup-info-row"><span class="popup-info-label">${label}</span><span class="popup-info-value">${value}</span></div>`;
}
function popupInfoTable(rows) {
    const html = rows.filter(Boolean).join('');
    return html ? `<div class="popup-info">${html}</div>` : '';
}

// ---- Map Setup ----
const map = L.map('map', {
    center: [-2.5, 118.0],
    zoom: 5,
    zoomControl: true,
    preferCanvas: true
});

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 16
}).addTo(map);

const jplRenderer = L.svg({ padding: 0.5 });

// ---- State ----
let trainMarkers = {};
let jplMarkers = {};
let jplData = {};
let trainData = {};
let ledStatus = {};
let jplRadiusLayers = {};
let jplPulseIntervals = {};
let jplRadiusPulseIntervals = {};
let activeAlerts = new Set();
let jplCaughtTrains = {}; // jplId -> array of vtdid caught by that JPL's active alert
let alertsToday = 0;
let healthStatus = {}; // jplId -> latest {deviceId, jplId, batteryPersentage, batteryCharging, powerType, datetime}
let lowBatteryAlerted = new Set(); // jplId currently showing a low-battery alert card
let staleSignalAlerted = new Set(); // jplId currently showing a signal-loss alert card
let jplPowerWarningState = {};
let jplPowerWarningTimeouts = {};
let previousPowerState = {}; // jplId -> previous power type (LINE/BATTERY)
const HEALTH_STALE_MS = 5 * 60 * 1000; // 5 minutes

function parseCharging(value) {
    if (value === null || value === undefined) return false;
    const v = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'charging'].includes(v);
}

function normalizeHealthPayload(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    const h = { ...raw };

    if (!h.jplId && h.funcloc) h.jplId = h.funcloc;
    if (!h.powerType && h.power) h.powerType = h.power;
    if (!h.power && h.powerType) h.power = h.powerType;

    if (h.batteryPersentage == null && h.batteryPercentage != null) {
        h.batteryPersentage = h.batteryPercentage;
    }
    if (h.batteryPercentage == null && h.batteryPersentage != null) {
        h.batteryPercentage = h.batteryPersentage;
    }

    if (h.batteryCharging != null) {
        h.batteryCharging = parseCharging(h.batteryCharging);
    }

    return h;
}

// Infinite Scroll State
let sortedJPLIDs = [];
let sortedTrainIDs = [];
let jplVisibleCount = 0;
let trainVisibleCount = 0;
let trainRowElements = {}; // vtdid -> currently-rendered <tr>, avoids a DOM query per train on every live update
let jplRowElements = {}; // jplId -> currently-rendered <tr>, same idea for the JPL table
let logOffset = 0;
let logsLoading = false;
let logsExhausted = false;
let currentView = 'jpl';
let isRenderingBatch = false;
let initialFocusDone = false;
let initialPBZoomDone = false; // only auto zoom-in once per page load, not on every WS reconnect

// ---- Sidebar Toggle ----
const hamburger = document.getElementById('hamburger');
const sidebarContent = document.getElementById('sidebar-content');
const closeSidebar = document.getElementById('close-sidebar');

function openSidebar() {
    sidebarContent.classList.remove('hidden');
    hamburger.style.display = 'none';
    setTimeout(() => map.invalidateSize(), 100);
}
function closeSidebarFn() {
    sidebarContent.classList.add('hidden');
    hamburger.style.display = 'flex';
    setTimeout(() => map.invalidateSize(), 100);
}
hamburger.addEventListener('click', openSidebar);
closeSidebar.addEventListener('click', closeSidebarFn);

// ---- Info / Legend Widget Toggle (panel pulls up out of the toggle box) ----
const infoWidget = document.getElementById('info-widget');
const infoToggle = document.getElementById('info-toggle');
const infoPanelClose = document.getElementById('info-panel-close');
infoToggle.addEventListener('click', () => infoWidget.classList.toggle('open'));
infoPanelClose.addEventListener('click', () => infoWidget.classList.remove('open'));

// ---- Resize Sidebar ----
const resizeHandle = document.createElement('div');
resizeHandle.className = 'resize-handle';
sidebarContent.appendChild(resizeHandle);
let isResizing = false, startX, startWidth;
resizeHandle.addEventListener('mousedown', function(e) {
    isResizing = true; startX = e.clientX; startWidth = sidebarContent.offsetWidth;
    resizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', function(e) {
    if (!isResizing) return;
    const newWidth = startWidth + (e.clientX - startX);
    if (newWidth >= 280 && newWidth <= 600) {
        sidebarContent.style.width = newWidth + 'px';
        map.invalidateSize();
    }
});
document.addEventListener('mouseup', function() {
    if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('resizing');
        document.body.style.cursor = ''; document.body.style.userSelect = '';
    }
});

// ---- Tab Switching ----
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = {
    jpl: document.getElementById('tab-jpl'),
    train: document.getElementById('tab-train'),
    log: document.getElementById('tab-log'),
    summary: document.getElementById('tab-summary')
};
const tabContent = document.getElementById('tab-content');

function switchToTab(tabName) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    currentView = tabName;
    Object.keys(tabPanes).forEach(key => tabPanes[key].classList.toggle('active', key === currentView));

    // Reset scroll position when switching tabs
    tabContent.scrollTop = 0;

    if (currentView === 'jpl') renderJPLTable(true);
    else if (currentView === 'train') renderTrainTable(true);
    else if (currentView === 'log') fetchLogs(true);
    else if (currentView === 'summary') fetchWeeklySummary();
}

tabBtns.forEach(btn => {
    btn.addEventListener('click', function() {
        switchToTab(this.dataset.tab);
    });
});

// ---- JPL Table: DAOP Filter ----
const jplDaopFilterEl = document.getElementById('jpl-daop-filter');
if (jplDaopFilterEl) {
    // Populate from BA_DAOP_MAP so the dropdown and the mapping stay single-sourced.
    [...new Set(Object.values(BA_DAOP_MAP))].forEach(daop => {
        const opt = document.createElement('option');
        opt.value = daop;
        opt.textContent = daop;
        jplDaopFilterEl.appendChild(opt);
    });
    jplDaopFilterEl.addEventListener('change', () => renderJPLTable(true));
}

// ---- Infinite Scroll Listener ----
tabContent.addEventListener('scroll', function() {
    const nearBottom = tabContent.scrollTop + tabContent.clientHeight >= tabContent.scrollHeight - 100;
    if (!nearBottom || isRenderingBatch) return;

    if (currentView === 'jpl') {
        if (jplVisibleCount < sortedJPLIDs.length) {
            isRenderingBatch = true;
            renderJPLTable(false);
            isRenderingBatch = false;
        }
    } else if (currentView === 'train') {
        if (trainVisibleCount < sortedTrainIDs.length) {
            isRenderingBatch = true;
            renderTrainTable(false);
            isRenderingBatch = false;
        }
    } else if (currentView === 'log') {
        if (!logsLoading && !logsExhausted) {
            fetchLogs(false);
        }
    }
});

// ---- Table Click Delegation ----
function setupTableDelegation() {
    document.querySelector('#jpl-table tbody').addEventListener('click', function(e) {
        const tr = e.target.closest('tr.data-row'); if (!tr) return;
        const jpl = jplData[tr.dataset.jpl];
        if (jpl && jpl.latitude != null && jpl.longitude != null) {
            map.setView([jpl.latitude, jpl.longitude], 14);
            if (jplMarkers[tr.dataset.jpl]) jplMarkers[tr.dataset.jpl].openPopup();
        }
    });
    document.querySelector('#train-table tbody').addEventListener('click', function(e) {
        const tr = e.target.closest('tr.data-row'); if (!tr) return;
        const marker = trainMarkers[tr.dataset.vtdid];
        if (marker) { map.setView(marker.getLatLng(), 14); marker.openPopup(); }
    });
    document.querySelector('#log-table tbody').addEventListener('click', function(e) {
        const tr = e.target.closest('tr.data-row'); if (!tr) return;
        const jpl = jplData[tr.dataset.funcloc];
        if (jpl && jpl.latitude != null && jpl.longitude != null) {
            map.setView([jpl.latitude, jpl.longitude], 14);
            if (jplMarkers[tr.dataset.funcloc]) jplMarkers[tr.dataset.funcloc].openPopup();
        }
    });
}
setupTableDelegation();

// ---- Top Bar: Backend Status + Live Stats ----
const backendStatusDot = document.getElementById('backend-status-dot');
const backendStatusText = document.getElementById('backend-status-text');
function setBackendStatus(online) {
    backendStatusDot.classList.toggle('status-online', online);
    backendStatusDot.classList.toggle('status-offline', !online);
    backendStatusText.textContent = online ? 'Online' : 'Offline';
}

function updateTopBarStats() {
    // Count unique JPLs currently marked active in the dashboard menu.
    // PBPRESSED adds the JPL and PBRELEASED removes it from activeAlerts.
    document.getElementById('stat-jpl-active').textContent = activeAlerts.size;

    const affectedTrains = new Set();
    Object.values(jplCaughtTrains).forEach(vtdids => vtdids.forEach(v => affectedTrains.add(v)));
    document.getElementById('stat-train-affected').textContent = affectedTrains.size;

    document.getElementById('stat-alerts-today').textContent = alertsToday;
}

// ---- Top bar stats link to Main Status (sidebar tabs) ----
// JPL Aktif / Kereta Terpengaruh: open the relevant tab and focus the map on the active PB zone.
// Alert Hari Ini: just open the Event Log tab (no map location tied to it).
document.querySelector('.stat-jpl').addEventListener('click', () => {
    openSidebar();
    switchToTab('jpl');
    zoomToActiveJPLs();
});
document.querySelector('.stat-train').addEventListener('click', () => {
    openSidebar();
    switchToTab('train');
    zoomToActiveJPLs();
});
document.querySelector('.stat-alert').addEventListener('click', () => {
    openSidebar();
    switchToTab('log');
});

// "Alert Hari Ini" is sourced from today's DB log. "JPL Aktif" intentionally uses
// the live activeAlerts set so it reflects PBPRESSED/PBRELEASED events while the
// dashboard is running.
function fetchTodayStats() {
    fetch(`${API_BASE}/stats/today`)
        .then(res => res.json())
        .then(data => {
            alertsToday = data.alerts_today || 0;
            updateTopBarStats();
        })
        .catch(err => console.warn('Failed to fetch today stats:', err));
}
fetchTodayStats();
setInterval(fetchTodayStats, 5 * 60 * 1000); // periodic resync so the daily reset (midnight) self-corrects without a page reload

// ---- WebSocket ----
let ws = null;
function connectWebSocket() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { console.log('WS connected'); setBackendStatus(true); };
    ws.onmessage = (event) => handleWebSocketMessage(JSON.parse(event.data));
    ws.onclose = () => { console.warn('WS closed, reconnecting...'); setBackendStatus(false); setTimeout(connectWebSocket, 3000); };
    ws.onerror = (err) => { console.error('WS error', err); setBackendStatus(false); ws.close(); };
}
connectWebSocket();

// ---- Initial Auto-Focus (show the whole Java island, where JPL + Locotrack activity is concentrated) ----
const JAVA_BOUNDS = L.latLngBounds([-8.8, 105.0], [-5.7, 114.6]);
function autoFocusOnDensity() {
    if (initialFocusDone) return;
    if (Object.keys(jplData).length === 0 && Object.keys(trainData).length === 0) return; // wait for data

    map.fitBounds(JAVA_BOUNDS, { padding: [20, 20] });
    initialFocusDone = true;
}

function handleWebSocketMessage(msg) {
    if (msg.type === 'jpl_list') {
        msg.data.forEach(jpl => addJPLMarker(jpl));
        // Set initial marker state (grey if no health)
        Object.keys(jplMarkers).forEach(id => setJPLState(id, 'release'));
        renderJPLTable(true);
        autoFocusOnDensity();

    } else if (msg.type === 'train_list' || msg.type === 'train_batch') {
        msg.data.forEach(train => {
            const nearestJPL = updateTrain(train);
            updateTrainTableRow(train.L_VTDID, nearestJPL);
        });
        if (msg.type === 'train_list' && Object.keys(trainData).length === msg.data.length) {
            renderTrainTable(true);
        }
        autoFocusOnDensity();

    } else if (msg.type === 'led_list') {
        // 🚀 FIX: Update background status ONLY, do NOT trigger popups for historical data
        msg.data.forEach(led => {
            ledStatus[led.vtdid] = led;
        });
        renderTrainTable(true);

    } else if (msg.type === 'train_update') {
        const nearestJPL = updateTrain(msg.data);
        updateTrainTableRow(msg.data.L_VTDID, nearestJPL);

    } else if (msg.type === 'led_update') {
        // 🚀 LIVE EVENT: Show popup ONLY when a new real-time message arrives
        ledStatus[msg.data.vtdid] = msg.data;
        updateTrainMarkerColor(msg.data.vtdid);
        updateTrainTableRow(msg.data.vtdid);
        addTrainLEDAlert(msg.data);

    } else if (msg.type === 'panic_alert') {
        // 🚀 LIVE EVENT: Show popup ONLY when a new panic button is pressed
        addJPLPanicAlert(msg.data);
        renderJPLTable(true);

    } else if (msg.type === 'panic_alerts') {
        // 🚀 FIX: Restore map marker state for active JPL alerts without spawning popups
        msg.data.forEach(alertData => {
            const event = alertData.event || alertData;
            if (event.jplId) {
                activeAlerts.add(event.jplId);
                jplCaughtTrains[event.jplId] = (alertData.caught_trains || []).map(c => c.vtdid);
                setJPLState(event.jplId, 'pbpressed');
            }
        });
        renderJPLTable(true);
        refreshTrainTableJPLColumn(); // reflect restored active JPLs in the distance-to-active-JPL column
        // train_list arrives BEFORE panic_alerts on initial connect, so trains rendered
        // earlier had no active JPLs to compare against yet — refresh their map tooltips/popups now.
        refreshAllTrainJPLTooltips();
        refreshAllTrainPopups();
        updateTopBarStats();

        // If the page just loaded (or reloaded) while a PB event was already active, zoom
        // in a bit so it's immediately visible — but only once, not on every WS reconnect.
        if (!initialPBZoomDone) {
            if (activeAlerts.size > 0) zoomToActiveJPLs();
            initialPBZoomDone = true;
        }

    } else if (msg.type === 'health_list') {
        // Restore known battery/power state without spawning alert cards for historical data.
        msg.data.forEach(h => {
            const normalized = normalizeHealthPayload(h);
            if (normalized.jplId) {
                healthStatus[normalized.jplId] = normalized;
                if (!healthStatus[normalized.jplId].__firstSeenAt) {
                    healthStatus[normalized.jplId].__firstSeenAt = Date.now();
                }
                if (jplData[normalized.jplId]) jplData[normalized.jplId].healthStatus = normalized;
            }
        });
        renderJPLTable(true);
        checkHealthStaleness();
        syncJPLHealthPopupState(true); // Pass true for initial load to show battery popups
        Object.keys(jplData).forEach(jplId => setJPLState(jplId, activeAlerts.has(jplId) ? 'pbpressed' : 'release'));

    } else if (msg.type === 'health_update') {
        // 🚀 LIVE EVENT: check low-battery condition and (re)spawn an alert card if needed.
        const h = normalizeHealthPayload(msg.data);
        if (h.jplId) {
            const isFirstReport = !healthStatus[h.jplId];
            healthStatus[h.jplId] = h;
            if (!healthStatus[h.jplId].__firstSeenAt) {
                healthStatus[h.jplId].__firstSeenAt = Date.now();
            }
            if (jplData[h.jplId]) jplData[h.jplId].healthStatus = h;
            if (isFirstReport && currentView === 'jpl') {
                // Move this JPL up into the "has battery data" tier now that it just reported for the first time.
                renderJPLTable(true);
            } else {
                updateJPLTableRow(h.jplId);
            }
            setJPLState(h.jplId, 'release');
            updateJPLPowerWarningBadge(h.jplId, isFirstReport); // Pass isFirstReport for first health message
            updateJPLPopupContent(h.jplId);
            checkLowBattery(h.jplId);
            checkHealthStaleness();
        }
    }
}

// ---- Train Map Markers ----
function getTrainIconSize() {
    return Math.max(16, Math.min(32, 8 + map.getZoom() * 2));
}
function getMapOverlayScale() {
    return Math.max(0.62, Math.min(1, 0.62 + (map.getZoom() - 5) * 0.042));
}
function updateMapOverlayScale() {
    // Keep fixed-screen labels visually proportional to the map markers while zooming.
    const scale = getMapOverlayScale();
    map.getContainer().style.setProperty('--map-overlay-scale', scale.toFixed(3));
}
function createTrainIcon(bodyColor, ringColor) {
    const w = getTrainIconSize();
    const h = Math.round(w * 1.333);
    
    // 🚀 FIX: Scale the popup anchor so it doesn't detach from the pin tip on zoom
    const scale = getMapOverlayScale();
    
    return L.divIcon({
        className: 'train-icon',
        html: `<div class="train-pin-wrap" style="width:${w}px;height:${h}px;"> <svg class="train-pin-svg" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"> <path d="M12 1C6.1 1 1.3 5.8 1.3 11.7c0 8.3 10.7 18.6 10.7 18.6s10.7-10.3 10.7-18.6C22.7 5.8 17.9 1 12 1z" fill="${bodyColor}" stroke="${ringColor}" stroke-width="2.5"/> </svg> <span class="train-pin-icon" style="font-size:${Math.round(w * 0.42)}px;">🚆</span> </div>`,
        iconSize: [w, h], 
        iconAnchor: [w / 2, h], 
        popupAnchor: [0, -(h * scale)] // Scaled to match visual height
    });
}
function trainColors(vtdid) {
    const info = getTrainStatusInfo(vtdid);
    return { body: 'rgb(255, 249, 179)', ring: info.ring };
}
function updateTrain(data) {
    const vtdid = data.L_VTDID;
    const lat = parseFloat(data.L_LAT);
    const lon = parseFloat(data.L_LON);
    if (isNaN(lat) || isNaN(lon)) return null;
    trainData[vtdid] = data;
    const c = trainColors(vtdid);
    // Computed once per update and reused for the popup + map tooltip + table row,
    // instead of recomputing the same haversine check 3x per train per tick.
    const nearestJPL = getNearestActiveJPL(lat, lon);
    let marker = trainMarkers[vtdid];
    if (marker) {
        marker.setLatLng([lat, lon]);
        if (marker.options._ring !== c.ring) {
            marker.setIcon(createTrainIcon(c.body, c.ring));
            marker.options._ring = c.ring;
        }
        marker.setPopupContent(createTrainPopup(data, ledStatus[vtdid] || {}, nearestJPL));
    } else {
        marker = L.marker([lat, lon], { icon: createTrainIcon(c.body, c.ring) }).addTo(map);
        marker.options._ring = c.ring;
        marker.bindPopup(createTrainPopup(data, ledStatus[vtdid] || {}, nearestJPL));
        marker.on('click', () => {
            map.setView(marker.getLatLng(), 14);
        });
        // The distance badge and the full status popup both sit above the icon, so only
        // one can be shown at a time: hide the badge while the popup is open, bring it
        // back once the popup closes (bound once here, not on every position update).
        marker.on('popupopen', () => { if (marker.getTooltip()) marker.closeTooltip(); });
        marker.on('popupclose', () => { if (marker.getTooltip()) marker.openTooltip(); });
        trainMarkers[vtdid] = marker;
    }
    updateTrainJPLTooltip(vtdid, nearestJPL);
    return nearestJPL;
}

// ---- Always-visible map label for trains within 5km of an active JPL (no click needed) ----
function updateTrainJPLTooltip(vtdid, nearestJPL) {
    const marker = trainMarkers[vtdid];
    if (!marker) return;
    if (nearestJPL === undefined) nearestJPL = getNearestActiveJPLForTrain(vtdid);
    if (nearestJPL) {
        const label = `⚠ ${nearestJPL.distanceKm.toFixed(2)} km`;
        const w = getTrainIconSize();
        const h = Math.round(w * 1.333);
        
        // 🚀 FIX: Calculate visual height using the map overlay scale
        const scale = getMapOverlayScale();
        const visualHeight = h * scale; 
        const offset = L.point(0, -(visualHeight + 2)); // Keep a 2px clearance above the visual icon
        
        if (marker.getTooltip()) {
            marker.setTooltipContent(label);
            marker.getTooltip().options.offset = offset;
            marker.getTooltip().update();
        } else {
            marker.bindTooltip(label, {
                permanent: true,
                direction: 'top',
                offset: offset,
                className: 'train-jpl-tooltip'
            });
            if (marker.isPopupOpen()) marker.closeTooltip();
        }
    } else if (marker.getTooltip()) {
        marker.unbindTooltip();
    }
}
function refreshAllTrainJPLTooltips() {
    // Must always run (even with 0 active alerts) so tooltips left over from a JPL that
    // just got released are actually unbound — each per-marker check below is cheap now.
    Object.keys(trainMarkers).forEach(vtdid => updateTrainJPLTooltip(vtdid));
}
// Popup content is otherwise only refreshed on a train's next position update (updateTrain),
// so without this, clicking a train right after a JPL becomes active/inactive could show
// stale popup content missing the warning line until the next position broadcast arrives.
function refreshAllTrainPopups() {
    Object.keys(trainMarkers).forEach(vtdid => {
        const marker = trainMarkers[vtdid];
        const data = trainData[vtdid];
        if (!marker || !data) return;
        const nearestJPL = getNearestActiveJPLForTrain(vtdid);
        marker.setPopupContent(createTrainPopup(data, ledStatus[vtdid] || {}, nearestJPL));
    });
}
function updateTrainMarkerColor(vtdid) {
    const data = trainData[vtdid]; if (!data) return;
    const c = trainColors(vtdid);
    const marker = trainMarkers[vtdid];
    if (marker && marker.options._ring !== c.ring) {
        marker.setIcon(createTrainIcon(c.body, c.ring));
        marker.options._ring = c.ring;
        marker.setPopupContent(createTrainPopup(data, ledStatus[vtdid] || {}, getNearestActiveJPLForTrain(vtdid)));
    }
}
function createTrainPopup(data, led, nearestJPL) {
    const info = getTrainStatusInfo(data.L_VTDID);
    const jplBlock = nearestJPL
        ? `<div class="train-popup-jpl"><b>⚠️ Peringatan: JPL Aktif ${nearestJPL.jplId}, jarak ${nearestJPL.distanceKm.toFixed(2)} km.</b></div>`
        : '';
    const table = popupInfoTable([
        popupInfoRow('Speed', `${data.L_SPEED} km/h`),
        popupInfoRow('Location', data.L_LOCATION || 'N/A'),
        popupInfoRow('Status', info.status),
    ]);
    return `<b>${data.L_VTDID}</b>${table}${jplBlock}`;
}

// ---- Distance-to-active-JPL helper (within 5km) ----
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function getNearestActiveJPL(lat, lon) {
    // Cheap early exit: this runs on every train position update (up to ~300/sec), and
    // there's almost never an active JPL — skip all parsing/math in the common case.
    if (activeAlerts.size === 0) return null;
    if (isNaN(lat) || isNaN(lon)) return null;

    let nearest = null;
    activeAlerts.forEach(jplId => {
        const jpl = jplData[jplId];
        if (!jpl || jpl.latitude == null || jpl.longitude == null) return;
        const distanceKm = haversineKm(lat, lon, jpl.latitude, jpl.longitude);
        if (distanceKm <= 5 && (!nearest || distanceKm < nearest.distanceKm)) {
            nearest = { jplId, distanceKm };
        }
    });
    return nearest;
}
// Convenience wrapper for call sites that only have a vtdid on hand (table render,
// tooltip bulk-refresh) instead of a fresh position payload.
function getNearestActiveJPLForTrain(vtdid) {
    if (activeAlerts.size === 0) return null;
    const train = trainData[vtdid];
    if (!train) return null;
    return getNearestActiveJPL(parseFloat(train.L_LAT), parseFloat(train.L_LON));
}
function updateTrainScale() {
    updateMapOverlayScale();
    Object.keys(trainMarkers).forEach(vtdid => {
        const marker = trainMarkers[vtdid];
        const c = trainColors(vtdid);
        marker.setIcon(createTrainIcon(c.body, c.ring));
        updateTrainJPLTooltip(vtdid);
    });
    
    // 🚀 FIX: Recalculate JPL tooltip offsets on zoom using visual scale
    Object.keys(jplPowerWarningState).forEach(jplId => {
        const marker = jplMarkers[jplId];
        if (!marker || !marker.getTooltip()) return;
        const scale = getMapOverlayScale();
        const visualHeight = 12 * scale;
        marker.getTooltip().options.offset = L.point(0, -(visualHeight + 2));
        marker.getTooltip().update();
    });
}
map.on('zoomend', updateTrainScale);
updateTrainScale();

// ---- JPL Map Markers ----
function updateJPLPopupContent(jplId) {
    const marker = jplMarkers[jplId];
    if (!marker) return;
    const jpl = jplData[jplId] || {};
    const health = healthStatus[jplId] || null;
    const statusText = activeAlerts.has(jplId)
        ? 'Bahaya'
        : (health && health.status ? String(health.status) : 'Aman');

    const header = [
        `<b>${jplId}</b>`,
        jpl.descript ? `${jpl.descript}` : '',
    ].filter(Boolean).join('<br>');

    const rows = [
        popupInfoRow('BA', jpl.ba),
        popupInfoRow('Status', statusText),
    ];

    if (health) {
        const power = health.powerType || health.power || 'N/A';
        if (power && power !== 'N/A') rows.push(popupInfoRow('Power', `<b>${power}</b>`));
        if (health.batteryVoltage != null) rows.push(popupInfoRow('Battery Voltage', `${health.batteryVoltage} V`));
        if (health.batteryPersentage != null) rows.push(popupInfoRow('Battery', `<b>${health.batteryPersentage}%</b>`));
        if (health.batteryCharging != null) rows.push(popupInfoRow('Battery Charging', `<b>${parseCharging(health.batteryCharging) ? 'Ya' : 'Tidak'}</b>`));
        if (health.gsmNumber) rows.push(popupInfoRow('GSM', health.gsmNumber));
        if (health.signalStrength) rows.push(popupInfoRow('Signal', health.signalStrength));
        if (health.datetime) rows.push(popupInfoRow('Last Update', formatDateTime(health.datetime)));
    }

    marker.setPopupContent(`${header}${popupInfoTable(rows)}`);
}

function syncJPLHealthPopupState(isFirstLoad = false) {
    Object.keys(jplData).forEach(jplId => updateJPLPopupContent(jplId));
    Object.keys(healthStatus).forEach(jplId => updateJPLPowerWarningBadge(jplId, isFirstLoad));
}

function addJPLMarker(jpl) {
    const id = jpl.function_loc;
    if (!id || jplMarkers[id]) return;
    const lat = jpl.latitude, lon = jpl.longitude;
    if (lat == null || lon == null) return;
    jplData[id] = jpl;
    const marker = L.circleMarker([lat, lon], {
        renderer: jplRenderer, radius: 6, fillColor: '#0a84ff', color: '#fff', weight: 2, opacity: 1, fillOpacity: 0.8
    }).addTo(map);
    const initialHeader = [`<b>${id}</b>`, jpl.descript || ''].filter(Boolean).join('<br>');
    const initialTable = popupInfoTable([
        popupInfoRow('BA', jpl.ba),
        popupInfoRow('Status', formatStatusLabel('release')),
    ]);
    marker.bindPopup(`${initialHeader}${initialTable}`, { autoPan: false });
    marker.on('click', () => {
        map.setView([lat, lon], 14);
        updateJPLPopupContent(id);
    });
    jplMarkers[id] = marker;
    setJPLState(id, 'release');
    updateJPLPopupContent(id);
    updateJPLPowerWarningBadge(id);
}

function updateJPLPowerWarningBadge(jplId, isFirstLoad = false) {
    const marker = jplMarkers[jplId];
    if (!marker) return;
    const health = healthStatus[jplId];
    const power = health ? String(health.powerType || health.power || '').toUpperCase() : '';
    const isBackup = power === 'BATTERY';
    
    // 🚀 FIX: Scale the base diameter (12px) to match the visual zoom scale
    const scale = getMapOverlayScale();
    const visualHeight = 12 * scale; 
    const offset = L.point(0, -(visualHeight + 2));

    // Track power state changes
    const prevPower = previousPowerState[jplId];
    const isFirstLoadState = prevPower === undefined;
    const isLineToBattery = prevPower === 'LINE' && power === 'BATTERY';
    
    // Check low battery condition: BATTERY, below 20%, not charging
    const pct = health ? (health.batteryPercentage || health.batteryPersentage) : null;
    const charging = health ? parseCharging(health.batteryCharging) : false;
    const isLowBattery = pct != null && parseFloat(pct) < 20 && !charging && power === 'BATTERY';

    if (isBackup) {
        // Show popup on: LINE → BATTERY change, initial load, or low battery condition
        // isFirstLoadState handles the case where this is the first health message ever for this JPL
        if (!jplPowerWarningState[jplId] && (isLineToBattery || isFirstLoad || isFirstLoadState || isLowBattery)) {
            marker.bindTooltip('⚠️ Backup power: BATTERY', {
                permanent: true,
                direction: 'top',
                offset: offset,
                className: 'jpl-power-tooltip'
            });
            jplPowerWarningState[jplId] = true;

            clearTimeout(jplPowerWarningTimeouts[jplId]);
            jplPowerWarningTimeouts[jplId] = setTimeout(() => {
                if (jplPowerWarningState[jplId]) {
                    marker.unbindTooltip();
                    jplPowerWarningState[jplId] = false;
                }
                delete jplPowerWarningTimeouts[jplId];
            }, HEALTH_ALERT_AUTO_DISMISS_MS);
        } else if (jplPowerWarningState[jplId]) {
            marker.setTooltipContent('⚠️ Backup power: BATTERY');
            marker.getTooltip().options.offset = offset;
            marker.getTooltip().update();
        }
    } else {
        // Hide popup if not on BATTERY
        if (jplPowerWarningState[jplId]) {
            marker.unbindTooltip();
            jplPowerWarningState[jplId] = false;
            clearTimeout(jplPowerWarningTimeouts[jplId]);
            delete jplPowerWarningTimeouts[jplId];
        }
    }

    // Update previous power state only if it was undefined (first time) or if power actually changed
    // This preserves isFirstLoadState for the first real health message after initial load
    if (prevPower === undefined || prevPower !== power) {
        previousPowerState[jplId] = power;
    }
}

function startPulse(jplId) {
    const marker = jplMarkers[jplId]; if (!marker) return;
    if (jplPulseIntervals[jplId]) clearInterval(jplPulseIntervals[jplId]);
    let growing = true;
    jplPulseIntervals[jplId] = setInterval(() => {
        let r = marker.getRadius();
        if (growing) { r += 1; if (r >= 12) growing = false; } else { r -= 1; if (r <= 8) growing = true; }
        marker.setRadius(r);
    }, 200);
}
// ---- JPL Color State Helpers ----
function isJPLStale(jplId) {
    const h = healthStatus[jplId];
    if (!h) return false;
    const firstSeenAt = h.__firstSeenAt || (h.datetime ? new Date(h.datetime).getTime() : NaN);
    return !isNaN(firstSeenAt) && (Date.now() - firstSeenAt) > HEALTH_STALE_MS;
}

function getJPLFillColor(jplId) {
    if (activeAlerts.has(jplId)) return '#ff453a'; // 1. Panic (Red)
    const h = healthStatus[jplId];
    if (!h) return '#8a8f98'; // 2. No health data ever (Grey)
    
    const firstSeenAt = h.__firstSeenAt || (h.datetime ? new Date(h.datetime).getTime() : NaN);
    const isStale = !isNaN(firstSeenAt) && (Date.now() - firstSeenAt) > HEALTH_STALE_MS;
    if (isStale) return '#ffd60a'; // 3. Stale / Offline (Yellow)
    
    const pct = Number(h.batteryPersentage);
    const charging = parseCharging(h.batteryCharging);
    const powerType = String(h.powerType || h.power || '').toUpperCase();
    
    // 4. Low Battery Warning (Orange) - ONLY if not on LINE power
    const isLowBattery = pct < 20 && !charging && powerType !== 'LINE';
    if (isLowBattery) return '#ff9f0a'; 
    
    return '#0a84ff'; // 5. Healthy / Normal (Blue)
}

function updateJPLMarkerColor(jplId) {
    const marker = jplMarkers[jplId];
    if (!marker || activeAlerts.has(jplId)) return; // Don't override panic red
    
    const fillColor = getJPLFillColor(jplId);
    const isGray = fillColor === '#8a8f98';
    
    marker.setStyle({
        fillColor: fillColor,
        color: isGray ? '#dfe3e8' : '#fff',
        fillOpacity: isGray ? 0.7 : 0.8,
        opacity: 1,
        weight: 2
    });
}

// ---- JPL Pulse & Radius Functions (Syntax Errors Fixed) ----
function startPulse(jplId) {
    const marker = jplMarkers[jplId]; if (!marker) return;
    if (jplPulseIntervals[jplId]) clearInterval(jplPulseIntervals[jplId]);
    let growing = true;
    jplPulseIntervals[jplId] = setInterval(() => {
        let r = marker.getRadius();
        if (growing) { r += 1; if (r >= 12) growing = false; } else { r -= 1; if (r <= 8) growing = true; }
        marker.setRadius(r);
    }, 200);
}

function stopPulse(jplId) {
    if (jplPulseIntervals[jplId]) { clearInterval(jplPulseIntervals[jplId]); delete jplPulseIntervals[jplId]; }
    const marker = jplMarkers[jplId];
    if (marker) {
        marker.setRadius(6);
        // 🚀 Uses dynamic 5-tier color logic
        const fillColor = getJPLFillColor(jplId);
        const isGray = fillColor === '#8a8f98';
        marker.setStyle({
            fillColor: fillColor,
            color: isGray ? '#dfe3e8' : '#fff',
            fillOpacity: isGray ? 0.7 : 0.8,
            opacity: 1,
            weight: 2
        });
    }
}

function startRadiusPulse(jplId) {
    const layers = jplRadiusLayers[jplId]; if (!layers) return;
    stopRadiusPulse(jplId);
    const [red, yellow] = layers;
    let t = 0, growing = true;
    jplRadiusPulseIntervals[jplId] = setInterval(() => {
        t += growing ? 0.12 : -0.12;
        if (t >= 1) { t = 1; growing = false; }
        if (t <= 0) { t = 0; growing = true; }
        red.setStyle({ fillOpacity: 0.12 + t * 0.35, opacity: 0.45 + t * 0.5, weight: 2 + t * 2 });
        yellow.setStyle({ fillOpacity: 0.06 + t * 0.28, opacity: 0.35 + t * 0.45, weight: 2 + t * 1.5 });
    }, 150);
}

function stopRadiusPulse(jplId) {
    if (jplRadiusPulseIntervals[jplId]) { clearInterval(jplRadiusPulseIntervals[jplId]); delete jplRadiusPulseIntervals[jplId]; }
}

function updateRadiusCircles(jplId, state) {
    if (jplRadiusLayers[jplId]) {
        jplRadiusLayers[jplId].forEach(layer => map.removeLayer(layer));
        delete jplRadiusLayers[jplId];
    }
    stopRadiusPulse(jplId);
    if (state !== 'pbpressed') return;
    const jpl = jplData[jplId]; if (!jpl) return;
    const lat = jpl.latitude, lon = jpl.longitude;
    if (lat == null || lon == null) return;
    const red = L.circle([lat, lon], { renderer: jplRenderer, radius: 1100, color: '#ff453a', fillColor: '#ff453a', fillOpacity: 0.15, weight: 2, opacity: 0.6, interactive: false }).addTo(map);
    const yellow = L.circle([lat, lon], { renderer: jplRenderer, radius: 3000, color: '#ff9f0a', fillColor: '#ff9f0a', fillOpacity: 0.1, weight: 2, opacity: 0.5, interactive: false }).addTo(map);
    jplRadiusLayers[jplId] = [red, yellow];
    startRadiusPulse(jplId);
}

function setJPLState(jplId, state) {
    const marker = jplMarkers[jplId]; if (!marker) return;
    if (!healthStatus[jplId] && !activeAlerts.has(jplId)) {
        stopPulse(jplId); // Will automatically set to grey via getJPLFillColor
        updateRadiusCircles(jplId, 'release');
        updateJPLPopupContent(jplId);
        return;
    }
    if (state === 'pbpressed') {
        marker.setStyle({ fillColor: '#ff453a' });
        startPulse(jplId);
    } else {
        stopPulse(jplId); // Will automatically set to blue, yellow, or orange
    }
    updateRadiusCircles(jplId, state);
    updateJPLPopupContent(jplId);
}

// ---- Zoom to show currently-active JPL(s) — fits all of them when 2+ are active at once ----
function zoomToActiveJPLs(justPressedId) {
    const activeIds = Array.from(activeAlerts).filter(id => jplData[id] && jplData[id].latitude != null && jplData[id].longitude != null);
    if (activeIds.length === 0) return;

    if (activeIds.length === 1) {
        const id = activeIds[0];
        const jpl = jplData[id];
        const radiusLayers = jplRadiusLayers[id];
        const warningCircle = radiusLayers && radiusLayers[1]; // yellow, 3000m — wider than the red danger circle
        if (warningCircle) {
            map.fitBounds(warningCircle.getBounds(), { maxZoom: 13, padding: [40, 40] });
        } else {
            map.setView([jpl.latitude, jpl.longitude], 13);
        }
    } else {
        // Multiple JPLs active at once: fit bounds to show all of them together.
        const bounds = L.latLngBounds(activeIds.map(id => [jplData[id].latitude, jplData[id].longitude]));
        map.fitBounds(bounds, { maxZoom: 13, padding: [60, 60] });
    }

    if (justPressedId && jplMarkers[justPressedId]) jplMarkers[justPressedId].openPopup();
}

// ---- Clear/Release JPL Alert Helper ----
function clearAlertForJPL(jplId) {
    activeAlerts.delete(jplId);
    delete jplCaughtTrains[jplId];

    // Remove JPL alert popups from alert stack
    const jplPopups = document.querySelectorAll(`.alert-item[data-jpl="${jplId}"]`);
    jplPopups.forEach(item => item.remove());

    // Reset map marker color, stop pulse, and clear radius circles
    setJPLState(jplId, 'release');
    renderJPLTable(true);
    refreshTrainTableJPLColumn(); // refresh distance-to-active-JPL info on trains
    refreshAllTrainJPLTooltips(); // remove/update map-label distances now that this JPL is inactive
    refreshAllTrainPopups(); // so a train's popup doesn't keep showing a stale warning after release
    updateTopBarStats();
    fetchTodayStats(); // resync "JPL Aktif" from the DB log
}

const RELEASE_EVENT_TYPES = new Set(['RELEASE', 'PBRELEASE', 'PBRELEASED', 'AMAN', 'SAFE']);

function addJPLPanicAlert(alertData) {
    const event = alertData.event || alertData;
    const jplId = event.jplId;
    const eventType = String(event.eventType || '').toUpperCase();

    // The live device feed isn't a strict PBPRESSED/PBRELEASED binary — it also sends
    // 'release'/'bahaya'/'perhatian' (Indonesian) — so match by name, not one exact string.
    if (RELEASE_EVENT_TYPES.has(eventType)) {
        clearAlertForJPL(jplId);
        return;
    }

    activeAlerts.add(jplId);
    jplCaughtTrains[jplId] = (alertData.caught_trains || []).map(c => c.vtdid);
    alertsToday++;
    updateTopBarStats();
    fetchTodayStats(); // resync "JPL Aktif" from the DB log
    refreshTrainTableJPLColumn(); // refresh distance-to-active-JPL info on trains
    refreshAllTrainJPLTooltips(); // show map-label distances for trains now near this JPL
    refreshAllTrainPopups(); // so clicking a train right after this event shows the warning immediately
    const jpl = jplData[jplId];

    const existing = document.querySelectorAll(`.alert-item[data-jpl="${jplId}"]`);
    existing.forEach(item => item.remove());

    const alertItem = document.createElement('div');
    alertItem.className = 'alert-item alert-jpl';
    alertItem.dataset.jpl = jplId;
    alertItem.style.cursor = 'pointer';
    // 🚀 Changed border from red (#ff453a) to orange (#ff9f0a)
    alertItem.style.borderLeft = '5px solid #ff9f0a'; 

    alertItem.innerHTML = `
        <div class="alert-header">
            <!-- 🚀 Changed text color to orange (#ff9f0a) -->
            <span style="color:#ff9f0a; font-weight:bold;">🚨 PANIC BUTTON: ${jplId}</span>
            <button class="alert-close" data-jpl="${jplId}">&times;</button>
        </div>
        <div class="alert-body">
            ${popupInfoTable([
                popupInfoRow('Status', formatStatusLabel(event.eventType || 'pbpressed')),
                popupInfoRow('Time', formatDateTime(event.datetime) || new Date().toLocaleTimeString()),
            ])}
            <div>${jpl ? jpl.descript : ''}</div>
        </div>`;

    alertItem.addEventListener('click', function(e) {
        if (e.target.closest('.alert-close')) return;
        if (jpl && jpl.latitude != null && jpl.longitude != null) {
            map.setView([jpl.latitude, jpl.longitude], 14);
            if (jplMarkers[jplId]) jplMarkers[jplId].openPopup();
        }
    });

    alertItem.querySelector('.alert-close').addEventListener('click', function(e) {
        e.stopPropagation();
        // Closing the notification only dismisses the card — it must NOT clear the
        // PB event state (marker/pulse/danger radius). That only ends on a real
        // PBRELEASED event from the backend, handled above via clearAlertForJPL().
        dismissAlertNotification(jplId);
    });

    document.getElementById('alert-stack').appendChild(alertItem);
    setJPLState(jplId, 'pbpressed');
    zoomToActiveJPLs(jplId);
}

// ---- Dismiss a notification card only, without touching the underlying PB alert state ----
function dismissAlertNotification(jplId) {
    const jplPopups = document.querySelectorAll(`.alert-item[data-jpl="${jplId}"]`);
    jplPopups.forEach(item => item.remove());
}

// ---- 3. Train LED Alert Popup (Yellow / Red according to VTDID) ----
function addTrainLEDAlert(led) {
    const vtdid = led.vtdid || led.L_VTDID;
    if (!vtdid) return;

    // Strict string/number check
    const isRed = String(led.ledMerah) === '1';
    const isYellow = String(led.ledKuning) === '1';

    // If both LEDs are 0, train is safe — clear any active popup for this train
    if (!isRed && !isYellow) {
        const existing = document.querySelectorAll(`.alert-item[data-vtdid="${vtdid}"]`);
        existing.forEach(item => item.remove());
        return;
    }

    const train = trainData[vtdid] || {};
    const statusText = isRed ? 'BAHAYA' : 'HATI-HATI';
    const accentColor = isRed ? '#ff453a' : '#ffd60a';
    const bgBadgeColor = isRed ? 'rgba(255, 69, 58, 0.2)' : 'rgba(255, 214, 10, 0.2)';

    const alertItem = document.createElement('div');
    alertItem.className = 'alert-item alert-train';
    alertItem.dataset.vtdid = vtdid;
    alertItem.style.cursor = 'pointer';
    alertItem.style.borderLeft = `5px solid ${accentColor}`;

    alertItem.innerHTML = `
        <div class="alert-header">
            <span style="color:${accentColor}; font-weight:bold;">
                🚆 TRAIN WARNING: ${vtdid}
            </span>
            <button class="alert-close" data-vtdid="${vtdid}">&times;</button>
        </div>
        <div class="alert-body">
            <div style="margin-bottom:6px;">
                <span style="background:${bgBadgeColor}; color:${accentColor}; padding:2px 8px; border-radius:4px; font-weight:bold; font-size:11px; text-transform:uppercase;">
                    ${statusText}
                </span>
            </div>
            ${popupInfoTable([
                popupInfoRow('Speed', `${train.L_SPEED || '0'} km/h`),
                popupInfoRow('Location', train.L_LOCATION || [train.L_KECAMATAN, train.L_KABUPATEN].filter(Boolean).join(', ') || 'N/A'),
            ])}
        </div>`;

    // Click popup to focus map on Train
    alertItem.addEventListener('click', function(e) {
        if (e.target.closest('.alert-close')) return;
        const marker = trainMarkers[vtdid];
        if (marker) {
            map.setView(marker.getLatLng(), 14);
            marker.openPopup();
        }
    });

    alertItem.querySelector('.alert-close').addEventListener('click', function(e) {
        e.stopPropagation();
        alertItem.remove();
    });

    document.getElementById('alert-stack').appendChild(alertItem);
}

// ---- 4. Health / Battery Alerts (low battery, signal loss) ----
function focusJPL(jplId) {
    const jpl = jplData[jplId];
    if (jpl && jpl.latitude != null && jpl.longitude != null) {
        map.setView([jpl.latitude, jpl.longitude], 14);
        if (jplMarkers[jplId]) jplMarkers[jplId].openPopup();
    }
}
function removeAlertCardsBy(attr, value) {
    document.querySelectorAll(`.alert-item[${attr}="${value}"]`).forEach(item => item.remove());
}

function checkLowBattery(jplId) {
    const h = healthStatus[jplId];
    if (!h || h.batteryPersentage == null) return;
    const pct = Number(h.batteryPersentage);
    const charging = parseCharging(h.batteryCharging);
    const powerType = String(h.powerType || h.power || '').toUpperCase();
    
    // 🚀 Only trigger if running on battery power. If on LINE, it's just maintenance.
    const isLow = pct < 20 && !charging && powerType !== 'LINE';
    
    if (isLow && !lowBatteryAlerted.has(jplId)) {
        lowBatteryAlerted.add(jplId);
        addLowBatteryAlert(jplId, h);
        updateJPLMarkerColor(jplId); // 🚀 Paint Orange immediately
    } else if (!isLow && lowBatteryAlerted.has(jplId)) {
        lowBatteryAlerted.delete(jplId);
        removeAlertCardsBy('data-health-jpl', jplId);
        updateJPLMarkerColor(jplId); // 🚀 Paint Blue when recovered
    }
}
// Health-related notification cards (low battery, inactive signal) auto-dismiss after
// this long — the underlying condition keeps showing on the JPL marker/table/popup via
// healthStatus regardless, this only limits how long the toast itself stays on screen.
const HEALTH_ALERT_AUTO_DISMISS_MS = 10 * 1000;

function addLowBatteryAlert(jplId, health) {
    const jpl = jplData[jplId] || {};
    removeAlertCardsBy('data-health-jpl', jplId);

    const alertItem = document.createElement('div');
    alertItem.className = 'alert-item alert-battery';
    alertItem.dataset.healthJpl = jplId;
    alertItem.style.cursor = 'pointer';
    alertItem.style.borderLeft = '5px solid #ff453a';

    alertItem.innerHTML = `
        <div class="alert-header">
            <span style="color:#ff453a; font-weight:bold;">🔋 WARNING LOW BATTERY: ${jplId}</span>
            <button class="alert-close" data-health-jpl="${jplId}">&times;</button>
        </div>
        <div class="alert-body">
            ${popupInfoTable([
                popupInfoRow('Battery', `${health.batteryPersentage}% (tidak di-cas)`),
            ])}
            <div>${jpl.descript || ''}</div>
        </div>`;

    alertItem.addEventListener('click', function(e) {
        if (e.target.closest('.alert-close')) return;
        focusJPL(jplId);
    });
    alertItem.querySelector('.alert-close').addEventListener('click', function(e) {
        e.stopPropagation();
        alertItem.remove();
    });

    document.getElementById('alert-stack').appendChild(alertItem);
    setTimeout(() => alertItem.remove(), HEALTH_ALERT_AUTO_DISMISS_MS);
}

// Runs periodically (not just on message arrival) since staleness is about the ABSENCE
// of updates — a JPL that simply stops sending health data needs to be caught by polling.
function checkHealthStaleness() {
    const now = Date.now();
    Object.keys(healthStatus).forEach(jplId => {
        const h = healthStatus[jplId];
        const firstSeenAt = h.__firstSeenAt || (h.datetime ? new Date(h.datetime).getTime() : NaN);
        const isStale = !isNaN(firstSeenAt) && (now - firstSeenAt) > HEALTH_STALE_MS;
        
        if (isStale && !staleSignalAlerted.has(jplId)) {
            staleSignalAlerted.add(jplId);
            addInactivePanicButtonAlert(jplId, h);
            updateJPLMarkerColor(jplId); // 🚀 Paint Yellow
        } else if (!isStale && staleSignalAlerted.has(jplId)) {
            staleSignalAlerted.delete(jplId);
            removeAlertCardsBy('data-stale-jpl', jplId);
            updateJPLMarkerColor(jplId); // 🚀 Paint Blue (Recovered)
        }
    });
}
setInterval(checkHealthStaleness, 30 * 1000);

function addInactivePanicButtonAlert(jplId, health) {
    const jpl = jplData[jplId] || {};
    removeAlertCardsBy('data-stale-jpl', jplId);

    const alertItem = document.createElement('div');
    alertItem.className = 'alert-item alert-stale';
    alertItem.dataset.staleJpl = jplId;
    alertItem.style.cursor = 'pointer';
    alertItem.style.borderLeft = '5px solid #ffd60a';

    alertItem.innerHTML = `
        <div class="alert-header">
            <span style="color:#ffd60a; font-weight:bold;">📵 PANIC BUTTON INACTIVE: ${jplId}</span>
            <button class="alert-close" data-stale-jpl="${jplId}">&times;</button>
        </div>
        <div class="alert-body">
            <div>JPL tidak menerima sinyal healthStatus selama lebih dari 5 menit.</div>
            <div>${jpl.descript || ''}</div>
            ${popupInfoTable([
                health && health.power ? popupInfoRow('Power', health.power) : '',
            ])}
        </div>`;

    alertItem.addEventListener('click', function(e) {
        if (e.target.closest('.alert-close')) return;
        focusJPL(jplId);
    });
    alertItem.querySelector('.alert-close').addEventListener('click', function(e) {
        e.stopPropagation();
        alertItem.remove();
    });

    document.getElementById('alert-stack').appendChild(alertItem);
    setTimeout(() => alertItem.remove(), HEALTH_ALERT_AUTO_DISMISS_MS);
}


// ==========================================
// INFINITE SCROLL TABLE RENDERING
// ==========================================

// --- JPL Table ---
function formatPowerType(raw) {
    if (raw === 'LINE') return 'PLN';
    if (raw === 'BATTERY') return 'Baterai';
    return raw || '-';
}
function renderJPLTable(reset = false) {
    const tbody = document.querySelector('#jpl-table tbody'); if (!tbody) return;
    if (reset) {
        jplVisibleCount = 0;
        const daopFilter = jplDaopFilterEl ? jplDaopFilterEl.value : '';
        sortedJPLIDs = Object.keys(jplData)
            .filter(id => !daopFilter || getDAOPFromBA(jplData[id].ba) === daopFilter)
            .sort((a, b) => {
            // Primary sort: Active PB alerts first, then JPLs with health status, then no health data
            const rankA = activeAlerts.has(a) ? 0 : (healthStatus[a] ? 1 : 2);
            const rankB = activeAlerts.has(b) ? 0 : (healthStatus[b] ? 1 : 2);
            if (rankA !== rankB) return rankA - rankB;

            // Secondary sort: Power type (Battery/Baterai before Line)
            const powerA = healthStatus[a] ? String(healthStatus[a].powerType || healthStatus[a].power || '').toUpperCase() : '';
            const powerB = healthStatus[b] ? String(healthStatus[b].powerType || healthStatus[b].power || '').toUpperCase() : '';
            const powerRankA = powerA === 'BATTERY' ? 0 : (powerA === 'LINE' ? 1 : 2);
            const powerRankB = powerB === 'BATTERY' ? 0 : (powerB === 'LINE' ? 1 : 2);
            if (powerRankA !== powerRankB) return powerRankA - powerRankB;

            // Tertiary sort: Battery percentage (low battery < 20% before higher battery)
            const battA = healthStatus[a] ? (healthStatus[a].batteryPercentage || healthStatus[a].batteryPersentage) : null;
            const battB = healthStatus[b] ? (healthStatus[b].batteryPercentage || healthStatus[b].batteryPersentage) : null;
            const isLowA = battA != null && parseFloat(battA) < 20;
            const isLowB = battB != null && parseFloat(battB) < 20;
            if (isLowA !== isLowB) return isLowA ? -1 : 1;

            // Final sort: Battery percentage ascending (lower battery first)
            if (battA != null && battB != null) return parseFloat(battA) - parseFloat(battB);
            if (battA != null) return -1;
            if (battB != null) return 1;

            return 0;
        });
        tbody.innerHTML = '';
        jplRowElements = {};
    }

    const nextBatchIDs = sortedJPLIDs.slice(jplVisibleCount, jplVisibleCount + 50);
    if (nextBatchIDs.length === 0) return;

    const html = nextBatchIDs.map(id => {
        const jpl = jplData[id] || {};
        const status = formatStatusLabel(activeAlerts.has(id) ? 'pbpressed' : 'release');
        const statusClass = statusClassFor(status);
        const health = healthStatus[id];
        const power = health ? formatPowerType(health.powerType) : '-';
        const batteryPct = health && health.batteryPersentage != null ? health.batteryPersentage : null;
        const batteryClass = batteryPct != null && batteryPct < 20 ? 'battery-low' : '';
        const batteryText = batteryPct != null ? `${batteryPct}%` : '-';
        // New fields
        const voltage = health?.batteryVoltage != null ? health.batteryVoltage + ' V' : '-';
        const charging = health?.batteryCharging != null ? (parseCharging(health.batteryCharging) ? 'Ya' : 'Tidak') : '-';
        const signal = health?.signalStrength || '-';
        const lastUpdate = formatDateTime(health?.datetime) || '-';
        return `
            <tr class="data-row ${statusClass}" data-jpl="${id}">
                <td class="${statusClass}">${status}</td>
                <td>${id}</td>
                <td>${jpl.ba || ''}</td>
                <td>${getDAOPFromBA(jpl.ba)}</td>
                <td>${jpl.descript || ''}</td>
                <td>${power}</td>
                <td class="${batteryClass}">${batteryText}</td>
                <td>${voltage}</td>
                <td>${charging}</td>
                <td>${signal}</td>
                <td>${lastUpdate}</td>
            </tr>`;
    }).join('');

    tbody.insertAdjacentHTML('beforeend', html);
    jplVisibleCount += nextBatchIDs.length;
    nextBatchIDs.forEach(id => {
        jplRowElements[id] = tbody.querySelector(`tr[data-jpl="${id}"]`);
    });
}
// Live update for a single JPL row's Power/Battery cells (cached — no DOM query, no full re-render).
function updateJPLTableRow(jplId) {
    const tr = jplRowElements[jplId];
    if (!tr) return;
    const health = healthStatus[jplId];
    const power = health ? formatPowerType(health.powerType) : '-';
    const batteryPct = health && health.batteryPersentage != null ? health.batteryPersentage : null;
    const cells = tr.children;
    cells[5].textContent = power;
    cells[6].textContent = batteryPct != null ? `${batteryPct}%` : '-';
    cells[6].className = batteryPct != null && batteryPct < 20 ? 'battery-low' : '';
    // New fields
    cells[7].textContent = health?.batteryVoltage != null ? health.batteryVoltage + ' V' : '-';
    cells[8].textContent = health?.batteryCharging != null ? (parseCharging(health.batteryCharging) ? 'Ya' : 'Tidak') : '-';
    cells[9].textContent = health?.signalStrength || '-';
    cells[10].textContent = formatDateTime(health?.datetime) || '-';
}

// --- Train Table ---
function renderTrainTable(reset = false) {
    const tbody = document.querySelector('#train-table tbody'); if (!tbody) return;
    if (reset) {
        trainVisibleCount = 0;
        const order = { 'Bahaya': 0, 'Hati-hati': 1, 'Aman': 2 };
        sortedTrainIDs = Object.keys(trainData).sort((a, b) => {
            const ledA = ledStatus[a] || {};
            const ledB = ledStatus[b] || {};
            const statusA = ledA.ledMerah === '1' ? 'Bahaya' : (ledA.ledKuning === '1' ? 'Hati-hati' : 'Aman');
            const statusB = ledB.ledMerah === '1' ? 'Bahaya' : (ledB.ledKuning === '1' ? 'Hati-hati' : 'Aman');
            return order[statusA] - order[statusB];
        });
        tbody.innerHTML = '';
        trainRowElements = {};
    }

    const nextBatchIDs = sortedTrainIDs.slice(trainVisibleCount, trainVisibleCount + 50);
    if (nextBatchIDs.length === 0) return;

    const html = nextBatchIDs.map(vtdid => {
        const train = trainData[vtdid] || {};
        const led = ledStatus[vtdid] || {};
        let status = 'Aman', statusClass = 'status-aman';
        if (led.ledMerah === '1') { status = 'Bahaya'; statusClass = 'status-bahaya'; }
        else if (led.ledKuning === '1') { status = 'Hati-hati'; statusClass = 'status-hati-hati'; }
        const location = [train.L_KECAMATAN, train.L_KABUPATEN, train.L_PROPINSI].filter(Boolean).join(', ');
        const nearestJPL = getNearestActiveJPLForTrain(vtdid);
        const jplDistance = nearestJPL ? `${nearestJPL.distanceKm.toFixed(2)} km (${nearestJPL.jplId})` : '-';

        return `
            <tr class="data-row" data-vtdid="${vtdid}">
                <td class="${statusClass}">${status}</td>
                <td>${vtdid}</td>
                <td>${train.L_SARANA || ''}</td>
                <td>${train.L_KERETA || ''}</td>
                <td>${train.L_SPEED || '0'}</td>
                <td>${location || train.L_LOCATION || ''}</td>
                <td>${formatDateTime(train.L_RECEIVED_DATE)}</td>
                <td>${jplDistance}</td>
            </tr>`;
    }).join('');

    tbody.insertAdjacentHTML('beforeend', html);
    trainVisibleCount += nextBatchIDs.length;
    // Cache <tr> references so live per-train updates (up to ~300/sec) don't need a DOM query.
    nextBatchIDs.forEach(vtdid => {
        trainRowElements[vtdid] = tbody.querySelector(`tr[data-vtdid="${vtdid}"]`);
    });
}
function getTrainStatusInfo(vtdid) {
    const led = ledStatus[vtdid] || {};
    if (led.ledMerah === '1') {
        return { status: 'Bahaya', statusClass: 'status-bahaya', ring: '#ff453a' };
    }
    if (led.ledKuning === '1') {
        return { status: 'Hati-hati', statusClass: 'status-hati-hati', ring: '#ffd60a' };
    }
    // Default / Normal state (both 0 or no LED data received yet)
    return { status: 'Aman', statusClass: 'status-aman', ring: '#30d158' };
}

// Live updates for Train Table
function updateTrainTableRow(vtdid, nearestJPL) {
    const tr = trainRowElements[vtdid]; // cached — avoids a DOM query on every live update
    if (!tr) return;
    const train = trainData[vtdid] || {};
    const info = getTrainStatusInfo(vtdid);
    const location = [train.L_KECAMATAN, train.L_KABUPATEN, train.L_PROPINSI].filter(Boolean).join(', ');
    if (nearestJPL === undefined) nearestJPL = getNearestActiveJPLForTrain(vtdid);

    const cells = tr.children;
    cells[0].textContent = info.status;
    cells[0].className = info.statusClass;
    cells[4].textContent = train.L_SPEED || '0';
    cells[5].textContent = location || train.L_LOCATION || '';
    cells[7].textContent = nearestJPL ? `${nearestJPL.distanceKm.toFixed(2)} km (${nearestJPL.jplId})` : '-';
}

// Update just the "Jarak JPL Aktif" cell on currently-rendered rows when the active JPL
// set changes — cheap alternative to a full renderTrainTable(true) rebuild+resort, since
// JPL distance doesn't affect the table's sort order (which is by LED status only).
function refreshTrainTableJPLColumn() {
    Object.keys(trainRowElements).forEach(vtdid => {
        const tr = trainRowElements[vtdid];
        const nearestJPL = getNearestActiveJPLForTrain(vtdid);
        tr.children[7].textContent = nearestJPL ? `${nearestJPL.distanceKm.toFixed(2)} km (${nearestJPL.jplId})` : '-';
    });
}

// --- Event Log Table (API Pagination) ---
function fetchLogs(reset = true) {
    const tbody = document.querySelector('#log-table tbody');
    if (!tbody || logsLoading) return;
    if (reset) { logOffset = 0; logsExhausted = false; tbody.innerHTML = ''; }
    if (logsExhausted) return;

    logsLoading = true;
    showLoadingIndicator(tbody, 17);

    // Add timeout to handle slow database queries
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    fetch(`${API_BASE}/logs?limit=50&offset=${logOffset}`, { signal: controller.signal })
        .then(res => {
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .then(data => {
            hideLoadingIndicator(tbody);
            console.log('Logs API response:', data);
            const logs = data.logs || [];
            console.log('Logs array length:', logs.length);
            logOffset += logs.length;
            if (logs.length < 50) logsExhausted = true;
            const html = logs.map(log => `
                <tr class="data-row" data-funcloc="${log.funcloc || ''}">
                    <td class="${statusClassFor(formatStatusLabel(log.event_type))}">${formatStatusLabel(log.event_type)}</td>
                    <td>${log.id ? String(log.id).slice(0, 5) + '...' : ''}</td>
                    <td>${log.event_time || ''}</td>
                    <td class="${statusClassFor(formatStatusLabel(log.trigger_type))}">${formatStatusLabel(log.trigger_type)}</td>
                    <td>${log.device_id || ''}</td>
                    <td>${log.funcloc || ''}</td>
                    <td>${log.jpl_lat ?? ''}</td>
                    <td>${log.jpl_lon ?? ''}</td>
                    <td>${log.vtdid || ''}</td>
                    <td>${log.loco_lat ?? ''}</td>
                    <td>${log.loco_lon ?? ''}</td>
                    <td>${log.distance_m ?? ''}</td>
                    <td>${formatStatusLabel(log.previous_alert)}</td>
                    <td>${log.alert_changed ?? ''}</td>
                    <td>${log.release_count ?? ''}</td>
                    <td>${log.loco_speed ?? ''}</td>
                    <td>${log.loco_location || ''}</td>
                </tr>`).join('');
            tbody.insertAdjacentHTML('beforeend', html);
        })
        .catch(err => {
            hideLoadingIndicator(tbody);
            if (err.name === 'AbortError') {
                console.warn('Logs fetch timed out - database query too slow');
                tbody.insertAdjacentHTML('beforeend', '<tr><td colspan="17" style="text-align:center;padding:20px;color:#ff453a;">⚠️ Database query timeout. Please try again later.</td></tr>');
            } else {
                console.warn('Failed to fetch logs:', err);
                tbody.insertAdjacentHTML('beforeend', '<tr><td colspan="17" style="text-align:center;padding:20px;color:#ff453a;">⚠️ Failed to load logs. Please try again.</td></tr>');
            }
        })
        .finally(() => { logsLoading = false; });
}

function showLoadingIndicator(tbody, colspan) {
    hideLoadingIndicator(tbody);
    const tr = document.createElement('tr');
    tr.className = 'loading-row';
    tr.innerHTML = `<td colspan="${colspan}"><div class="spinner"></div> Loading more data...</td>`;
    tbody.appendChild(tr);
}
function hideLoadingIndicator(tbody) {
    const loader = tbody.querySelector('.loading-row');
    if (loader) loader.remove();
}

// --- Weekly JPL Activity Summary (per DAOP) ---
const summaryStartEl = document.getElementById('summary-start');
const summaryEndEl = document.getElementById('summary-end');
const summaryFilterBtn = document.getElementById('summary-filter-btn');
if (summaryStartEl && summaryEndEl) {
    // Default range: last 7 days, same default as the Log tab's export picker.
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const toInputDate = d => d.toISOString().slice(0, 10);
    summaryEndEl.value = toInputDate(today);
    summaryStartEl.value = toInputDate(weekAgo);
}
if (summaryFilterBtn) {
    summaryFilterBtn.addEventListener('click', () => {
        if (!summaryStartEl.value || !summaryEndEl.value) {
            alert('Pilih tanggal mulai dan tanggal akhir terlebih dahulu.');
            return;
        }
        if (summaryStartEl.value > summaryEndEl.value) {
            alert('Tanggal mulai tidak boleh setelah tanggal akhir.');
            return;
        }
        fetchWeeklySummary();
    });
}

let weeklySummaryLoading = false;
function fetchWeeklySummary() {
    const grid = document.getElementById('summary-daop-grid');
    const rangeEl = document.getElementById('summary-week-range');
    if (!grid || weeklySummaryLoading) return;
    weeklySummaryLoading = true;
    grid.innerHTML = '<div class="summary-loading"><div class="spinner"></div> Memuat ringkasan...</div>';

    const start = summaryStartEl ? summaryStartEl.value : '';
    const end = summaryEndEl ? summaryEndEl.value : '';
    const query = start && end ? `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` : '';

    fetch(`${API_BASE}/stats/weekly-jpl-activity${query}`)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .then(data => renderWeeklySummary(data.items || []))
        .catch(err => {
            console.warn('Failed to fetch weekly JPL activity:', err);
            grid.innerHTML = '<div class="summary-loading">⚠️ Gagal memuat ringkasan.</div>';
        })
        .finally(() => { weeklySummaryLoading = false; });

    if (rangeEl) {
        // Construct the Date from local y/m/d parts (not `new Date(str)`, which parses
        // 'YYYY-MM-DD' as UTC midnight — for viewers west of UTC that then formats one
        // day earlier than the date actually sent to the backend).
        const fmt = s => {
            const [y, m, d] = s.split('-').map(Number);
            return new Date(y, m - 1, d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
        };
        rangeEl.textContent = start && end ? `${fmt(start)} – ${fmt(end)}` : '';
    }
}
function renderWeeklySummary(items) {
    const grid = document.getElementById('summary-daop-grid');
    if (!grid) return;

    // Only PB-pressed events count as "active" for this summary — a JPL that only
    // reported health/battery pings this week isn't a panic-button activation.
    const activeByDaop = {}; // daop -> [{funcloc, descript, pressed_count}]
    items.forEach(item => {
        if (!item.pressed_count) return;
        const jpl = jplData[item.funcloc];
        const daop = getDAOPFromBA(jpl ? jpl.ba : null);
        if (!activeByDaop[daop]) activeByDaop[daop] = [];
        activeByDaop[daop].push({
            funcloc: item.funcloc,
            descript: jpl ? jpl.descript : '',
            pressed_count: item.pressed_count
        });
    });

    const daopOrder = [...new Set(Object.values(BA_DAOP_MAP))];
    grid.innerHTML = daopOrder.map(daop => {
        const jpls = (activeByDaop[daop] || []).sort((a, b) => b.pressed_count - a.pressed_count);
        const jplListHtml = jpls.length
            ? jpls.map(j => `<div class="summary-jpl-row"><span class="summary-jpl-id">${j.funcloc}</span><span class="summary-jpl-desc">${j.descript || ''}</span><span class="summary-jpl-count">${j.pressed_count}x</span></div>`).join('')
            : '<div class="summary-jpl-empty">Tidak ada JPL aktif pada periode ini</div>';
        return `
            <div class="summary-daop-card ${jpls.length ? '' : 'summary-daop-card-empty'}">
                <div class="summary-daop-header">
                    <span class="summary-daop-name">${daop}</span>
                    <span class="summary-daop-count">${jpls.length}</span>
                </div>
                <div class="summary-daop-body">${jplListHtml}</div>
            </div>`;
    }).join('');
}

// --- Event Log: Excel Export ---
const logExportStartEl = document.getElementById('log-export-start');
const logExportEndEl = document.getElementById('log-export-end');
const logExportBtn = document.getElementById('log-export-btn');
if (logExportStartEl && logExportEndEl) {
    // Default range: last 7 days, matching the Log tab's own default query window.
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const toInputDate = d => d.toISOString().slice(0, 10);
    logExportEndEl.value = toInputDate(today);
    logExportStartEl.value = toInputDate(weekAgo);
}
if (logExportBtn) {
    logExportBtn.addEventListener('click', () => {
        const start = logExportStartEl.value;
        const end = logExportEndEl.value;
        if (!start || !end) {
            alert('Pilih tanggal mulai dan tanggal akhir terlebih dahulu.');
            return;
        }
        if (start > end) {
            alert('Tanggal mulai tidak boleh setelah tanggal akhir.');
            return;
        }
        window.location.href = `${API_BASE}/logs/export?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    });
}

// ---- Load Offline Railways ----
fetch('/static/railway.geojson')
    .then(res => res.ok ? res.json() : Promise.reject("Failed to load geojson"))
    .then(data => {
        L.geoJSON(data, { style: { color: '#63a0f5', weight: 5, opacity: 0.22, lineCap: 'round', lineJoin: 'round' } }).addTo(map);
        L.geoJSON(data, { style: { color: '#63a0f5', weight: 2, opacity: 0.85, lineCap: 'round', lineJoin: 'round' } }).addTo(map);
        console.log("Neon Railways Loaded!");
    })
    .catch(err => console.error("Railway load failed:", err));

setTimeout(() => map.invalidateSize(), 500);