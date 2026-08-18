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
    eventType: str   # PBPRESSED or PBRELEASED

class HealthStatus(BaseModel):
    deviceId: Optional[str] = None
    jplId: Optional[str] = None
    funcloc: Optional[str] = None
    status: Optional[str] = None
    power: Optional[str] = None
    powerType: Optional[str] = None
    batteryVoltage: Optional[float] = None
    batteryPercentage: Optional[float] = None
    batteryPersentage: Optional[float] = None
    batteryCharging: Optional[bool] = None
    gsmNumber: Optional[str] = None
    signalStrength: Optional[str] = None
    datetime: Optional[str] = None

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