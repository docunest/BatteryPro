"""heaterbridge CLI.

    heaterbridge scan                     find heaters nearby
    heaterbridge status|on|off|level N    one-shot commands
    heaterbridge run -c config.toml       run the smart-home bridge
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import tomllib
from pathlib import Path

from . import protocol as p
from .controller import Controller
from .heater import Heater, scan
from .thermostat import Thermostat, ThermostatConfig

log = logging.getLogger("heaterbridge")


def load_config(path: Path | None) -> dict:
    if path is None:
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


def make_heater(cfg: dict, args: argparse.Namespace) -> Heater:
    h = cfg.get("heater", {})
    return Heater(
        address=args.address or h.get("address", ""),
        name_prefix=h.get("name_prefix", "BYD"),
        passkey=int(h.get("passkey", p.DEFAULT_PASSKEY)),
        poll_interval=float(h.get("poll_interval", 5)),
    )


async def cmd_scan(_cfg, _args) -> None:
    print("Scanning 10 s ... (close the AirHeaterBLE app first: the heater accepts one connection)")
    devs = await scan(10)
    if not devs:
        print("No heaters found.")
    for dev, rssi in devs:
        print(f"{dev.address}  {dev.name or '?':20s} RSSI {rssi}")


async def cmd_oneshot(cfg, args) -> None:
    heater = make_heater(cfg, args)
    task = asyncio.create_task(heater.run())
    try:
        status = await heater.wait_for_status(45)
        if args.cmd == "on":
            await heater.set_power(True)
        elif args.cmd == "off":
            await heater.set_power(False)
        elif args.cmd == "level":
            await heater.set_level(args.value)
        if args.cmd != "status":
            await asyncio.sleep(2)
            status = heater.status
        print(json.dumps(status.as_dict(), indent=2))
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def cmd_run(cfg, args) -> None:
    state_dir = Path(cfg.get("state_dir", "~/.heaterbridge")).expanduser()
    state_dir.mkdir(parents=True, exist_ok=True)

    heater = make_heater(cfg, args)
    tcfg = ThermostatConfig()
    tcfg.update(cfg.get("thermostat", {}))
    ctl = Controller(
        heater, Thermostat(config=tcfg), state_file=state_dir / "state.json",
        temp_source=cfg.get("temperature", {}).get("source", "heater"),
    )

    tasks = [heater.run(), ctl.run()]

    web_cfg = cfg.get("web", {"enabled": True})
    if web_cfg.get("enabled", True):
        from .web import run_web
        await run_web(ctl, web_cfg.get("host", "0.0.0.0"), int(web_cfg.get("port", 8080)), web_cfg.get("token"))

    mq = cfg.get("mqtt", {})
    if mq.get("enabled"):
        from .mqtt_ha import MqttBridge
        tasks.append(MqttBridge(
            ctl, mq["host"], int(mq.get("port", 1883)), mq.get("username"), mq.get("password"),
            base_topic=mq.get("base_topic", "dieselheater"),
            discovery_prefix=mq.get("discovery_prefix", "homeassistant"),
            device_id=mq.get("device_id", "dieselheater"),
            external_temp_topic=cfg.get("temperature", {}).get("mqtt_topic"),
            external_temp_field=cfg.get("temperature", {}).get("mqtt_field", "temperature"),
        ).run())

    hk = cfg.get("homekit", {})
    if hk.get("enabled"):
        from .homekit import run_homekit
        tasks.append(run_homekit(ctl, state_dir, int(hk.get("port", 51826)), hk.get("name", "Diesel Heater")))

    await asyncio.gather(*tasks)


def main() -> None:
    ap = argparse.ArgumentParser(prog="heaterbridge", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-c", "--config", type=Path, help="TOML config file")
    ap.add_argument("-a", "--address", help="heater BLE address (overrides config)")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    sub.add_parser("status")
    sub.add_parser("on")
    sub.add_parser("off")
    lv = sub.add_parser("level")
    lv.add_argument("value", type=int, choices=range(p.MIN_LEVEL, p.MAX_LEVEL + 1))
    sub.add_parser("run")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not args.verbose:
        logging.getLogger("bleak").setLevel(logging.WARNING)
    cfg = load_config(args.config)
    handler = {"scan": cmd_scan, "run": cmd_run}.get(args.cmd, cmd_oneshot)
    try:
        asyncio.run(handler(cfg, args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
