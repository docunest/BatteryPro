"""Room thermostat that drives the heater through its power levels.

The heater's built-in "temperature mode" only measures temperature at the
control panel and bangs between full power and stop. This controller instead
keeps the heater in fixed-level mode and modulates the level (1-10) with a PI
loop, only starting/stopping the burner with wide hysteresis and minimum run /
rest times (short burns coke up diesel heaters).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .protocol import MAX_LEVEL, MIN_LEVEL


@dataclass
class ThermostatConfig:
    # Start burner when temp <= target - start_below
    start_below: float = 1.0
    # Stop burner when temp >= target + stop_above for stop_delay seconds
    # (only if allow_stop; otherwise it idles at min_level)
    stop_above: float = 1.5
    stop_delay: float = 300
    allow_stop: bool = True
    min_run: float = 30 * 60
    min_rest: float = 10 * 60
    min_level: int = MIN_LEVEL
    max_level: int = MAX_LEVEL
    # Proportional band: at error <= -0.5 °C -> min_level, error >= full_power_error -> max_level
    full_power_error: float = 3.0
    # Integral gain in levels per (°C * hour); removes steady-state offset
    ki: float = 2.0
    integral_limit: float = 3.0
    # Minimum seconds between level changes and max step per change
    level_interval: float = 60
    max_level_step: int = 2
    # Sensor older than this -> hold current state, never start
    sensor_timeout: float = 600

    def update(self, values: dict) -> None:
        for k, v in values.items():
            if hasattr(self, k):
                setattr(self, k, type(getattr(self, k))(v))

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Decision:
    power: bool
    level: int
    reason: str


@dataclass
class Thermostat:
    config: ThermostatConfig = field(default_factory=ThermostatConfig)
    target: float = 20.0
    want_on: bool = False
    level: int = MIN_LEVEL
    integral: float = 0.0
    _last_switch: float = -1e12
    _last_level_change: float = -1e12
    _last_step: float | None = None
    _over_since: float | None = None

    def reset(self, on: bool, now: float) -> None:
        """Resync after an external power change (panel, remote, app)."""
        if on != self.want_on:
            self.want_on = on
            self._last_switch = now
            self._over_since = None
            if not on:
                self.integral = 0.0

    def _proportional(self, error: float) -> float:
        c = self.config
        lo, hi = -0.5, max(c.full_power_error, 0.1)
        frac = (error - lo) / (hi - lo)
        return c.min_level + (c.max_level - c.min_level) * min(1.0, max(0.0, frac))

    def step(self, now: float, temp: float | None, temp_age: float, burner_running: bool) -> Decision:
        """Compute desired power + level.

        `burner_running` is True once the heater reached its steady "running"
        step; the integral only accumulates then (no windup during ignition).
        """
        c = self.config
        dt = 0.0 if self._last_step is None else max(0.0, now - self._last_step)
        self._last_step = now

        if temp is None or temp_age > c.sensor_timeout:
            return Decision(self.want_on, self.level, "sensor stale - holding")

        error = self.target - temp
        since_switch = now - self._last_switch
        reason = ""

        if not self.want_on:
            if error >= c.start_below:
                if since_switch >= c.min_rest:
                    self.want_on = True
                    self._last_switch = now
                    self._over_since = None
                    self.integral = 0.0
                    reason = f"start: {temp:.1f} <= {self.target - c.start_below:.1f}"
                else:
                    reason = f"cold, resting {int(c.min_rest - since_switch)}s more"
            else:
                reason = "idle"
            if not self.want_on:
                self.level = c.min_level
                return Decision(False, self.level, reason)

        # --- burner on: modulate --------------------------------------------
        p_level = self._proportional(error)
        if burner_running and dt > 0:
            new_i = self.integral + c.ki * error * dt / 3600
            new_i = max(-c.integral_limit, min(c.integral_limit, new_i))
            # anti-windup: don't push further into saturation
            raw = p_level + new_i
            if not (raw > c.max_level and error > 0) and not (raw < c.min_level and error < 0):
                self.integral = new_i
        desired = round(max(c.min_level, min(c.max_level, p_level + self.integral)))

        if desired != self.level and now - self._last_level_change >= c.level_interval:
            step = max(-c.max_level_step, min(c.max_level_step, desired - self.level))
            self.level += step
            self._last_level_change = now

        # --- stop on sustained overshoot -----------------------------------
        if temp >= self.target + c.stop_above:
            if self._over_since is None:
                self._over_since = now
            if (
                c.allow_stop
                and now - self._over_since >= c.stop_delay
                and since_switch >= c.min_run
            ):
                self.want_on = False
                self._last_switch = now
                self.integral = 0.0
                self.level = c.min_level
                return Decision(False, self.level, f"stop: {temp:.1f} >= {self.target + c.stop_above:.1f}")
            reason = reason or "overshoot, waiting before stop"
        else:
            self._over_since = None

        return Decision(True, self.level, reason or f"modulating (err {error:+.1f}, I {self.integral:+.2f})")
