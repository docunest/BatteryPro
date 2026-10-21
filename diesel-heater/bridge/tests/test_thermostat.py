from heaterbridge.thermostat import Thermostat, ThermostatConfig


def simulate(t: Thermostat, hours: float, outside: float = -5.0, start: float = 12.0, dt: float = 10.0):
    """Crude room model: heat in proportional to level, loss proportional to delta-T."""
    temp, now, burning_since = start, 0.0, None
    trace = []
    while now < hours * 3600:
        d = t.step(now, temp, 0, burning_since is not None and now - burning_since > 300)
        if d.power and burning_since is None:
            burning_since = now
        if not d.power:
            burning_since = None
        heat = 0.0
        if burning_since is not None and now - burning_since > 180:  # ignition delay
            heat = 0.25 + 0.075 * d.level  # °C/min
        loss = 0.02 * (temp - outside)  # °C/min
        temp += (heat - loss) * dt / 60
        trace.append((now, temp, d.power, d.level))
        now += dt
    return trace


def test_reaches_and_holds_target_without_cycling():
    t = Thermostat(target=20.0)
    trace = simulate(t, 6)
    last_2h = [x for x in trace if x[0] > 4 * 3600]
    temps = [x[1] for x in last_2h]
    assert all(x[2] for x in last_2h), "burner should stay on when it can modulate"
    assert 19.3 <= min(temps) and max(temps) <= 20.7
    powers = [False] + [x[2] for x in trace]
    starts = sum(1 for a, b in zip(powers, powers[1:]) if b and not a)
    assert starts == 1


def test_full_power_when_very_cold():
    t = Thermostat(target=22.0)
    d = None
    for i in range(10):
        d = t.step(i * 61.0, 10.0, 0, True)
    assert d.power and d.level == 10


def test_stops_on_sustained_overshoot_after_min_run():
    cfg = ThermostatConfig(min_run=600, stop_delay=120)
    t = Thermostat(config=cfg, target=20.0)
    assert t.step(0, 15.0, 0, False).power
    # warm room (e.g. sun) - stays on until min_run elapsed
    assert t.step(300, 23.0, 0, True).power
    assert t.step(500, 23.0, 0, True).power
    d = t.step(700, 23.0, 0, True)
    assert not d.power and "stop" in d.reason
    # min_rest prevents immediate restart
    assert not t.step(800, 15.0, 0, False).power
    assert t.step(700 + cfg.min_rest + 1, 15.0, 0, False).power


def test_allow_stop_false_idles_at_min_level():
    t = Thermostat(config=ThermostatConfig(allow_stop=False, min_run=0, stop_delay=0), target=20.0)
    t.step(0, 15.0, 0, False)
    for i in range(1, 20):
        d = t.step(i * 61.0, 25.0, 0, True)
    assert d.power and d.level == 1


def test_stale_sensor_holds_and_never_starts():
    t = Thermostat(target=20.0)
    d = t.step(0, 10.0, 10_000, False)
    assert not d.power and "stale" in d.reason


def test_level_changes_are_rate_limited():
    t = Thermostat(config=ThermostatConfig(level_interval=60, max_level_step=2), target=20.0)
    t.step(0, 10.0, 0, False)
    levels = [t.step(s, 10.0, 0, True).level for s in (1, 30, 61, 90, 122)]
    assert levels == [3, 3, 5, 5, 7]
