import paho.mqtt.client as mqtt
import json
import random
import time
import math
from datetime import datetime, timedelta

# Dummy broker config (match docker-compose)
BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1884
USERNAME = ""
PASSWORD = ""

# Topics
LOCOTRACK_TOPIC = "kai/erka/locotrack"   # single topic
PANIC_TOPIC = "kai/erka/panicButton/dummy"
LED_TOPIC_BASE = "kai/erka/led/"

# Generate 300 train IDs
TRAIN_IDS = [f"S{str(i).zfill(4)}" for i in range(1, 301)]  # e.g., S0001

# Bounding box for trains (Java area)
LAT_MIN, LAT_MAX = -8.77, -5.91
LON_MIN, LON_MAX = 105.12, 114.59

# JPL crossings (we'll pick a few)
JPL_IDS = ["HAG10075", "HAG60221", "HAG30345", "HAG40567"]

def random_location():
    lat = random.uniform(LAT_MIN, LAT_MAX)
    lon = random.uniform(LON_MIN, LON_MAX)
    return lat, lon

def generate_train_data(train_id, lat, lon, speed, heading):
    return {
        "ARRIVED": "N",
        "L_SARANA": "xx",
        "L_KERETA": "xx",
        "L_SOURCE": "actual",
        "L_DATATYPE": "NSF00",
        "L_VTDID": train_id,
        "L_LON": f"{lon:.6f}",
        "L_LAT": f"{lat:.6f}",
        "L_DATETIME": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "L_SPEED": f"{speed:.2f}",
        "L_HEADING": heading,
        "L_ENGINE": "1",
        "L_LOCATION": f"SIM-{random.randint(100,200)}",
        "L_PROPINSI": "xx",
        "L_KABUPATEN": "xx",
        "L_KECAMATAN": "xx",
        "L_STATUS_LOCO": "xx",
        "L_STATUS_ODOMETER": random.uniform(1000000, 2000000),
        "L_STATUS_HOUROFF": random.uniform(200000, 300000),
        "L_STATUS_HOURIDLE": random.uniform(400000, 500000),
        "L_STATUS_HOURRUN": random.uniform(300000, 400000),
        "tTime": 0.4167,
        "PersistAction": "update",
        "L_RECEIVED_DATE": datetime.now().isoformat() + "Z",
        "L_KELOMPOK_GPS": "JAWA"
    }

def generate_panic_event(jpl_id):
    now = datetime.now().isoformat()
    event_id = f"{jpl_id}_{now.replace('-','')[:8]}_{now.replace(':','')[:15]}"
    return {
        "deviceId": "SIM_DEVICE",
        "jplId": jpl_id,
        "datetime": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+07:00"),
        "eventId": event_id,
        "eventType": random.choice(["PBPRESSED", "RELEASE"])
    }

def generate_led_status(vtdid):
    # simulate red/yellow/buzzer
    led_merah = random.choice(["0", "1"])
    led_kuning = random.choice(["0", "1"])
    buzzer = random.choice(["1", "2"])
    return {
        "ledMerah": led_merah,
        "ledKuning": led_kuning,
        "buzzer": buzzer
    }

def main():
    client = mqtt.Client(client_id="simulator")
    if USERNAME:
        client.username_pw_set(USERNAME, PASSWORD)
    client.connect(BROKER_HOST, BROKER_PORT)
    client.loop_start()

    # Initialize train positions with random movement
    trains = {}
    for train_id in TRAIN_IDS:
        lat, lon = random_location()
        speed = random.uniform(20, 60)
        heading = random.randint(0, 359)
        trains[train_id] = {'lat': lat, 'lon': lon, 'speed': speed, 'heading': heading}

    print("Simulator started. Press Ctrl+C to stop.")

    try:
        while True:
            # Update each train with slight random movement
            for train_id, data in trains.items():
                # Simple random walk
                delta_lat = random.uniform(-0.001, 0.001)
                delta_lon = random.uniform(-0.001, 0.001)
                new_lat = data['lat'] + delta_lat
                new_lon = data['lon'] + delta_lon
                # Keep within bounds
                if new_lat < LAT_MIN: new_lat = LAT_MIN
                if new_lat > LAT_MAX: new_lat = LAT_MAX
                if new_lon < LON_MIN: new_lon = LON_MIN
                if new_lon > LON_MAX: new_lon = LON_MAX
                # Update speed/heading slightly
                speed = max(10, min(80, data['speed'] + random.uniform(-2, 2)))
                heading = (data['heading'] + random.randint(-10, 10)) % 360
                data['lat'] = new_lat
                data['lon'] = new_lon
                data['speed'] = speed
                data['heading'] = heading

                # Publish train data
                train_payload = generate_train_data(train_id, new_lat, new_lon, speed, heading)
                client.publish(LOCOTRACK_TOPIC, json.dumps(train_payload), qos=1)
                # Publish LED for this train (randomly)
                if random.random() < 0.1:  # 10% chance per train per cycle
                    led_payload = generate_led_status(train_id)
                    led_topic = f"{LED_TOPIC_BASE}{train_id}"
                    client.publish(led_topic, json.dumps(led_payload), qos=1)

            # Random panic button press (occasionally)
            if random.random() < 0.05:  # 5% chance per loop
                jpl = random.choice(JPL_IDS)
                panic_payload = generate_panic_event(jpl)
                client.publish(PANIC_TOPIC, json.dumps(panic_payload), qos=1)

            time.sleep(2)  # update every 2 seconds (faster than 5s for demo)
    except KeyboardInterrupt:
        print("Stopping simulator...")
    finally:
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()