"""Glue between the BLE heater, the thermostat and the smart-home frontends.

Modes:
  manual      - heater runs at a fixed level you pick (when enabled)
  thermostat  - the PI thermostat picks level and start/stop (when enabled)

`enabled` is the master switch. Setting a level switches to manual, setting a
target temperature switches to thermostat ("last intent wins").
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Callable

from . import protocol as p
from .heater import Heater
from .thermostat import Thermostat

log = logging.getLogger(__name__)

MODES = ("manual", "thermostat")
COMMAND_TIMEOUT = 90  # s to wait for heater to confirm a power change
MAX_ATTEMPTS = 3


class Controller:
    def __init__(self, heater: Heater, thermostat: Thermostat, state_file: Path | None = None,
                 temp_source: str = "heater", loop_interval: float = 10.0):
        self.heater = heater
        self.thermostat = thermostat
        self.state_file = state_file
        self.temp_source = temp_source  # "heater" or "external"
        self.loop_interval = loop_interval

        self.enabled = False
        self.mode = "manual"
        self.manual_level = 5
        self.external_temp: float | None = None
        self.external_temp_time = 0.0
        self.last_decision = ""
        self.fault: str | None = None

        self._listeners: list[Callable[[], None]] = []
        self._wake = asyncio.Event()
        self._prev_on: bool | None = None
        self._prev_level: int | None = None
        self._pending_power: tuple[bool, float] | None = None
        self._attempts = 0
        self._last_level_cmd = 0.0
        self._load()
        heater.on_status(lambda _s: self._notify())

    # ---- persistence -----------------------------------------------------

    def _load(self) -> None:
        if not self.state_file or not self.state_file.exists():
            return
        try:
            d = json.loads(self.state_file.read_text())
            self.mode = d.get("mode", self.mode)
            self.manual_level = int(d.get("manual_level", self.manual_level))
            self.thermostat.target = float(d.get("target", self.thermostat.target))
            # Deliberately not restoring `enabled`: never auto-start a burner after a restart.
        except Exception:  # noqa: BLE001
            log.exception("could not load %s", self.state_file)

    def _save(self) -> None:
        if not self.state_file:
            return
        self.state_file.write_text(json.dumps(
            {"mode": self.mode, "manual_level": self.manual_level, "target": self.thermostat.target}))

    # ---- public API used by web / mqtt / homekit -------------------------

    def subscribe(self, cb: Callable[[], None]) -> None:
        self._listeners.append(cb)

    def _notify(self) -> None:
        for cb in self._listeners:
            try:
                cb()
            except Exception:  # noqa: BLE001
                log.exception("listener failed")

    def _changed(self) -> None:
        self._save()
        self._attempts = 0
        self._pending_power = None
        self._wake.set()
        self._notify()

    def set_enabled(self, on: bool) -> None:
        log.info("enabled=%s", on)
        self.enabled = on
        self.fault = None
        if on and self.mode == "thermostat":
            # Let the thermostat decide immediately, ignoring rest time once.
            self.thermostat._last_switch = -1e12
        self._changed()

    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if mode == "thermostat" and self.mode != "thermostat":
            self.thermostat.reset(self.is_on, time.monotonic())
            self.thermostat.level = self.heater.status.level if self.heater.status and self.heater.status.level else p.MIN_LEVEL
        self.mode = mode
        self._changed()

    def set_level(self, level: int) -> None:
        self.manual_level = max(p.MIN_LEVEL, min(p.MAX_LEVEL, int(level)))
        self.set_mode("manual")

    def set_target(self, target: float) -> None:
        self.thermostat.target = max(5.0, min(30.0, float(target)))
        self.set_mode("thermostat")

    def set_external_temp(self, temp: float) -> None:
        self.external_temp = float(temp)
        self.external_temp_time = time.monotonic()
        self._notify()

    @property
    def is_on(self) -> bool:
        s = self.heater.status
        return bool(s and s.running and s.running_step not in ("cooldown", "standby"))

    @property
    def current_temp(self) -> tuple[float | None, float]:
        """(temperature, age in seconds) from the configured source."""
        if self.temp_source == "external":
            if self.external_temp is None:
                return None, float("inf")
            return self.external_temp, time.monotonic() - self.external_temp_time
        s = self.heater.status
        if s is None or s.room_temp is None:
            return None, float("inf")
        return s.room_temp, time.time() - self.heater.last_update

    def snapshot(self) -> dict[str, Any]:
        s = self.heater.status
        temp, age = self.current_temp
        return {
            "connected": self.heater.connected,
            "device": self.heater.device_name,
            "enabled": self.enabled,
            "mode": self.mode,
            "manual_level": self.manual_level,
            "target": self.thermostat.target,
            "temp_source": self.temp_source,
            "temperature": temp,
            "temperature_age": None if age == float("inf") else round(age),
            "thermostat_level": self.thermostat.level,
            "thermostat_on": self.thermostat.want_on,
            "decision": self.last_decision,
            "fault": self.fault,
            "is_on": self.is_on,
            "heater": s.as_dict() if s else None,
            "config": self.thermostat.config.as_dict(),
        }

    # ---- control loop ----------------------------------------------------

    async def run(self) -> None:
        while True:
            try:
                await self._tick()
            except ConnectionError:
                pass
            except Exception:  # noqa: BLE001
                log.exception("control loop error")
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), self.loop_interval)
            except asyncio.TimeoutError:
                pass

    async def _tick(self) -> None:
        s = self.heater.status
        if s is None or not self.heater.connected:
            return
        now = time.monotonic()
        on = self.is_on

        # Detect power changes made outside the bridge (panel, remote, phone app).
        if self._prev_on is not None and on != self._prev_on:
            expected = self._pending_power is not None and self._pending_power[0] == on
            if not expected:
                log.info("External power change detected -> enabled=%s", on)
                self.enabled = on
                self.thermostat.reset(on, now)
                self._notify()
            self._pending_power = None
            self._attempts = 0
        self._prev_on = on

        # Adopt level changes made on the panel while in manual mode.
        if (self.mode == "manual" and on and s.running_step == "running" and s.level
                and self._prev_level not in (None, s.level) and now - self._last_level_cmd > 30):
            log.info("External level change detected -> %d", s.level)
            self.manual_level = s.level
            self._save()
            self._notify()
        self._prev_level = s.level if on else None

        if s.error_code:
            if self.fault != s.error:
                log.error("Heater fault: %s", s.error)
                self.fault = s.error
                self._notify()
            return

        # Work out what we want.
        if not self.enabled:
            want_on, want_level, reason = False, self.manual_level, "disabled"
        elif self.mode == "manual":
            want_on, want_level, reason = True, self.manual_level, "manual"
        else:
            temp, age = self.current_temp
            d = self.thermostat.step(now, temp, age, s.running_step == "running")
            want_on, want_level, reason = d.power, d.level, d.reason
        if reason != self.last_decision:
            log.info("Decision: %s", reason)
            self.last_decision = reason
            self._notify()

        # Power.
        if want_on != on:
            if s.running_step == "cooldown" and want_on:
                return  # can't restart until cooldown is finished
            pending = self._pending_power
            if pending and pending[0] == want_on and now - pending[1] < COMMAND_TIMEOUT:
                return
            if self._attempts >= MAX_ATTEMPTS:
                if not self.fault:
                    self.fault = f"heater did not turn {'on' if want_on else 'off'}"
                    log.error(self.fault)
                    self._notify()
                return
            self._attempts += 1
            self._pending_power = (want_on, now)
            if want_on and s.running_mode != "level":
                await self.heater.set_level(want_level)
            await self.heater.set_power(want_on)
            return

        # Level (only while burning steadily, at most every 20 s).
        if on and s.running_step == "running" and s.level != want_level and now - self._last_level_cmd > 20:
            self._last_level_cmd = now
            await self.heater.set_level(want_level)
