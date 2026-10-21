"""Apple HomeKit accessory (Home app, Siri) via HAP-python.

Exposes a "Heater" (HeaterCooler service):
  Active            -> master power
  Target temp       -> thermostat target (switches to thermostat mode)
  Fan speed slider  -> level 1-10 as 10..100 % (switches to manual mode)
plus a "Smart thermostat" switch to flip between thermostat and manual mode.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from pyhap.accessory import Accessory
from pyhap.accessory_driver import AccessoryDriver
from pyhap.const import CATEGORY_HEATER

from .controller import Controller

log = logging.getLogger(__name__)


class HeaterAccessory(Accessory):
    category = CATEGORY_HEATER

    def __init__(self, driver: AccessoryDriver, ctl: Controller, name: str = "Diesel Heater"):
        super().__init__(driver, name)
        self.ctl = ctl
        self.set_info_service(manufacturer="Vevor", model="AirHeaterBLE", serial_number="heaterbridge")

        svc = self.add_preload_service(
            "HeaterCooler",
            chars=["HeatingThresholdTemperature", "RotationSpeed"],
        )
        self.c_active = svc.configure_char("Active", setter_callback=self._set_active)
        self.c_current_state = svc.configure_char("CurrentHeaterCoolerState")
        # Heat-only device. Set the value first: overriding valid values re-validates it.
        svc.get_characteristic("TargetHeaterCoolerState").set_value(1, should_notify=False)
        svc.configure_char("TargetHeaterCoolerState", valid_values={"Heat": 1}, setter_callback=lambda _v: None)
        self.c_temp = svc.configure_char("CurrentTemperature", properties={"minValue": -40})
        self.c_target = svc.configure_char(
            "HeatingThresholdTemperature", value=ctl.thermostat.target,
            properties={"minValue": 5, "maxValue": 30, "minStep": 0.5},
            setter_callback=lambda v: ctl.set_target(v))
        self.c_speed = svc.configure_char(
            "RotationSpeed", properties={"minValue": 0, "maxValue": 100, "minStep": 10},
            setter_callback=self._set_speed)

        sw = self.add_preload_service("Switch", chars=["Name"])
        sw.configure_char("Name", value="Smart thermostat")
        self.c_thermo = sw.configure_char(
            "On", setter_callback=lambda v: ctl.set_mode("thermostat" if v else "manual"))

        ctl.subscribe(self.refresh)
        self.refresh()

    def _set_active(self, value: int) -> None:
        self.ctl.set_enabled(bool(value))

    def _set_speed(self, value: float) -> None:
        if value <= 0:
            self.ctl.set_enabled(False)
        else:
            self.ctl.set_level(max(1, round(value / 10)))

    def refresh(self) -> None:
        snap = self.ctl.snapshot()
        self.c_active.set_value(1 if snap["enabled"] else 0)
        # 0 inactive, 1 idle, 2 heating
        self.c_current_state.set_value(0 if not snap["enabled"] else (2 if snap["is_on"] else 1))
        if snap["temperature"] is not None:
            self.c_temp.set_value(snap["temperature"])
        self.c_target.set_value(snap["target"])
        level = snap["manual_level"] if snap["mode"] == "manual" else snap["thermostat_level"]
        self.c_speed.set_value(level * 10)
        self.c_thermo.set_value(snap["mode"] == "thermostat")


async def run_homekit(ctl: Controller, state_dir: Path, port: int = 51826, name: str = "Diesel Heater") -> None:
    driver = AccessoryDriver(port=port, persist_file=str(state_dir / "homekit.state"),
                             loop=asyncio.get_running_loop())
    driver.add_accessory(HeaterAccessory(driver, ctl, name))
    await driver.async_start()
    log.info("HomeKit ready. Pair in the Home app with code %s", driver.state.pincode.decode())
    try:
        await asyncio.Event().wait()
    finally:
        await driver.async_stop()
