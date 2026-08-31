import os
import re
import math
from io import BytesIO
from pathlib import Path
from fastapi.staticfiles import StaticFiles
import asyncio
import json
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
from typing import List, Dict, Optional
from datetime import datetime
from openpyxl import Workbook
from .clickhouse import ClickHouseDB
from .mqtt_client import MQTTClientManager
from .models import JPLMaster, TrainLocation, LEDStatus, PanicEvent, HealthStatus

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def normalize_health_payload(payload):
    if not isinstance(payload, dict):
        return payload

    normalized = dict(payload)

    # Map device payload to dashboard contract.
    if not normalized.get("jplId") and normalized.get("funcloc"):
        normalized["jplId"] = normalized["funcloc"]

    if not normalized.get("powerType") and normalized.get("power"):
        normalized["powerType"] = normalized["power"]

    if not normalized.get("power") and normalized.get("powerType"):
        normalized["power"] = normalized["powerType"]

    # Support both batteryPercentage and the legacy misspelling.
    if normalized.get("batteryPercentage") is None and normalized.get("batteryPersentage") is not None:
        normalized["batteryPercentage"] = normalized["batteryPersentage"]
    if normalized.get("batteryPersentage") is None and normalized.get("batteryPercentage") is not None:
        normalized["batteryPersentage"] = normalized["batteryPercentage"]

    for key in ("batteryPercentage", "batteryPersentage"):
        value = normalized.get(key)
        if value is None:
            continue
        try:
            normalized[key] = float(value)
        except (TypeError, ValueError):
            pass

    if "batteryCharging" in normalized and normalized["batteryCharging"] is not None:
        value = str(normalized["batteryCharging"]).strip().lower()
        normalized["batteryCharging"] = value in {"1", "true", "yes", "on", "charging"}

    return normalized


# eventType values that mean "cleared" — the live device feed isn't a strict
# PBPRESSED/PBRELEASED binary, it also sends 'release'/'bahaya'/'perhatian' (Indonesian).
RELEASE_EVENT_TYPES = {'RELEASE', 'PBRELEASE', 'PBRELEASED', 'AMAN', 'SAFE'}

# Global state
jpl_master: List[JPLMaster] = []
jpl_master_serialized: List[dict] = []
jpl_master_json: str = json.dumps({"type": "jpl_list", "data": []})
main_loop = None
broadcaster_task = None

# In-memory stores
train_data: Dict[str, dict] = {}
led_status: Dict[str, dict] = {}
panic_alerts: List[dict] = []
pending_train_updates: Dict[str, dict] = {}  # vtdid -> latest payload (coalesced)
health_status: Dict[str, dict] = {}  # jplId -> latest battery/power payload

# Deduplication state - store last seen content to avoid duplicate broadcasts
last_panic_state: Dict[str, dict] = {}  # jplId -> {deviceId, funcloc, eventType}
last_health_state: Dict[str, dict] = {}  # jplId -> {powerType, isWarning}
last_led_state: Dict[str, dict] = {}  # vtdid -> last LED content


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        await self.send_initial_data(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        if not self.active_connections:
            return
        # Fan out sends concurrently instead of one-by-one so a slow client
        # doesn't delay delivery to everyone else.
        results = await asyncio.gather(
            *(connection.send_text(message) for connection in self.active_connections),
            return_exceptions=True
        )
        dead = [
            conn for conn, result in zip(self.active_connections, results)
            if isinstance(result, Exception)
        ]
        for result in results:
            if isinstance(result, Exception):
                logger.error(f"Broadcast error: {result}")
        # Clean up dead connections so errors don't repeat forever
        for conn in dead:
            self.disconnect(conn)

    async def send_initial_data(self, websocket: WebSocket):
        if jpl_master:
            await websocket.send_text(jpl_master_json)
        if train_data:
            data = {"type": "train_list", "data": list(train_data.values())}
            await websocket.send_text(json.dumps(data))
        if led_status:
            led_list = [{"vtdid": v, **s} for v, s in led_status.items()]
            data = {"type": "led_list", "data": led_list}
            await websocket.send_text(json.dumps(data))
        if panic_alerts:
            data = {"type": "panic_alerts", "data": panic_alerts}
            await websocket.send_text(json.dumps(data))
        if health_status:
            data = {"type": "health_list", "data": list(health_status.values())}
            await websocket.send_text(json.dumps(data))


manager = ConnectionManager()
db = ClickHouseDB()
mqtt_manager = None


def get_train_caught(jpl_lat, jpl_lon, radius_km=3.0):
    """Return list of trains within radius that have LED status."""
    caught = []
    for vtdid, train in train_data.items():
        if 'L_LAT' not in train or 'L_LON' not in train:
            continue
        try:
            lat = float(train['L_LAT'])
            lon = float(train['L_LON'])
        except (ValueError, TypeError):
            continue
        R = 6371
        dlat = math.radians(lat - jpl_lat)
        dlon = math.radians(lon - jpl_lon)
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(math.radians(jpl_lat)) * math.cos(math.radians(lat)) *
             math.sin(dlon / 2) ** 2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        dist = R * c
        if dist <= radius_km:
            led = led_status.get(vtdid, {})
            if led.get('ledMerah') == '1' or led.get('ledKuning') == '1':
                danger = 'Bahaya' if led.get('ledMerah') == '1' else 'Hati-hati'
                caught.append({
                    'vtdid': vtdid,
                    'danger': danger,
                    'distance': round(dist, 2),
                    'led': led
                })
    return caught


async def broadcast_loop():
    """Coalesce high-frequency train updates into ONE batch per second.
    This reduces ~150 WebSocket messages/sec down to 1 message/sec."""
    while True:
        await asyncio.sleep(1.0)
        if pending_train_updates:
            batch = list(pending_train_updates.values())
            pending_train_updates.clear()
            await manager.broadcast(json.dumps({"type": "train_batch", "data": batch}))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global jpl_master, jpl_master_serialized, jpl_master_json, mqtt_manager, main_loop, broadcaster_task
    main_loop = asyncio.get_running_loop()

    # 1. Fetch JPL Master Data (non-blocking, with fallback)
    logger.info("Fetching JPL master data...")
    try:
        jpl_master = await asyncio.to_thread(db.fetch_jpl_master)
        logger.info(f"Loaded {len(jpl_master)} JPL crossings.")
    except Exception as e:
        logger.error(f"Failed to load JPL master: {e}")
        jpl_master = []
    # jpl_master is static after startup, so serialize it once instead of
    # re-running .dict() on every websocket connect / /api/jpl request.
    jpl_master_serialized = [j.dict() for j in jpl_master]
    jpl_master_json = json.dumps({"type": "jpl_list", "data": jpl_master_serialized})

    # 2. Define the MQTT Callback
    def on_mqtt_message(payload):
        if 'L_VTDID' in payload:
            vtdid = payload['L_VTDID']
            train_data[vtdid] = payload
            pending_train_updates[vtdid] = payload

        elif 'eventType' in payload:
            # Not inserted into ClickHouse here — an external device already writes
            # panic events directly to the DB, so we only track in-memory state and
            # broadcast to connected dashboards.
            event = payload
            # Map funcloc to jplId to match MQTT payload structure
            if not event.get('jplId') and event.get('funcloc'):
                event['jplId'] = event['funcloc']
            jpl_id = event.get('jplId')
            event_type = str(event.get('eventType', '')).upper()

            # Deduplication: only check deviceId, funcloc, and eventType
            panic_key = {
                'deviceId': event.get('deviceId'),
                'funcloc': event.get('funcloc'),
                'eventType': event_type
            }
            if jpl_id and last_panic_state.get(jpl_id) == panic_key:
                return  # Skip duplicate message
            if jpl_id:
                last_panic_state[jpl_id] = panic_key

            # If event is a release/clear event, remove active alert from memory list.
            # The live device feed isn't a strict PBPRESSED/PBRELEASED binary — it records
            # 'release', 'bahaya', 'perhatian' (Indonesian) — so match by name, not one exact string.
            if event_type in RELEASE_EVENT_TYPES:
                global panic_alerts
                panic_alerts = [a for a in panic_alerts if a.get('event', {}).get('jplId') != jpl_id]
                broadcast_payload = event
            else:
                jpl = next((j for j in jpl_master if j.function_loc == jpl_id), None)
                caught_trains = get_train_caught(jpl.latitude, jpl.longitude) if (jpl and jpl.latitude and jpl.longitude) else []
                alert = {
                    "event": event,
                    "caught_trains": caught_trains,
                    "timestamp": datetime.now().isoformat()
                }
                panic_alerts.append(alert)
                if len(panic_alerts) > 50:
                    panic_alerts.pop(0)
                # Include caught_trains so the dashboard can show how many trains
                # are affected by this event, same shape as the panic_alerts restore list.
                broadcast_payload = alert

            asyncio.run_coroutine_threadsafe(
                manager.broadcast(json.dumps({"type": "panic_alert", "data": broadcast_payload})),
                main_loop
            )

        elif (
            'powerType' in payload or
            'power' in payload or
            'batteryPercentage' in payload or
            'batteryPersentage' in payload or
            'funcloc' in payload
        ):
            payload = normalize_health_payload(payload)
            jpl_id = payload.get('jplId') or payload.get('funcloc')
            if jpl_id:
                # Deduplication: check power source and battery percentage (rounded to nearest 5% to avoid minor fluctuations)
                power_type = str(payload.get('powerType') or payload.get('power') or '').upper()
                pct = payload.get('batteryPercentage') or payload.get('batteryPersentage')
                charging = payload.get('batteryCharging')
                
                # Round battery percentage to nearest 5% to avoid duplicate broadcasts from minor fluctuations
                rounded_pct = None
                if pct is not None:
                    try:
                        rounded_pct = round(float(pct) / 5) * 5
                    except (ValueError, TypeError):
                        rounded_pct = None
                
                health_key = {
                    'powerType': power_type,
                    'batteryPercentage': rounded_pct,
                    'batteryCharging': charging
                }
                
                if last_health_state.get(jpl_id) == health_key:
                    return  # Skip duplicate message
                last_health_state[jpl_id] = health_key

                health_status[jpl_id] = payload
                asyncio.run_coroutine_threadsafe(
                    manager.broadcast(json.dumps({"type": "health_update", "data": payload})),
                    main_loop
                )

        elif 'ledMerah' in payload:
            vtdid = payload.get('vtdid')
            if vtdid:
                # Deduplication: compare LED state fields
                led_key = {
                    'ledMerah': payload.get('ledMerah'),
                    'ledKuning': payload.get('ledKuning'),
                    'buzzer': payload.get('buzzer')
                }
                if last_led_state.get(vtdid) == led_key:
                    return  # Skip duplicate message
                last_led_state[vtdid] = led_key

                led_status[vtdid] = payload
                asyncio.run_coroutine_threadsafe(
                    manager.broadcast(json.dumps({
                        "type": "led_update",
                        "data": {"vtdid": vtdid, **payload}
                    })),
                    main_loop
                )

    # 3. Start MQTT Manager (with crash prevention)
    mqtt_manager = None
    try:
        mqtt_manager = MQTTClientManager(on_mqtt_message)
        mqtt_manager.start()
        logger.info("MQTT clients started.")
    except Exception as e:
        logger.error(f"Failed to connect to MQTT broker: {e}")
        logger.warning("Server will start WITHOUT MQTT.")

    # 4. Start the batched broadcaster
    broadcaster_task = asyncio.create_task(broadcast_loop())

    yield

    # 5. Safe Shutdown
    if broadcaster_task:
        broadcaster_task.cancel()
    if mqtt_manager:
        mqtt_manager.stop()
    logger.info("Shutdown complete.")


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("Client disconnected")


@app.get("/api/logs")
async def get_logs(jplId: str = None, limit: int = 50, offset: int = 0):
    # Server-side pagination + non-blocking DB call, parameterized to avoid SQL injection
    rows = await asyncio.to_thread(db.fetch_logs, jplId, limit, offset)
    logger.info(f"Logs query returned {len(rows)} rows for jplId={jplId}, limit={limit}, offset={offset}")

    logs = []
    for row in rows:
        logs.append({
            "id": str(row[0]) if row[0] else "",
            "event_time": row[1].isoformat() if row[1] else None,
            "event_type": row[2],
            "trigger_type": row[3],
            "device_id": row[4],
            "funcloc": row[5],
            "jpl_lat": row[6],
            "jpl_lon": row[7],
            "vtdid": row[8],
            "loco_lat": row[9],
            "loco_lon": row[10],
            "distance_m": row[11],
            "previous_alert": row[12],
            "alert_changed": row[13],
            "release_count": row[14],
            "loco_speed": row[15],
            "loco_location": row[16]
        })
    logger.info(f"Returning {len(logs)} logs to frontend")
    return {"logs": logs}


@app.get("/api/jpl")
async def get_jpl():
    return jpl_master_serialized


@app.get("/api/stats/today")
async def get_today_stats():
    try:
        alerts_today, jpl_active_today = await asyncio.gather(
            asyncio.to_thread(db.count_alerts_today),
            asyncio.to_thread(db.count_jpl_active_today)
        )
    except Exception as e:
        logger.error(f"Failed to fetch today's stats: {e}")
        alerts_today, jpl_active_today = 0, 0
    return {"alerts_today": alerts_today, "jpl_active_today": jpl_active_today}


@app.get("/api/stats/weekly-jpl-activity")
async def get_weekly_jpl_activity():
    """Per-funcloc event counts over the last 7 days. The frontend maps funcloc -> ba
    -> DAOP itself (via its own jplData + BA_DAOP_MAP) to build the JPL-Aktif-per-DAOP
    summary tab, so this just returns the raw per-JPL counts."""
    try:
        rows = await asyncio.to_thread(db.fetch_weekly_jpl_activity)
    except Exception as e:
        logger.error(f"Failed to fetch weekly JPL activity: {e}")
        rows = []
    items = [
        {
            "funcloc": row[0],
            "event_count": row[1],
            "pressed_count": row[2],
            "last_event": row[3].isoformat() if row[3] else None
        }
        for row in rows
    ]
    return {"items": items}


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

LOG_EXPORT_HEADERS = [
    "ID", "Waktu", "Tipe", "Trigger", "Device", "Funcloc", "JPL Lat", "JPL Lon",
    "VTDID", "Loco Lat", "Loco Lon", "Jarak (m)", "Alert Sebelumnya", "Alert Berubah",
    "Jumlah Release", "Kecepatan", "Lokasi"
]


def build_logs_workbook(rows) -> BytesIO:
    wb = Workbook()
    ws = wb.active
    ws.title = "Event Log"
    ws.append(LOG_EXPORT_HEADERS)
    for row in rows:
        event_time = row[1].strftime("%Y-%m-%d %H:%M:%S") if row[1] else ""
        ws.append([
            str(row[0]) if row[0] else "", event_time, row[2], row[3], row[4], row[5],
            row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[13],
            row[14], row[15], row[16]
        ])
    for col_cells in ws.columns:
        max_len = max((len(str(c.value)) if c.value is not None else 0) for c in col_cells)
        ws.column_dimensions[col_cells[0].column_letter].width = min(max(max_len + 2, 10), 40)

    buffer = BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


@app.get("/api/logs/export")
async def export_logs(start: str, end: str, jplId: str = None):
    if not _DATE_RE.match(start) or not _DATE_RE.match(end):
        raise HTTPException(status_code=400, detail="start/end must be in YYYY-MM-DD format")
    if start > end:
        raise HTTPException(status_code=400, detail="start must not be after end")

    try:
        rows = await asyncio.to_thread(db.fetch_logs_range, start, end, jplId)
    except Exception as e:
        logger.error(f"Failed to fetch logs for export ({start}..{end}): {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch logs")

    buffer = await asyncio.to_thread(build_logs_workbook, rows)
    filename = f"event_log_{start}_to_{end}.xlsx"
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


# ==========================================
# SERVE FRONTEND & STATIC FILES
# ==========================================
BASE_DIR = Path(__file__).resolve().parent.parent.parent

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
app.mount("/", StaticFiles(directory=BASE_DIR / "frontend", html=True), name="frontend")