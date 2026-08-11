import logging
import threading
import uuid
from datetime import datetime
from typing import List, Any, Optional
from clickhouse_driver import Client
from .config import Config
from .models import JPLMaster

logger = logging.getLogger(__name__)


class ClickHouseDB:
    def __init__(self):
        self.client = Client(
            host=Config.CH_HOST,
            port=9000,   # native TCP
            user=Config.CH_USERNAME,
            password=Config.CH_PASSWORD,
            database=Config.CH_DATABASE
        )
        # clickhouse_driver.Client wraps a single TCP connection and is not
        # thread-safe. It's called concurrently from MQTT callback threads
        # (insert_panic_event) and the FastAPI threadpool (asyncio.to_thread),
        # so serialize access to avoid interleaved reads/writes on the socket.
        self._lock = threading.Lock()

    def _execute(self, query: str, params=None):
        with self._lock:
            if params is None:
                return self.client.execute(query)
            return self.client.execute(query, params)

    @staticmethod
    def _escape_string(value: str) -> str:
        """Escape a string for safe inline embedding in a ClickHouse query literal.

        clickhouse_driver's dict `params` on execute() for SELECT queries both
        substitutes %(name)s AND re-sends the same dict to the server as custom
        query settings, which errors on plain int/str values (Code: 26). So we
        escape and inline values ourselves instead of relying on that path.
        """
        escaped = value.replace('\\', '\\\\').replace("'", "\\'")
        return f"'{escaped}'"

    @staticmethod
    def _safe_float(val: Any) -> Optional[float]:
        """Convert value to float safely, returning None if conversion fails."""
        if val is None:
            return None
        try:
            return float(val)
        except (ValueError, TypeError):
            return None

    def fetch_jpl_master(self) -> List[JPLMaster]:
        query = f"SELECT function_loc, ba, latitude, longitude, descript FROM {Config.CH_JPL_DATABASE}.{Config.CH_JPL_TABLE}"
        rows = self._execute(query)
        result = []
        for row in rows:
            lat = row[2]
            lon = row[3]
            if lat is None or lon is None:
                continue
            if isinstance(lat, str) and lat.strip().upper() in ('', 'EMPTY', 'NULL'):
                continue
            if isinstance(lon, str) and lon.strip().upper() in ('', 'EMPTY', 'NULL'):
                continue
            try:
                lat_f = float(lat)
                lon_f = float(lon)
            except (ValueError, TypeError):
                continue
            result.append(JPLMaster(
                function_loc=row[0],
                ba=row[1],
                latitude=lat_f,
                longitude=lon_f,
                descript=row[4]
            ))
        return result

    def insert_panic_event(self, event: dict):
        """Insert incoming panic event into ClickHouse table safely."""
        try:
            query = f"""
                INSERT INTO {Config.CH_DATABASE}.{Config.CH_TABLE}
                (id, event_time, event_type, device_id, funcloc)
                VALUES
            """
            data = [{
                'id': str(event.get('eventId', uuid.uuid4())),
                'event_time': datetime.now(),
                'event_type': str(event.get('eventType', '')),
                'device_id': str(event.get('deviceId', '')),
                'funcloc': str(event.get('jplId', ''))
            }]
            self._execute(query, data)
        except Exception as e:
            logger.error(f"Failed to insert panic event into ClickHouse: {e}")

    def fetch_logs(self, jpl_id: Optional[str] = None, limit: int = 50, offset: int = 0):
        """Fetch paginated panic event logs, safely escaped against SQL injection."""
        query = (
            f"SELECT id, event_time, event_type, trigger_type, device_id, "
            f"funcloc, jpl_lat, jpl_lon, vtdid, loco_lat, loco_lon, distance_m, "
            f"previous_alert, alert_changed, release_count, loco_speed, loco_location "
            f"FROM {Config.CH_DATABASE}.{Config.CH_TABLE}"
        )
        if jpl_id:
            query += f" WHERE funcloc = {self._escape_string(jpl_id)}"
        query += f" ORDER BY event_time DESC LIMIT {int(limit)} OFFSET {int(offset)}"
        return self._execute(query)

    def count_alerts_today(self) -> int:
        """Count panic-press events recorded today (server-local date) — the 'Alert Hari Ini' stat, resets daily via toDate()."""
        query = (
            f"SELECT count() FROM {Config.CH_DATABASE}.{Config.CH_TABLE} "
            f"WHERE event_type != 'RELEASE' AND toDate(event_time) = today()"
        )
        rows = self._execute(query)
        return int(rows[0][0]) if rows else 0