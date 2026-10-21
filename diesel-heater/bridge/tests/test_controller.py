import json
import time

from aiohttp.test_utils import TestClient, TestServer

from heaterbridge import protocol as p
from heaterbridge.controller import Controller
from heaterbridge.mqtt_ha import MqttBridge
from heaterbridge.thermostat import Thermostat
from heaterbridge.web import make_app


class FakeHeater:
    """Stands in for heater.Heater; executes commands instantly."""

    def __init__(self):
        self.connected = True
        self.device_name = "BYD-TEST"
        self.last_update = time.time()
        self.commands = []
        self._cbs = []
        self.status = self._status(False, "standby", 5)

    @staticmethod
    def _status(running, step, level, room=15.0):
        return p.HeaterStatus("AA55", running, step, "level", level, None, room, 20.0, 12.6, 0.0, 0, None)

    def on_status(self, cb):
        self._cbs.append(cb)

    def push(self, **kw):
        s = self.status
        self.status = p.HeaterStatus(**{**s.__dict__, **kw})
        self.last_update = time.time()
        for cb in self._cbs:
            cb(self.status)

    async def set_power(self, on):
        self.commands.append(("power", on))
        self.push(running=on, running_step="ignition" if on else "cooldown")

    async def set_level(self, level):
        self.commands.append(("level", level))
        self.push(level=level, running_mode="level")


def make(tmp_path=None):
    h = FakeHeater()
    return h, Controller(h, Thermostat(), state_file=tmp_path / "s.json" if tmp_path else None)


async def test_manual_on_level_off():
    h, c = make()
    await c._tick()
    assert h.commands == []  # nothing requested, stays off

    c.set_level(7)
    c.set_enabled(True)
    await c._tick()
    assert ("power", True) in h.commands
    h.push(running_step="running")
    await c._tick()
    assert h.commands[-1] == ("level", 7)

    c.set_enabled(False)
    await c._tick()
    assert h.commands[-1] == ("power", False)


async def test_external_power_change_is_adopted():
    h, c = make()
    await c._tick()
    h.push(running=True, running_step="ignition")  # someone used the panel
    await c._tick()
    assert c.enabled and h.commands == []
    h.push(running=False, running_step="cooldown")
    await c._tick()
    assert not c.enabled and h.commands == []


async def test_panel_level_change_adopted_in_manual():
    h, c = make()
    c.set_level(4)
    c.set_enabled(True)
    await c._tick()
    h.push(running_step="running")
    await c._tick()
    c._last_level_cmd = 0  # pretend our command was long ago
    h.push(level=8)
    await c._tick()
    assert c.manual_level == 8


async def test_no_restart_during_cooldown_and_fault_stops_commands():
    h, c = make()
    h.push(running=False, running_step="cooldown")
    c._prev_on = False
    c.set_enabled(True)
    await c._tick()
    assert h.commands == []
    h.push(running_step="standby", error_code=8, error="E8 ignition unit")
    await c._tick()
    assert h.commands == [] and c.fault == "E8 ignition unit"


async def test_thermostat_mode_uses_heater_sensor():
    h, c = make()
    c.set_target(21)
    assert c.mode == "thermostat"
    c.set_enabled(True)
    await c._tick()  # room 15 °C -> start
    assert h.commands[-1] == ("power", True)


async def test_state_persisted(tmp_path):
    h, c = make(tmp_path)
    c.set_target(18.5)
    c.set_level(3)
    _, c2 = make(tmp_path)
    assert c2.thermostat.target == 18.5 and c2.manual_level == 3 and c2.mode == "manual"
    assert not c2.enabled


async def test_web_api():
    h, c = make()
    async with TestClient(TestServer(make_app(c, token="t"))) as client:
        await _web_checks(client)


async def _web_checks(client):
    assert (await client.get("/api/state")).status == 401
    hdr = {"Authorization": "Bearer t"}
    r = await client.post("/api/level", json={"level": 6}, headers=hdr)
    assert r.status == 200 and (await r.json())["manual_level"] == 6
    r = await client.post("/api/power", json={"on": True}, headers=hdr)
    assert (await r.json())["enabled"] is True
    assert (await client.post("/api/mode", json={"mode": "nope"}, headers=hdr)).status == 400
    assert (await client.post("/api/level", json={}, headers=hdr)).status == 400
    assert (await client.get("/")).status == 200


def test_mqtt_discovery_and_commands():
    h, c = make()
    m = MqttBridge(c, "localhost", external_temp_topic="z2m/sensor")
    msgs = dict(m.discovery_messages())
    climate = msgs["homeassistant/climate/dieselheater_climate/config"]
    assert climate["temperature_command_topic"] == "dieselheater/set/target"
    assert all(json.dumps(v) for v in msgs.values())

    m.handle("dieselheater/set/level", "8")
    assert c.manual_level == 8 and c.mode == "manual"
    m.handle("dieselheater/set/hvac_mode", "heat")
    assert c.enabled
    m.handle("dieselheater/set/target", "19.5")
    assert c.mode == "thermostat" and c.thermostat.target == 19.5
    m.handle("z2m/sensor", '{"temperature": 17.2, "humidity": 40}')
    assert c.external_temp == 17.2
    m.handle("dieselheater/set/enabled", "OFF")
    assert not c.enabled
