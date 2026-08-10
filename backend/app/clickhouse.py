import uuid
from datetime import datetime
from typing import List, Dict, Any, Optional
from clickhouse_driver import Client
from .config import Config
from .models import JPLMaster

class ClickHouseDB:
    def __init__(self):
        self.client = Client(
            host=Config.CH_HOST,
            port=9000,   # native TCP
            user=Config.CH_USERNAME,
            password=Config.CH_PASSWORD,
            database=Config.CH_DATABASE
        )

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
        rows = self.client.execute(query)
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
            self.client.execute(query, data)
        except Exception as e:
            print(f"Failed to insert panic event into ClickHouse: {e}")