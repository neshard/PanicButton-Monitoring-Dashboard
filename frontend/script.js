// ---- Configuration ----
const WS_URL = 'ws://localhost:8000/ws';
const API_BASE = 'http://localhost:8000/api';

// ---- Map Setup ----
const map = L.map('map', {
    center: [-7.0, 109.0],
    zoom: 8,
    zoomControl: true
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>'
}).addTo(map);

// ---- State ----
let trainMarkers = {};
let jplMarkers = {};
let jplData = {};
let trainData = {};
let ledStatus = {};
let jplRadiusLayers = {};
let jplPulseIntervals = {};
let currentView = 'jpl';

// ---- Sidebar Toggle ----
const hamburger = document.getElementById('hamburger');
const sidebarContent = document.getElementById('sidebar-content');
const closeSidebar = document.getElementById('close-sidebar');

function openSidebar() {
    sidebarContent.classList.remove('hidden');
    hamburger.style.display = 'none';
    // refresh map size after sidebar opens
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

let isResizing = false;
let startX, startWidth;

resizeHandle.addEventListener('mousedown', function(e) {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebarContent.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
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
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }
});

// ---- Tab Switching ----
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = {
    jpl: document.getElementById('tab-jpl'),
    train: document.getElementById('tab-train'),
    log: document.getElementById('tab-log')
};

tabBtns.forEach(btn => {
    btn.addEventListener('click', function() {
        tabBtns.forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const tab = this.dataset.tab;
        currentView = tab;
        Object.keys(tabPanes).forEach(key => {
            tabPanes[key].classList.toggle('active', key === tab);
        });
        renderTables();
        if (tab === 'log') fetchLogs(); // refresh logs when switching to log tab
    });
});

// ---- WebSocket ----
let ws = null;

function connectWebSocket() {
    ws = new WebSocket(WS_URL);
    ws.onopen = function() { console.log('WebSocket connected'); };
    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    ws.onclose = function() {
        console.warn('WebSocket closed, reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = function(err) {
        console.error('WebSocket error:', err);
        ws.close();
    };
}
connectWebSocket();

// ---- Handle Incoming Messages ----
function handleWebSocketMessage(msg) {
    if (msg.type === 'jpl_list') {
        msg.data.forEach(jpl => addJPLMarker(jpl));
        renderTables();
    } else if (msg.type === 'train_list') {
        msg.data.forEach(train => updateTrain(train));
        renderTables();
    } else if (msg.type === 'led_list') {
        msg.data.forEach(led => { ledStatus[led.vtdid] = led; });
        renderTables();
    } else if (msg.type === 'train_update') {
        updateTrain(msg.data);
        renderTables();
    } else if (msg.type === 'led_update') {
        const vtdid = msg.data.vtdid;
        ledStatus[vtdid] = msg.data;
        updateTrainMarkerColor(vtdid);
        renderTables();
    } else if (msg.type === 'panic_alert') {
        addAlert(msg.data);
        renderTables();
    } else if (msg.type === 'panic_alerts') {
        msg.data.forEach(alert => addAlert(alert, false));
    }
}

// ---- Train Markers ----
function updateTrain(data) {
    const vtdid = data.L_VTDID;
    const lat = parseFloat(data.L_LAT);
    const lon = parseFloat(data.L_LON);
    if (isNaN(lat) || isNaN(lon)) return;
    trainData[vtdid] = data;

    const led = ledStatus[vtdid] || {};
    let color = '#007aff';
    if (led.ledMerah === '1') color = '#ff453a';
    else if (led.ledKuning === '1') color = '#ff9f0a';
    else color = '#30d158';

    let marker = trainMarkers[vtdid];
    if (marker) {
        marker.setLatLng([lat, lon]);
        const newIcon = createTrainIcon(color);
        marker.setIcon(newIcon);
        marker.setPopupContent(createTrainPopup(data, led));
    } else {
        const icon = createTrainIcon(color);
        marker = L.marker([lat, lon], { icon: icon }).addTo(map);
        marker.bindPopup(createTrainPopup(data, led));
        trainMarkers[vtdid] = marker;
    }
}

function createTrainIcon(color) {
    return L.divIcon({
        className: 'train-icon',
        html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:2px solid white;box-shadow:0 0 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;color:white;font-weight:bold;">🚆</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });
}

function updateTrainMarkerColor(vtdid) {
    const data = trainData[vtdid];
    if (!data) return;
    const led = ledStatus[vtdid] || {};
    let color = '#007aff';
    if (led.ledMerah === '1') color = '#ff453a';
    else if (led.ledKuning === '1') color = '#ff9f0a';
    else color = '#30d158';
    const marker = trainMarkers[vtdid];
    if (marker) {
        const newIcon = createTrainIcon(color);
        marker.setIcon(newIcon);
        marker.setPopupContent(createTrainPopup(data, led));
    }
}

function createTrainPopup(data, led) {
    const status = led.ledMerah === '1' ? 'Bahaya' : (led.ledKuning === '1' ? 'Hati-hati' : 'Aman');
    return `
        <b>${data.L_VTDID}</b><br>
        Speed: ${data.L_SPEED} km/h<br>
        Location: ${data.L_LOCATION || 'N/A'}<br>
        Status: ${status}<br>
        Time: ${data.L_DATETIME}
    `;
}

// ---- JPL Markers (with pulse) ----
function addJPLMarker(jpl) {
    const id = jpl.function_loc;
    if (!id) return;
    const lat = jpl.latitude;
    const lon = jpl.longitude;
    if (lat == null || lon == null) return;
    jplData[id] = jpl;

    const color = '#30d158';
    const marker = L.circleMarker([lat, lon], {
        radius: 8,
        fillColor: color,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
    }).addTo(map);

    marker.bindPopup(`
        <b>${id}</b><br>
        ${jpl.descript || ''}<br>
        BA: ${jpl.ba || ''}<br>
        Status: <span id="status-${id}">RELEASE</span>
    `);

    jplMarkers[id] = marker;
    startPulse(id, 'release');

    marker.on('click', function() {
        map.setView([lat, lon], 15);
    });
}

// ---- Pulse Animation ----
function startPulse(jplId, state) {
    const marker = jplMarkers[jplId];
    if (!marker) return;
    if (jplPulseIntervals[jplId]) {
        clearInterval(jplPulseIntervals[jplId]);
        delete jplPulseIntervals[jplId];
    }
    let color, radius;
    if (state === 'pbpressed') {
        color = '#ff453a';
        radius = 12;
    } else {
        color = '#30d158';
        radius = 8;
    }
    marker.setStyle({ fillColor: color, radius: radius });

    let growing = true;
    const interval = setInterval(() => {
        let r = marker.options.radius;
        let op = marker.options.fillOpacity;
        if (growing) {
            r += 2;
            op = Math.min(1, op + 0.1);
            if (r >= radius + 4) growing = false;
        } else {
            r -= 2;
            op = Math.max(0.4, op - 0.1);
            if (r <= radius) growing = true;
        }
        marker.setRadius(r);
        marker.setStyle({ fillOpacity: op });
    }, 200);
    jplPulseIntervals[jplId] = interval;
}

// ---- Radius Circles ----
function updateRadiusCircles(jplId, state) {
    if (jplRadiusLayers[jplId]) {
        jplRadiusLayers[jplId].forEach(layer => map.removeLayer(layer));
        delete jplRadiusLayers[jplId];
    }
    if (state !== 'pbpressed') return;

    const jpl = jplData[jplId];
    if (!jpl) return;
    const lat = jpl.latitude;
    const lon = jpl.longitude;
    if (lat == null || lon == null) return;

    const red = L.circle([lat, lon], {
        radius: 1100,
        color: '#ff453a',
        fillColor: '#ff453a',
        fillOpacity: 0.15,
        weight: 2,
        opacity: 0.6
    }).addTo(map);
    const yellow = L.circle([lat, lon], {
        radius: 3000,
        color: '#ff9f0a',
        fillColor: '#ff9f0a',
        fillOpacity: 0.1,
        weight: 2,
        opacity: 0.5
    }).addTo(map);
    jplRadiusLayers[jplId] = [red, yellow];
}

// ---- Set JPL State ----
function setJPLState(jplId, state) {
    const marker = jplMarkers[jplId];
    if (!marker) return;
    const color = state === 'pbpressed' ? '#ff453a' : '#30d158';
    marker.setStyle({ fillColor: color });
    startPulse(jplId, state);
    updateRadiusCircles(jplId, state);
    const popup = marker.getPopup();
    if (popup) {
        const content = popup.getContent();
        const newContent = content.replace(/Status: .*/, `Status: ${state.toUpperCase()}`);
        popup.setContent(newContent);
    }
}

// ---- Alert Stack ----
function addAlert(alertData, autoClose = true) {
    const alertItem = document.createElement('div');
    alertItem.className = 'alert-item';
    const event = alertData.event;
    const jplId = event.jplId;
    const jpl = jplData[jplId];
    const caught = alertData.caught_trains || [];

    let caughtHtml = '';
    if (caught.length > 0) {
        caughtHtml = '<div style="margin-top:6px;"><strong>Caught trains:</strong><br>';
        caught.forEach(t => {
            const cls = t.danger === 'Bahaya' ? 'danger-bahaya' : 'danger-hati-hati';
            caughtHtml += `<span class="caught-train ${cls}" data-vtdid="${t.vtdid}">🚆 ${t.vtdid} (${t.danger})</span> `;
        });
        caughtHtml += '</div>';
    } else {
        caughtHtml = '<div style="margin-top:6px;color:#888;">No trains caught</div>';
    }

    alertItem.innerHTML = `
        <div class="alert-header">
            <span>🚨 ${jplId}</span>
            <button class="alert-close" data-jpl="${jplId}">&times;</button>
        </div>
        <div class="alert-body">
            <div><strong>${event.eventType}</strong> at ${event.datetime}</div>
            <div>${jpl ? jpl.descript : ''}</div>
            ${caughtHtml}
            <div style="margin-top:4px;font-size:12px;color:#888;">Click to center map</div>
        </div>
    `;

    alertItem.querySelector('.alert-body').addEventListener('click', function(e) {
        if (e.target.closest('.alert-close')) return;
        const jplId = this.closest('.alert-item').querySelector('.alert-close').dataset.jpl;
        const jpl = jplData[jplId];
        if (jpl && jpl.latitude && jpl.longitude) {
            map.setView([jpl.latitude, jpl.longitude], 14);
        }
    });

    alertItem.querySelector('.alert-close').addEventListener('click', function(e) {
        e.stopPropagation();
        const item = this.closest('.alert-item');
        removeAlertItem(item);
    });

    const stack = document.getElementById('alert-stack');
    stack.appendChild(alertItem);
    setJPLState(jplId, 'pbpressed');

    if (autoClose) {
        const timeout = setTimeout(() => {
            removeAlertItem(alertItem);
        }, 10000);
        alertItem._timeout = timeout;
    }
    renderTables();
}

function removeAlertItem(item) {
    if (item._timeout) clearTimeout(item._timeout);
    const jplId = item.querySelector('.alert-close').dataset.jpl;
    item.remove();
    const remaining = document.querySelectorAll(`.alert-item .alert-close[data-jpl="${jplId}"]`);
    if (remaining.length === 0) {
        setJPLState(jplId, 'release');
        if (jplRadiusLayers[jplId]) {
            jplRadiusLayers[jplId].forEach(l => map.removeLayer(l));
            delete jplRadiusLayers[jplId];
        }
        renderTables();
    }
}

// ---- Tables Rendering ----
function renderTables() {
    renderJPLTable();
    renderTrainTable();
}

function renderJPLTable() {
    const tbody = document.querySelector('#jpl-table tbody');
    if (!tbody) return;
    const rows = [];
    Object.keys(jplData).forEach(id => {
        const jpl = jplData[id];
        const activeAlert = document.querySelector(`.alert-item .alert-close[data-jpl="${id}"]`);
        const status = activeAlert ? 'PBPRESSED' : 'RELEASE';
        rows.push({ id, jpl, status });
    });
    rows.sort((a, b) => (a.status === 'PBPRESSED' ? 0 : 1) - (b.status === 'PBPRESSED' ? 0 : 1));

    tbody.innerHTML = rows.map(row => `
        <tr data-jpl="${row.id}" class="${row.status === 'PBPRESSED' ? 'status-pbpressed' : 'status-release'}">
            <td>${row.id}</td>
            <td>${row.jpl.ba || ''}</td>
            <td>${row.jpl.descript || ''}</td>
            <td class="${row.status === 'PBPRESSED' ? 'status-pbpressed' : 'status-release'}">${row.status}</td>
        </tr>
    `).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
        tr.addEventListener('click', function() {
            const jplId = this.dataset.jpl;
            const jpl = jplData[jplId];
            if (jpl && jpl.latitude && jpl.longitude) {
                map.setView([jpl.latitude, jpl.longitude], 14);
                const marker = jplMarkers[jplId];
                if (marker) marker.openPopup();
            }
        });
    });
}

function renderTrainTable() {
    const tbody = document.querySelector('#train-table tbody');
    if (!tbody) return;
    const rows = [];
    Object.keys(trainData).forEach(vtdid => {
        const train = trainData[vtdid];
        const led = ledStatus[vtdid] || {};
        let status = 'Aman';
        let statusClass = 'status-aman';
        if (led.ledMerah === '1') { status = 'Bahaya'; statusClass = 'status-bahaya'; }
        else if (led.ledKuning === '1') { status = 'Hati-hati'; statusClass = 'status-hati-hati'; }
        const location = [
            train.L_KECAMATAN || '',
            train.L_KABUPATEN || '',
            train.L_PROPINSI || ''
        ].filter(Boolean).join(', ');
        rows.push({
            vtdid,
            sarana: train.L_SARANA || '',
            kereta: train.L_KERETA || '',
            speed: train.L_SPEED || '0',
            location: location || train.L_LOCATION || '',
            received: train.L_RECEIVED_DATE || '',
            status,
            statusClass,
            train
        });
    });
    const order = { 'Bahaya': 0, 'Hati-hati': 1, 'Aman': 2 };
    rows.sort((a, b) => order[a.status] - order[b.status]);

    tbody.innerHTML = rows.map(row => `
        <tr data-vtdid="${row.vtdid}">
            <td>${row.vtdid}</td>
            <td>${row.sarana}</td>
            <td>${row.kereta}</td>
            <td>${row.speed}</td>
            <td>${row.location}</td>
            <td>${row.received.slice(0,16)}</td>
            <td class="${row.statusClass}">${row.status}</td>
        </tr>
    `).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
        tr.addEventListener('click', function() {
            const vtdid = this.dataset.vtdid;
            const marker = trainMarkers[vtdid];
            if (marker) {
                const latlng = marker.getLatLng();
                map.setView(latlng, 14);
                marker.openPopup();
            }
        });
    });
}

function fetchLogs() {
    const tbody = document.querySelector('#log-table tbody');
    if (!tbody) return;
    fetch(`${API_BASE}/logs?limit=100`)
        .then(res => res.json())
        .then(data => {
            const logs = data.logs || [];
            tbody.innerHTML = logs.map(log => `
                <tr data-funcloc="${log.funcloc || ''}">
                    <td>${log.id ? log.id.slice(0,5)+'...' : ''}</td>
                    <td>${log.event_time || ''}</td>
                    <td>${log.event_type || ''}</td>
                    <td>${log.trigger_type || ''}</td>
                    <td>${log.device_id || ''}</td>
                    <td>${log.funcloc || ''}</td>
                    <td>${log.jpl_lat || ''}</td>
                    <td>${log.jpl_lon || ''}</td>
                    <td>${log.vtdid || ''}</td>
                    <td>${log.loco_lat || ''}</td>
                    <td>${log.loco_lon || ''}</td>
                    <td>${log.distance_m || ''}</td>
                    <td>${log.previous_alert || ''}</td>
                    <td>${log.alert_changed || ''}</td>
                    <td>${log.release_count || ''}</td>
                    <td>${log.loco_speed || ''}</td>
                    <td>${log.loco_location || ''}</td>
                </tr>
            `).join('');

            tbody.querySelectorAll('tr').forEach(tr => {
                tr.addEventListener('click', function() {
                    const funcloc = this.dataset.funcloc;
                    if (funcloc) {
                        const jpl = jplData[funcloc];
                        if (jpl && jpl.latitude && jpl.longitude) {
                            map.setView([jpl.latitude, jpl.longitude], 14);
                            const marker = jplMarkers[funcloc];
                            if (marker) marker.openPopup();
                        }
                    }
                });
            });
        })
        .catch(err => console.warn('Failed to fetch logs:', err));
}

// ---- Railway Overpass ----
function fetchRailways() {
    const bounds = map.getBounds();
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    const url = `https://overpass-api.de/api/interpreter?data=[out:json];way["railway"="rail"](${bbox});out geom;`;
    fetch(url)
        .then(res => res.json())
        .then(data => {
            data.elements.forEach(el => {
                if (el.geometry) {
                    const coords = el.geometry.map(g => [g.lat, g.lon]);
                    L.polyline(coords, {
                        color: '#0055aa',
                        weight: 3,
                        opacity: 0.6,
                        smoothFactor: 1
                    }).addTo(map);
                }
            });
        })
        .catch(err => console.warn('Railway fetch failed:', err));
}
map.on('moveend', fetchRailways);
fetchRailways();

// ---- Force map redraw after load ----
setTimeout(() => map.invalidateSize(), 500);