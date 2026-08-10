// ---- Configuration ----
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
const API_BASE = '/api';

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
let activeAlerts = new Set();

// Infinite Scroll State
let sortedJPLIDs = [];
let sortedTrainIDs = [];
let jplVisibleCount = 0;
let trainVisibleCount = 0;
let logOffset = 0;
let logsLoading = false;
let logsExhausted = false;
let currentView = 'jpl';
let isRenderingBatch = false;

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

// ---- Resize Sidebar ----
const resizeHandle = document.createElement('div');
resizeHandle.className = 'resize-handle';
sidebarContent.appendChild(resizeHandle);
let isResizing = false, startX, startWidth;
resizeHandle.addEventListener('mousedown', function(e) {
    isResizing = true; startX = e.clientX; startWidth = sidebarContent.offsetWidth;
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
    if (isResizing) { isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
});

// ---- Tab Switching ----
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = {
    jpl: document.getElementById('tab-jpl'),
    train: document.getElementById('tab-train'),
    log: document.getElementById('tab-log')
};
const tabContent = document.getElementById('tab-content');

tabBtns.forEach(btn => {
    btn.addEventListener('click', function() {
        tabBtns.forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        currentView = this.dataset.tab;
        Object.keys(tabPanes).forEach(key => tabPanes[key].classList.toggle('active', key === currentView));
        
        // Reset scroll position when switching tabs
        tabContent.scrollTop = 0;

        if (currentView === 'jpl') renderJPLTable(true);
        else if (currentView === 'train') renderTrainTable(true);
        else if (currentView === 'log') fetchLogs(true);
    });
});

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

// ---- WebSocket ----
let ws = null;
function connectWebSocket() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => console.log('WS connected');
    ws.onmessage = (event) => handleWebSocketMessage(JSON.parse(event.data));
    ws.onclose = () => { console.warn('WS closed, reconnecting...'); setTimeout(connectWebSocket, 3000); };
    ws.onerror = (err) => { console.error('WS error', err); ws.close(); };
}
connectWebSocket();

function handleWebSocketMessage(msg) {
    if (msg.type === 'jpl_list') {
        msg.data.forEach(jpl => addJPLMarker(jpl));
        renderJPLTable(true);

    } else if (msg.type === 'train_list' || msg.type === 'train_batch') {
        msg.data.forEach(train => {
            updateTrain(train);
            updateTrainTableRow(train.L_VTDID);
        });
        if (msg.type === 'train_list' && Object.keys(trainData).length === msg.data.length) {
            renderTrainTable(true);
        }

    } else if (msg.type === 'led_list') {
        // 🚀 FIX: Update background status ONLY, do NOT trigger popups for historical data
        msg.data.forEach(led => {
            ledStatus[led.vtdid] = led;
        });
        renderTrainTable(true);

    } else if (msg.type === 'train_update') {
        updateTrain(msg.data);
        updateTrainTableRow(msg.data.L_VTDID);

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
                setJPLState(event.jplId, 'pbpressed');
            }
        });
        renderJPLTable(true);
    }
}

// ---- Train Map Markers ----
function createTrainIcon(bodyColor, ringColor) {
    return L.divIcon({
        className: 'train-icon',
        html: `<div class="train-dot" style="background:${bodyColor}; border-color:${ringColor};">🚆</div>`,
        iconSize: [20, 20], iconAnchor: [10, 10]
    });
}
function trainColors(vtdid) {
    const info = getTrainStatusInfo(vtdid);
    return { body: '#ff8c00', ring: info.ring };
}
function updateTrain(data) {
    const vtdid = data.L_VTDID;
    const lat = parseFloat(data.L_LAT);
    const lon = parseFloat(data.L_LON);
    if (isNaN(lat) || isNaN(lon)) return;
    trainData[vtdid] = data;
    const c = trainColors(vtdid);
    let marker = trainMarkers[vtdid];
    if (marker) {
        marker.setLatLng([lat, lon]);
        if (marker.options._ring !== c.ring) {
            marker.setIcon(createTrainIcon(c.body, c.ring));
            marker.options._ring = c.ring;
        }
        marker.setPopupContent(createTrainPopup(data, ledStatus[vtdid] || {}));
    } else {
        marker = L.marker([lat, lon], { icon: createTrainIcon(c.body, c.ring) }).addTo(map);
        marker.options._ring = c.ring;
        marker.bindPopup(createTrainPopup(data, ledStatus[vtdid] || {}));
        trainMarkers[vtdid] = marker;
    }
}
function updateTrainMarkerColor(vtdid) {
    const data = trainData[vtdid]; if (!data) return;
    const c = trainColors(vtdid);
    const marker = trainMarkers[vtdid];
    if (marker && marker.options._ring !== c.ring) {
        marker.setIcon(createTrainIcon(c.body, c.ring));
        marker.options._ring = c.ring;
        marker.setPopupContent(createTrainPopup(data, ledStatus[vtdid] || {}));
    }
}
function createTrainPopup(data, led) {
    const info = getTrainStatusInfo(data.L_VTDID);
    return `<b>${data.L_VTDID}</b><br>Speed: ${data.L_SPEED} km/h<br>Location: ${data.L_LOCATION || 'N/A'}<br>Status: ${info.status}`;
}
function updateTrainScale() {
    const size = Math.max(16, Math.min(32, 8 + map.getZoom() * 2));
    document.getElementById('map').style.setProperty('--train-size', size + 'px');
}
map.on('zoomend', updateTrainScale);
updateTrainScale();

// ---- JPL Map Markers ----
function addJPLMarker(jpl) {
    const id = jpl.function_loc;
    if (!id || jplMarkers[id]) return;
    const lat = jpl.latitude, lon = jpl.longitude;
    if (lat == null || lon == null) return;
    jplData[id] = jpl;
    const marker = L.circleMarker([lat, lon], {
        renderer: jplRenderer, radius: 6, fillColor: '#30d158', color: '#fff', weight: 2, opacity: 1, fillOpacity: 0.8
    }).addTo(map);
    marker.bindPopup(`<b>${id}</b><br>${jpl.descript || ''}<br>BA: ${jpl.ba || ''}<br>Status: <span id="status-${id}">RELEASE</span>`);
    marker.on('click', () => map.setView([lat, lon], 14));
    jplMarkers[id] = marker;
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
function stopPulse(jplId) {
    if (jplPulseIntervals[jplId]) { clearInterval(jplPulseIntervals[jplId]); delete jplPulseIntervals[jplId]; }
    const marker = jplMarkers[jplId];
    if (marker) { marker.setRadius(6); marker.setStyle({ fillColor: '#30d158', fillOpacity: 0.8 }); }
}
function updateRadiusCircles(jplId, state) {
    if (jplRadiusLayers[jplId]) {
        jplRadiusLayers[jplId].forEach(layer => map.removeLayer(layer));
        delete jplRadiusLayers[jplId];
    }
    if (state !== 'pbpressed') return;
    const jpl = jplData[jplId]; if (!jpl) return;
    const lat = jpl.latitude, lon = jpl.longitude;
    if (lat == null || lon == null) return;
    const red = L.circle([lat, lon], { renderer: jplRenderer, radius: 1100, color: '#ff453a', fillColor: '#ff453a', fillOpacity: 0.15, weight: 2, opacity: 0.6 }).addTo(map);
    const yellow = L.circle([lat, lon], { renderer: jplRenderer, radius: 3000, color: '#ff9f0a', fillColor: '#ff9f0a', fillOpacity: 0.1, weight: 2, opacity: 0.5 }).addTo(map);
    jplRadiusLayers[jplId] = [red, yellow];
}
function setJPLState(jplId, state) {
    const marker = jplMarkers[jplId]; if (!marker) return;
    if (state === 'pbpressed') { marker.setStyle({ fillColor: '#ff453a' }); startPulse(jplId); } else { stopPulse(jplId); }
    updateRadiusCircles(jplId, state);
    const popup = marker.getPopup();
    if (popup) popup.setContent(popup.getContent().replace(/Status: .*/, `Status: ${state.toUpperCase()}`));
}


// ---- Clear/Release JPL Alert Helper ----
function clearAlertForJPL(jplId) {
    activeAlerts.delete(jplId);

    // Remove JPL alert popups from alert stack
    const jplPopups = document.querySelectorAll(`.alert-item[data-jpl="${jplId}"]`);
    jplPopups.forEach(item => item.remove());

    // Reset map marker color, stop pulse, and clear radius circles
    setJPLState(jplId, 'release');
    renderJPLTable(true);
}

function addJPLPanicAlert(alertData) {
    const event = alertData.event || alertData;
    const jplId = event.jplId;
    const eventType = String(event.eventType || '').toUpperCase();

    if (eventType === 'RELEASE') {
        clearAlertForJPL(jplId);
        return;
    }

    activeAlerts.add(jplId);
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
            <div><strong>Status:</strong> ${event.eventType || 'PBPRESSED'}</div>
            <div><strong>Time:</strong> ${event.datetime || new Date().toLocaleTimeString()}</div>
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
        clearAlertForJPL(jplId);
    });

    document.getElementById('alert-stack').appendChild(alertItem);
    setJPLState(jplId, 'pbpressed');
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
            <div><strong>Speed:</strong> ${train.L_SPEED || '0'} km/h</div>
            <div><strong>Location:</strong> ${train.L_LOCATION || [train.L_KECAMATAN, train.L_KABUPATEN].filter(Boolean).join(', ') || 'N/A'}</div>
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


// ==========================================
// INFINITE SCROLL TABLE RENDERING
// ==========================================

// --- JPL Table ---
function renderJPLTable(reset = false) {
    const tbody = document.querySelector('#jpl-table tbody'); if (!tbody) return;
    if (reset) {
        jplVisibleCount = 0;
        sortedJPLIDs = Object.keys(jplData).sort((a, b) => {
            const statusA = activeAlerts.has(a) ? 0 : 1;
            const statusB = activeAlerts.has(b) ? 0 : 1;
            return statusA - statusB;
        });
        tbody.innerHTML = '';
    }

    const nextBatchIDs = sortedJPLIDs.slice(jplVisibleCount, jplVisibleCount + 50);
    if (nextBatchIDs.length === 0) return;

    const html = nextBatchIDs.map(id => {
        const jpl = jplData[id] || {};
        const status = activeAlerts.has(id) ? 'PBPRESSED' : 'RELEASE';
        const statusClass = status === 'PBPRESSED' ? 'status-pbpressed' : 'status-release';
        return `
            <tr class="data-row ${statusClass}" data-jpl="${id}">
                <td>${id}</td><td>${jpl.ba || ''}</td><td>${jpl.descript || ''}</td>
                <td class="${statusClass}">${status}</td>
            </tr>`;
    }).join('');

    tbody.insertAdjacentHTML('beforeend', html);
    jplVisibleCount += nextBatchIDs.length;
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

        return `
            <tr class="data-row" data-vtdid="${vtdid}">
                <td>${vtdid}</td>
                <td>${train.L_SARANA || ''}</td>
                <td>${train.L_KERETA || ''}</td>
                <td>${train.L_SPEED || '0'}</td>
                <td>${location || train.L_LOCATION || ''}</td>
                <td>${(train.L_RECEIVED_DATE || '').slice(0, 16)}</td>
                <td class="${statusClass}">${status}</td>
            </tr>`;
    }).join('');

    tbody.insertAdjacentHTML('beforeend', html);
    trainVisibleCount += nextBatchIDs.length;
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
function updateTrainTableRow(vtdid) {
    const tr = document.querySelector(`#train-table tbody tr[data-vtdid="${vtdid}"]`);
    if (!tr) return; 
    const train = trainData[vtdid] || {};
    const info = getTrainStatusInfo(vtdid);
    const location = [train.L_KECAMATAN, train.L_KABUPATEN, train.L_PROPINSI].filter(Boolean).join(', ');
    
    const cells = tr.children;
    cells[3].textContent = train.L_SPEED || '0';
    cells[4].textContent = location || train.L_LOCATION || '';
    cells[6].textContent = info.status;
    cells[6].className = info.statusClass;
}

// --- Event Log Table (API Pagination) ---
function fetchLogs(reset = true) {
    const tbody = document.querySelector('#log-table tbody');
    if (!tbody || logsLoading) return;
    if (reset) { logOffset = 0; logsExhausted = false; tbody.innerHTML = ''; }
    if (logsExhausted) return;

    logsLoading = true;
    showLoadingIndicator(tbody, 17);

    fetch(`${API_BASE}/logs?limit=50&offset=${logOffset}`)
        .then(res => res.json())
        .then(data => {
            hideLoadingIndicator(tbody);
            const logs = data.logs || [];
            logOffset += logs.length;
            if (logs.length < 50) logsExhausted = true;
            const html = logs.map(log => `
                <tr class="data-row" data-funcloc="${log.funcloc || ''}">
                    <td>${log.id ? String(log.id).slice(0, 5) + '...' : ''}</td>
                    <td>${log.event_time || ''}</td>
                    <td>${log.event_type || ''}</td>
                    <td>${log.trigger_type || ''}</td>
                    <td>${log.device_id || ''}</td>
                    <td>${log.funcloc || ''}</td>
                    <td>${log.jpl_lat ?? ''}</td>
                    <td>${log.jpl_lon ?? ''}</td>
                    <td>${log.vtdid || ''}</td>
                    <td>${log.loco_lat ?? ''}</td>
                    <td>${log.loco_lon ?? ''}</td>
                    <td>${log.distance_m ?? ''}</td>
                    <td>${log.previous_alert || ''}</td>
                    <td>${log.alert_changed ?? ''}</td>
                    <td>${log.release_count ?? ''}</td>
                    <td>${log.loco_speed ?? ''}</td>
                    <td>${log.loco_location || ''}</td>
                </tr>`).join('');
            tbody.insertAdjacentHTML('beforeend', html);
        })
        .catch(err => { hideLoadingIndicator(tbody); console.warn('Failed to fetch logs:', err); })
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

// ---- Load Offline Railways ----
fetch('/static/railway.geojson')
    .then(res => res.ok ? res.json() : Promise.reject("Failed to load geojson"))
    .then(data => {
        L.geoJSON(data, { style: { color: '#00e5ff', weight: 8, opacity: 0.3, lineCap: 'round', lineJoin: 'round' } }).addTo(map);
        L.geoJSON(data, { style: { color: 'rgb(199, 236, 199)', weight: 2, opacity: 0.9, lineCap: 'round', lineJoin: 'round' } }).addTo(map);
        console.log("Neon Railways Loaded!");
    })
    .catch(err => console.error("Railway load failed:", err));

setTimeout(() => map.invalidateSize(), 500);