import logging
import threading
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
            database=Config.CH_DATABASE,
            settings={'max_execution_time': 10}  # 10 second query timeout
        )
        # clickhouse_driver.Client wraps a single TCP connection and is not
        # thread-safe, and _execute() can be called concurrently from multiple
        # FastAPI threadpool threads (asyncio.to_thread), so serialize access
        # to avoid interleaved reads/writes on the socket.
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

    def fetch_logs(self, jpl_id: Optional[str] = None, limit: int = 50, offset: int = 0):
        """Fetch paginated panic event logs, safely escaped against SQL injection.

        Uses last 7 days instead of today() to avoid timezone mismatch issues.
        Shows all event types (including releases) for complete history.
        """
        query = (
            f"SELECT id, event_time, event_type, trigger_type, device_id, "
            f"funcloc, jpl_lat, jpl_lon, vtdid, loco_lat, loco_lon, distance_m, "
            f"previous_alert, alert_changed, release_count, loco_speed, loco_location "
            f"FROM {Config.CH_DATABASE}.{Config.CH_TABLE}"
        )
        # Use last 7 days to avoid timezone mismatch with today()
        conditions = ["event_time >= now() - INTERVAL 7 DAY"]
        
        if jpl_id:
            conditions.append(f"funcloc = {self._escape_string(jpl_id)}")
        
        query += " WHERE " + " AND ".join(conditions)
        query += f" ORDER BY event_time DESC LIMIT {int(limit)} OFFSET {int(offset)}"
        logger.info(f"Executing logs query: {query}")
        return self._execute(query)

    # event_type values seen in the wild aren't a strict PBPRESSED/PBRELEASED binary —
    # the live device feed actually records 'release', 'bahaya', 'perhatian' (lowercase,
    # Indonesian). Match release-type events by name (case-insensitive) instead of a
    # single exact string, so both the real data and PBPRESSED/PBRELEASED-style feeds work.
    _RELEASE_EVENT_TYPES = ("'release'", "'pbrelease'", "'pbreleased'", "'aman'", "'safe'")

    def fetch_weekly_jpl_activity(self, start: Optional[str] = None, end: Optional[str] = None):
        """Per-funcloc event counts for the JPL-Aktif-per-DAOP summary tab, over an
        inclusive [start, end] date range ('YYYY-MM-DD' strings, already validated by
        the caller) — or the last 7 days if no range is given. 'pressed_count' excludes
        release-type events so the frontend can distinguish real panic-button
        activations from routine releases."""
        release_list = ", ".join(self._RELEASE_EVENT_TYPES)
        query = (
            f"SELECT funcloc, count() AS event_count, "
            f"countIf(lower(event_type) NOT IN ({release_list})) AS pressed_count, "
            f"max(event_time) AS last_event "
            f"FROM {Config.CH_DATABASE}.{Config.CH_TABLE} "
        )
        if start and end:
            conditions = [
                f"event_time >= {self._escape_string(start)}",
                f"event_time < {self._escape_string(end)} + INTERVAL 1 DAY",
            ]
        else:
            conditions = ["event_time >= now() - INTERVAL 7 DAY"]
        query += "WHERE " + " AND ".join(conditions)
        query += " GROUP BY funcloc ORDER BY pressed_count DESC"
        return self._execute(query)

    def fetch_logs_range(self, start: str, end: str, jpl_id: Optional[str] = None):
        """Fetch ALL panic event logs within an inclusive [start, end] date range
        (both 'YYYY-MM-DD' strings, already validated by the caller) — used for the
        Excel export, so unlike fetch_logs() this has no LIMIT/OFFSET pagination
        (beyond a defensive cap) and no fixed 7-day window."""
        query = (
            f"SELECT id, event_time, event_type, trigger_type, device_id, "
            f"funcloc, jpl_lat, jpl_lon, vtdid, loco_lat, loco_lon, distance_m, "
            f"previous_alert, alert_changed, release_count, loco_speed, loco_location "
            f"FROM {Config.CH_DATABASE}.{Config.CH_TABLE}"
        )
        conditions = [
            f"event_time >= {self._escape_string(start)}",
            f"event_time < {self._escape_string(end)} + INTERVAL 1 DAY",
        ]
        if jpl_id:
            conditions.append(f"funcloc = {self._escape_string(jpl_id)}")
        query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY event_time DESC LIMIT 100000"
        logger.info(f"Executing export logs query: {query}")
        return self._execute(query)

    def count_alerts_today(self) -> int:
        """Count panic-press events recorded today (server-local date) — the 'Alert Hari Ini' stat, resets daily via toDate()."""
        release_list = ", ".join(self._RELEASE_EVENT_TYPES)
        query = (
            f"SELECT count() FROM {Config.CH_DATABASE}.{Config.CH_TABLE} "
            f"WHERE lower(event_type) NOT IN ({release_list}) AND toDate(event_time) = today()"
        )
        rows = self._execute(query)
        return int(rows[0][0]) if rows else 0

    def count_jpl_active_today(self) -> int:
        """Count JPLs whose latest event today is still a press/danger event (not yet released) —
        the 'JPL Aktif' stat, sourced from the DB log (today only) so it stays accurate
        even if the backend's in-memory alert state was lost (e.g. after a restart)."""
        # Legacy reference logic: Active JPLs = JPLs whose latest event today is
        # not a release event. The live dashboard now counts active JPLs from its
        # PBPRESSED/PBRELEASED state instead of using this database-based count.
        release_list = ", ".join(self._RELEASE_EVENT_TYPES)
        query = (
            f"SELECT count() FROM ("
            f"  SELECT funcloc, argMax(event_type, event_time) AS last_type "
            f"  FROM {Config.CH_DATABASE}.{Config.CH_TABLE} "
            f"  WHERE toDate(event_time) = today() "
            f"  GROUP BY funcloc"
            f") WHERE lower(last_type) NOT IN ({release_list})"
        )
        rows = self._execute(query)
        return int(rows[0][0]) if rows else 0