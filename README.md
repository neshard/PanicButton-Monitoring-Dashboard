# Railway Panic Button Monitoring System

A real‑time monitoring dashboard for railway crossings with panic button alerts, live train tracking, and LED status visualisation.

## Features

- **Live map** with moving train markers (coloured by LED status)
- **JPL crossings** with pulse animations and radius circles on panic
- **Left sidebar** with three tabs:
  - **JPL** – list of crossings, PBPRESSED sorted to top
  - **Kereta (Train)** – list of trains, sorted by danger level (Bahaya > Hati‑hati > Aman)
  - **Event Log** – complete panic event history (latest first), with shortened ID
- **Resizable sidebar** (drag right edge)
- **Alert stack** on the right – shows each panic with caught trains dropdown, auto‑closes after 10s
- **Dark theme** for sidebar, light map background

## Technology Stack

- **Backend**: Python (FastAPI), Paho MQTT, ClickHouse
- **Frontend**: Vanilla JavaScript, Leaflet.js, WebSocket
- **Broker**: Mosquitto (dummy) via Docker
- **Database**: ClickHouse (stores panic events and JPL master)

## Prerequisites

- Python 3.10+
- Docker & Docker Compose
- Node.js (optional, for a local HTTP server)
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
├── docker-compose.yml # Dummy Mosquitto broker
└── README.md

## Setup Instructions

### 1. Clone the repository
```bash
git clone <your-repo-url>
cd railway-panic-monitor

### 2. Configure environment variables
Copy .env.example to backend/.env and fill in your actual credentials

For testing with the dummy broker, set LOCOTRACK_HOST to 127.0.0.1 and LOCOTRACK_PORT to 1884 as well.

### 3. Start the dummy MQTT broker (optional)
If you don't have a real broker, start the dummy Mosquitto:
```bash
docker-compose up -d

This exposes port 1884 on your host.

### 4. Install backend dependencies
```bash
cd backend
python -m venv venv
source venv/bin/activate   # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt

### 5. Run the backend
```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

The backend will:
- Connect to MQTT brokers and subscribe to topics
- Store panic events into ClickHouse
- Broadcast real‑time data via WebSocket on ws://localhost:8000/ws
- Serve REST endpoints at http://localhost:8000/api/...

### 6. (Optional) Run the dummy simulator
If you want to generate fake train data, panic events, and LED updates:
```bash
cd simulator
python mqtt_simulator.py

Make sure the simulator’s broker settings point to the same dummy broker.

### 7. Serve the frontend
Open the frontend/index.html file directly in your browser, or use a simple HTTP server:
```bash
cd frontend
python -m http.server 8080

Then visit http://localhost:8080.
The frontend will automatically connect to the backend via WebSocket and display the map with live data.