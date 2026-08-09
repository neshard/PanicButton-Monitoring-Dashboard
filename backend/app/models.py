from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class TrainLocation(BaseModel):
    vtdid: str
    lat: float
    lon: float
    speed: float
    heading: int
    location: str
    datetime: str  # or datetime

class PanicEvent(BaseModel):
    deviceId: str
    jplId: str
    datetime: str
    eventId: str
    eventType: str   # PBPRESSED or RELEASE

class LEDStatus(BaseModel):
    vtdid: str          # extracted from topic
    ledMerah: str       # "0" or "1"
    ledKuning: str      # "0" or "1"
    buzzer: str         # "1" or "2"

class JPLMaster(BaseModel):
    function_loc: str
    ba: str
    latitude: Optional[float] = None   # allow None
    longitude: Optional[float] = None
    descript: str