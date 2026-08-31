# Railway Panic Button Monitoring System

A real‑time monitoring dashboard for railway crossings with panic button alerts, live train tracking, and LED status visualisation.

## Features

- **High-Performance Live Map** powered by MapLibre GL JS with moving train markers (coloured by LED status)
- **Offline Neon Railway Lines** rendered via static GeoJSON for instant loading, zero API lag, and a glowing visual effect
- **JPL Crossings** with smooth CSS-based pulse animations and dynamic radius circles on panic events
- **Left sidebar** with three tabs:
  - **JPL** – list of crossings, PBPRESSED sorted to top
  - **Kereta (Train)** – list of trains, sorted by danger level (Bahaya > Hati‑hati > Aman)
  - **Event Log** – complete panic event history (latest first), with shortened ID
- **Resizable sidebar** (drag right edge)
- **Alert stack** on the right – shows each panic with caught trains, auto‑closes after 10s
- **Resilient Backend** that gracefully degrades and serves the UI even if the database or MQTT broker is temporarily offline
- **Unified Dark Theme** for both the sidebar and the map background (CARTO Dark Matter) to make the neon railways pop

## Technology Stack

- **Backend**: Python (FastAPI), Paho MQTT, ClickHouse
- **Frontend**: Vanilla JavaScript, MapLibre GL JS, WebSocket
- **Broker**: Mosquitto (dummy) via Docker
- **Database**: ClickHouse (stores panic events and JPL master)

## Prerequisites

- Python 3.10+
- Docker & Docker Compose
- MQTT broker credentials (or use the included dummy broker)

## Project Structure
railway-panic-monitor/
├── backend/
│ ├── app/
│ │ ├── init.py
│ │ ├── main.py # FastAPI + WebSocket + MQTT handling
│ │ ├── mqtt_client.py # MQTT subscribers
│ │ ├── clickhouse.py # DB queries & inserts
│ │ ├── models.py # Pydantic schemas
│ │ └── config.py # Environment variables
│ ├── requirements.txt
│ └── .env # Your credentials
├── frontend/
│ ├── index.html
│ ├── style.css
│ └── script.js
├── simulator/
│ └── mqtt_simulator.py # Dummy data publisher
├── static/
│ └── railway.geojson
├── docker-compose.yml # Dummy Mosquitto broker
└── README.md

---

## Setup Instructions

### 1. Environment variables 
Copy `.env.example` to `backend/.env` and fill in your actual credentials. if not done yet

For testing with the dummy local broker, set `LOCOTRACK_HOST` to `127.0.0.1` and `LOCOTRACK_PORT` to `1884`.

### 2. Start the dummy MQTT broker (optional)
If you don't have a real broker available, start the dummy Mosquitto broker via Docker:
```bash
docker-compose up -d
```
*This exposes port 1884 on your host machine.*

### 3. Install backend dependencies
```bash
cd backend
python -m venv venv
source venv/bin/activate   # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt
```

### 4. Run the backend
```bash
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```
The backend will:
- Connect to MQTT brokers and subscribe to topics (if available).
- Store panic events into ClickHouse (if available).
- Broadcast real‑time data via WebSocket on `ws://localhost:8000/ws`.
- Serve REST endpoints at `http://localhost:8000/api/...`.
- **Serve the Frontend UI directly at `http://localhost:8000`.**

### 5. Access the Dashboard
Simply open your web browser and navigate to:
```text
http://localhost:8000
```
*No separate frontend server (like Live Server or `python -m http.server`) is required. FastAPI handles serving the HTML, CSS, JS, and GeoJSON files automatically.*

### 6. (Optional) Run the dummy simulator
If you want to generate fake train data, panic events, and LED updates to test the WebSocket streaming:
```bash
cd simulator
python mqtt_simulator.py
```
*Make sure the simulator’s broker settings point to the same dummy broker.*