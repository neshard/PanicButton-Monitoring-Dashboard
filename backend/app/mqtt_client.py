import json
import uuid
import paho.mqtt.client as mqtt
import logging
from typing import Callable
from .config import Config

logger = logging.getLogger(__name__)

class MQTTClientManager:
    def __init__(self, on_message_callback: Callable):
        self.on_message_callback = on_message_callback

        # Generate unique Client IDs to prevent Mosquitto disconnecting duplicate sessions on restart
        suffix = str(uuid.uuid4())[:6]
        
        self.locotrack_client = self._create_client(
            Config.LOCOTRACK_HOST, Config.LOCOTRACK_PORT,
            Config.LOCOTRACK_USERNAME, Config.LOCOTRACK_PASSWORD,
            f"{Config.LOCOTRACK_CLIENT_ID}-{suffix}",
            Config.LOCOTRACK_TOPIC
        )
        self.panic_client = self._create_client(
            Config.PANIC_HOST, Config.PANIC_PORT,
            Config.PANIC_USERNAME, Config.PANIC_PASSWORD,
            f"{Config.PANIC_CLIENT_ID}-{suffix}",
            Config.PANIC_TOPIC_EVENT
        )
        self.led_client = self._create_client(
            Config.LED_HOST, Config.LED_PORT,
            Config.LED_USERNAME, Config.LED_PASSWORD,
            f"{Config.LED_CLIENT_ID}-{suffix}",
            Config.LED_TOPIC_TPL,
            qos=Config.LED_QOS
        )

        self.clients = [self.locotrack_client, self.panic_client, self.led_client]

    def _create_client(self, host, port, username, password, client_id, topic, qos=1):
        client = mqtt.Client(client_id=client_id, clean_session=True)
        if username:
            client.username_pw_set(username, password)

        # Handle subscriptions automatically upon connection & reconnection
        def on_connect(c, userdata, flags, rc):
            if rc == 0:
                logger.info(f"MQTT Connected ({client_id}) -> Subscribing to {topic}")
                c.subscribe(topic, qos=qos)
            else:
                logger.error(f"MQTT Connect failed ({client_id}) with code {rc}")

        client.on_connect = on_connect
        client.on_message = self._on_message
        
        try:
            client.connect(host, port, keepalive=60)
        except Exception as e:
            logger.error(f"Failed to connect MQTT client ({client_id}): {e}")

        return client

    def _on_message(self, client, userdata, msg):
        topic = msg.topic
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
        except Exception as e:
            logger.error(f"Failed to parse JSON from {topic}: {e}")
            return

        payload['_topic'] = topic

        # Extract vtdid if topic matches LED format
        if 'led' in topic:
            parts = topic.split('/')
            if len(parts) > 0:
                payload['vtdid'] = parts[-1]

        self.on_message_callback(payload)

    def start(self):
        for client in self.clients:
            client.loop_start()

    def stop(self):
        for client in self.clients:
            client.loop_stop()
            client.disconnect()