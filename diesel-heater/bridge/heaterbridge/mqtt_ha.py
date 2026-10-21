"""MQTT bridge with Home Assistant auto-discovery.

Creates one HA device with: a climate entity (off/heat + target temp,
presets manual/thermostat), a power switch, a level number, a mode select
and diagnostic sensors. Works with any MQTT-capable platform (Home Assistant,
openHAB, Node-RED, Homey ...) via the plain topics too.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

import aiomqtt

from .controller import Controller

log = logging.getLogger(__name__)


class MqttBridge:
    def __init__(self, ctl: Controller, host: str, port: int = 1883, username: str | None = None,
                 password: str | None = None, base_topic: str = "dieselheater",
                 discovery_prefix: str = "homeassistant", device_id: str = "dieselheater",
                 external_temp_topic: str | None = None, external_temp_field: str = "temperature"):
        self.ctl = ctl
        self.host, self.port = host, port
        self.username, self.password = username, password
        self.base = base_topic.rstrip("/")
        self.disc = discovery_prefix
        self.dev_id = re.sub(r"[^a-zA-Z0-9_]", "_", device_id)
        self.ext_topic = external_temp_topic
        self.ext_field = external_temp_field
        self._dirty = asyncio.Event()
        ctl.subscribe(self._dirty.set)

    # ---- discovery -------------------------------------------------------

    def _device(self) -> dict:
        return {"identifiers": [self.dev_id], "name": "Diesel heater", "manufacturer": "Vevor",
                "model": "AirHeaterBLE (via heaterbridge)"}

    def discovery_messages(self) -> list[tuple[str, dict]]:
        b, st = self.base, f"{self.base}/state"
        common = {"device": self._device(), "availability_topic": f"{b}/availability"}

        def ent(component: str, key: str, cfg: dict) -> tuple[str, dict]:
            uid = f"{self.dev_id}_{key}"
            return (f"{self.disc}/{component}/{uid}/config",
                    {**common, "unique_id": uid, "state_topic": st, **cfg})

        sensor_cfg = [
            ("temperature", "Control temperature", "{{ value_json.temperature }}", "temperature", "°C"),
            ("room_temp", "Heater sensor temperature", "{{ value_json.heater.room_temp if value_json.heater else none }}", "temperature", "°C"),
            ("case_temp", "Heat exchanger temperature", "{{ value_json.heater.case_temp if value_json.heater else none }}", "temperature", "°C"),
            ("voltage", "Supply voltage", "{{ value_json.heater.voltage if value_json.heater else none }}", "voltage", "V"),
            ("level_actual", "Current level", "{{ value_json.heater.level if value_json.heater else none }}", None, None),
            ("step", "State", "{{ value_json.heater.running_step if value_json.heater else 'disconnected' }}", None, None),
            ("error", "Error", "{{ value_json.fault or (value_json.heater.error if value_json.heater else none) or 'OK' }}", None, None),
            ("decision", "Thermostat decision", "{{ value_json.decision }}", None, None),
        ]
        msgs = [
            ent("climate", "climate", {
                "name": "Heater",
                "modes": ["off", "heat"],
                "mode_state_topic": st,
                "mode_state_template": "{{ 'heat' if value_json.enabled else 'off' }}",
                "mode_command_topic": f"{b}/set/hvac_mode",
                "temperature_state_topic": st,
                "temperature_state_template": "{{ value_json.target }}",
                "temperature_command_topic": f"{b}/set/target",
                "current_temperature_topic": st,
                "current_temperature_template": "{{ value_json.temperature }}",
                "action_topic": st,
                "action_template": "{{ 'off' if not value_json.enabled else ('heating' if value_json.is_on else 'idle') }}",
                "preset_modes": ["manual", "thermostat"],
                "preset_mode_state_topic": st,
                "preset_mode_value_template": "{{ value_json.mode }}",
                "preset_mode_command_topic": f"{b}/set/mode",
                "min_temp": 5, "max_temp": 30, "temp_step": 0.5,
                "temperature_unit": "C",
            }),
            ent("switch", "power", {
                "name": "Power", "icon": "mdi:fire",
                "command_topic": f"{b}/set/enabled",
                "value_template": "{{ 'ON' if value_json.enabled else 'OFF' }}",
            }),
            ent("number", "level", {
                "name": "Level", "icon": "mdi:speedometer",
                "command_topic": f"{b}/set/level",
                "value_template": "{{ value_json.manual_level }}",
                "min": 1, "max": 10, "step": 1, "mode": "slider",
            }),
            ent("select", "mode", {
                "name": "Control mode",
                "command_topic": f"{b}/set/mode",
                "value_template": "{{ value_json.mode }}",
                "options": ["manual", "thermostat"],
            }),
            ent("binary_sensor", "connected", {
                "name": "Bluetooth connected", "device_class": "connectivity", "entity_category": "diagnostic",
                "value_template": "{{ 'ON' if value_json.connected else 'OFF' }}",
            }),
        ]
        for key, name, tpl, dc, unit in sensor_cfg:
            cfg = {"name": name, "value_template": tpl}
            if dc:
                cfg.update(device_class=dc, state_class="measurement")
            if unit:
                cfg["unit_of_measurement"] = unit
            if key in ("voltage", "case_temp", "decision"):
                cfg["entity_category"] = "diagnostic"
            msgs.append(ent("sensor", key, cfg))
        return msgs

    # ---- command handling ------------------------------------------------

    def handle(self, topic: str, payload: str) -> None:
        payload = payload.strip()
        if self.ext_topic and topic == self.ext_topic:
            try:
                val = json.loads(payload)
                if isinstance(val, dict):
                    val = val.get(self.ext_field)
                if val is not None:
                    self.ctl.set_external_temp(float(val))
            except (ValueError, TypeError):
                log.warning("bad external temperature payload: %r", payload)
            return
        cmd = topic.rsplit("/", 1)[-1]
        log.info("MQTT %s = %s", cmd, payload)
        try:
            if cmd == "enabled":
                self.ctl.set_enabled(payload.upper() in ("ON", "1", "TRUE"))
            elif cmd == "hvac_mode":
                self.ctl.set_enabled(payload == "heat")
            elif cmd == "level":
                self.ctl.set_level(round(float(payload)))
            elif cmd == "target":
                self.ctl.set_target(float(payload))
            elif cmd == "mode":
                self.ctl.set_mode(payload)
        except ValueError as e:
            log.warning("bad MQTT command %s=%r: %s", cmd, payload, e)

    # ---- main loop -------------------------------------------------------

    async def run(self) -> None:
        avail = f"{self.base}/availability"
        while True:
            try:
                async with aiomqtt.Client(
                    self.host, self.port, username=self.username, password=self.password,
                    identifier=f"heaterbridge-{self.dev_id}",
                    will=aiomqtt.Will(avail, "offline", retain=True),
                ) as client:
                    log.info("MQTT connected to %s:%d", self.host, self.port)
                    for topic, cfg in self.discovery_messages():
                        await client.publish(topic, json.dumps(cfg), retain=True)
                    await client.publish(avail, "online", retain=True)
                    await client.subscribe(f"{self.base}/set/+")
                    if self.ext_topic:
                        await client.subscribe(self.ext_topic)
                    self._dirty.set()
                    publisher = asyncio.create_task(self._publisher(client))
                    try:
                        async for msg in client.messages:
                            self.handle(str(msg.topic), msg.payload.decode(errors="replace"))
                    finally:
                        publisher.cancel()
            except aiomqtt.MqttError as e:
                log.warning("MQTT error: %s; retrying in 10s", e)
                await asyncio.sleep(10)

    async def _publisher(self, client: aiomqtt.Client) -> None:
        while True:
            try:
                await asyncio.wait_for(self._dirty.wait(), 30)
            except asyncio.TimeoutError:
                pass
            self._dirty.clear()
            await client.publish(f"{self.base}/state", json.dumps(self.ctl.snapshot()), retain=True)
            await asyncio.sleep(1)  # coalesce bursts
