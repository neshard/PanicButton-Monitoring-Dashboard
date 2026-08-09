import json
import paho.mqtt.client as mqtt
import logging
from typing import Callable
from .config import Config

logger = logging.getLogger(__name__)

class MQTTClientManager:
    def __init__(self, on_message_callback: Callable):
        self.on_message_callback = on_message_callback
        self.clients = []

        # Create clients for each subscription
        self.locotrack_client = self._create_client(
            Config.LOCOTRACK_HOST, Config.LOCOTRACK_PORT,
            Config.LOCOTRACK_USERNAME, Config.LOCOTRACK_PASSWORD,
            Config.LOCOTRACK_CLIENT_ID
        )
        self.panic_client = self._create_client(
            Config.PANIC_HOST, Config.PANIC_PORT,
            Config.PANIC_USERNAME, Config.PANIC_PASSWORD,
            Config.PANIC_CLIENT_ID
        )
        self.led_client = self._create_client(
            Config.LED_HOST, Config.LED_PORT,
            Config.LED_USERNAME, Config.LED_PASSWORD,
            Config.LED_CLIENT_ID
        )

        # Set up callbacks
        self.locotrack_client.message_callback_add(Config.LOCOTRACK_TOPIC, self._on_message)
        self.panic_client.message_callback_add(Config.PANIC_TOPIC_EVENT, self._on_message)
        self.led_client.message_callback_add(Config.LED_TOPIC_TPL, self._on_message)

        # --- IMPORTANT: Subscribe to topics ---
        self.locotrack_client.subscribe(Config.LOCOTRACK_TOPIC, qos=1)
        self.panic_client.subscribe(Config.PANIC_TOPIC_EVENT, qos=1)
        self.led_client.subscribe(Config.LED_TOPIC_TPL, qos=Config.LED_QOS)

        self.clients = [self.locotrack_client, self.panic_client, self.led_client]

    def _create_client(self, host, port, username, password, client_id):
        client = mqtt.Client(client_id=client_id, clean_session=True)
        if username:
            client.username_pw_set(username, password)
        client.connect(host, port, keepalive=60)
        return client

    def _on_message(self, client, userdata, msg):
        topic = msg.topic
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
        except Exception as e:
            logger.error(f"Failed to parse JSON from {topic}: {e}")
            return

        payload['_topic'] = topic

        # For LED, extract vtdid from topic
        if topic.startswith(Config.LED_TOPIC_TPL.replace('+', '')):
            parts = topic.split('/')
            if len(parts) > 0:
                vtdid = parts[-1]
                payload['vtdid'] = vtdid

        # Broadcast via callback
        self.on_message_callback(payload)

    def start(self):
        for client in self.clients:
            client.loop_start()

    def stop(self):
        for client in self.clients:
            client.loop_stop()
            client.disconnect()