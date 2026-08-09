import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # MQTT Locotrack
    LOCOTRACK_HOST = os.getenv("LOCOTRACK_HOST")
    LOCOTRACK_PORT = int(os.getenv("LOCOTRACK_PORT", 1883))
    LOCOTRACK_USERNAME = os.getenv("LOCOTRACK_USERNAME", "")
    LOCOTRACK_PASSWORD = os.getenv("LOCOTRACK_PASSWORD", "")
    LOCOTRACK_TOPIC = os.getenv("LOCOTRACK_TOPIC")
    LOCOTRACK_CLIENT_ID = os.getenv("LOCOTRACK_CLIENT_ID", "backend-locotrack")

    # MQTT Panic
    PANIC_HOST = os.getenv("PANIC_HOST")
    PANIC_PORT = int(os.getenv("PANIC_PORT", 1883))
    PANIC_USERNAME = os.getenv("PANIC_USERNAME", "")
    PANIC_PASSWORD = os.getenv("PANIC_PASSWORD", "")
    PANIC_CLIENT_ID = os.getenv("PANIC_CLIENT_ID", "backend-panic")
    PANIC_TOPIC_EVENT = os.getenv("PANIC_TOPIC_EVENT")

    # MQTT LED
    LED_HOST = os.getenv("LED_HOST")
    LED_PORT = int(os.getenv("LED_PORT", 1883))
    LED_USERNAME = os.getenv("LED_USERNAME", "")
    LED_PASSWORD = os.getenv("LED_PASSWORD", "")
    LED_CLIENT_ID = os.getenv("LED_CLIENT_ID", "backend-led")
    LED_TOPIC_TPL = os.getenv("LED_TOPIC_TPL")   # e.g., "kai/erka/led/+"
    LED_QOS = int(os.getenv("LED_QOS", 1))

    # ClickHouse
    CH_HOST = os.getenv("CH_HOST")
    CH_PORT = int(os.getenv("CH_PORT", 8123))
    CH_USERNAME = os.getenv("CH_USERNAME", "default")
    CH_PASSWORD = os.getenv("CH_PASSWORD", "")
    CH_DATABASE = os.getenv("CH_DATABASE", "railway")
    CH_TABLE = os.getenv("CH_TABLE", "panic_events")
    CH_JPL_DATABASE = os.getenv("CH_JPL_DATABASE", "railway")
    CH_JPL_TABLE = os.getenv("CH_JPL_TABLE", "jpl_master")
    DEVICE_SOURCE = os.getenv("DEVICE_SOURCE", "")

    # API
    API_HOST = os.getenv("API_HOST", "0.0.0.0")
    API_PORT = int(os.getenv("API_PORT", 8000))