import os
from pathlib import Path
from fastapi.staticfiles import StaticFiles
import asyncio
import json
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from typing import List, Dict, Optional
from datetime import datetime
from .config import Config
from .clickhouse import ClickHouseDB
from .mqtt_client import MQTTClientManager
from .models import JPLMaster, TrainLocation, LEDStatus, PanicEvent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global state
jpl_master: List[JPLMaster] = []
main_loop = None
broadcaster_task = None

# In-memory stores
train_data: Dict[str, dict] = {}
led_status: Dict[str, dict] = {}
panic_alerts: List[dict] = []
pending_train_updates: Dict[str, dict] = {}  # vtdid -> latest payload (coalesced)


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
        dead = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Broadcast error: {e}")
                dead.append(connection)
        # Clean up dead connections so errors don't repeat forever
        for conn in dead:
            self.disconnect(conn)

    async def send_initial_data(self, websocket: WebSocket):
        if jpl_master:
            data = {"type": "jpl_list", "data": [j.dict() for j in jpl_master]}
            await websocket.send_text(json.dumps(data))
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


manager = ConnectionManager()
db = ClickHouseDB()
mqtt_manager = None


def get_train_caught(jpl_lat, jpl_lon, radius_km=3.0):
    """Return list of trains within radius that have LED status."""
    import math
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
    global jpl_master, mqtt_manager, main_loop, broadcaster_task
    main_loop = asyncio.get_running_loop()

    # 1. Fetch JPL Master Data (non-blocking, with fallback)
    logger.info("Fetching JPL master data...")
    try:
        jpl_master = await asyncio.to_thread(db.fetch_jpl_master)
        logger.info(f"Loaded {len(jpl_master)} JPL crossings.")
    except Exception as e:
        logger.error(f"Failed to load JPL master: {e}")
        jpl_master = []

    # 2. Define the MQTT Callback
    def on_mqtt_message(payload):
        if 'L_VTDID' in payload:
            vtdid = payload['L_VTDID']
            train_data[vtdid] = payload
            pending_train_updates[vtdid] = payload

        elif 'eventType' in payload:
            event = payload
            try:
                db.insert_panic_event(event)
            except Exception as e:
                logger.error(f"Failed to insert panic event: {e}")

            jpl_id = event.get('jplId')
            event_type = str(event.get('eventType', '')).upper()

            # If event is RELEASE, remove active alert from memory list
            if event_type == 'RELEASE':
                global panic_alerts
                panic_alerts = [a for a in panic_alerts if a.get('event', {}).get('jplId') != jpl_id]
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

            asyncio.run_coroutine_threadsafe(
                manager.broadcast(json.dumps({"type": "panic_alert", "data": event})),
                main_loop
            )

        elif 'ledMerah' in payload:
            vtdid = payload.get('vtdid')
            if vtdid:
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
    # Server-side pagination + non-blocking DB call
    def fetch_logs_sync():
        query = (
            f"SELECT id, event_time, event_type, trigger_type, device_id, "
            f"funcloc, jpl_lat, jpl_lon, vtdid, loco_lat, loco_lon, distance_m, "
            f"previous_alert, alert_changed, release_count, loco_speed, loco_location "
            f"FROM {Config.CH_DATABASE}.{Config.CH_TABLE}"
        )
        if jplId:
            query += f" WHERE funcloc = '{jplId}'"
        query += f" ORDER BY event_time DESC LIMIT {limit} OFFSET {offset}"
        return db.client.execute(query)

    rows = await asyncio.to_thread(fetch_logs_sync)

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
    return {"logs": logs}


@app.get("/api/jpl")
async def get_jpl():
    return [j.dict() for j in jpl_master]


# ==========================================
# SERVE FRONTEND & STATIC FILES
# ==========================================
BASE_DIR = Path(__file__).resolve().parent.parent.parent

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
app.mount("/", StaticFiles(directory=BASE_DIR / "frontend", html=True), name="frontend")