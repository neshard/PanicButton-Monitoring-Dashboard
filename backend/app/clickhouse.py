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
            # Skip if lat or lon is None, or string 'EMPTY' or empty
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