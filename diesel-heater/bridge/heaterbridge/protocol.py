"""Byte-level protocol for Vevor / "BYD-xxxx" diesel heaters (AirHeaterBLE app).

The heater exposes one GATT characteristic (0xFFE1 in service 0xFFE0) that is
used both for writing commands and for status notifications.

Commands are always 8 bytes, unencrypted:

    AA 55 <pk/100> <pk%100> <cmd> <arg lo> <arg hi> <checksum>

where pk is the 4-digit passkey (default 1234) and checksum is the sum of
bytes 2..6 modulo 256.

Status notifications come in four known flavours:

    AA55 plain      (18-20 bytes)
    AA66 plain      (20 bytes, common on BYD-named units)
    AA55 encrypted  (48 bytes, XOR with "password")
    AA66 encrypted  (48 bytes, XOR with "password")

Byte layouts follow the community reverse engineering in
https://github.com/Spettacolo83/diesel-heater-ble (MIT).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import IntEnum

SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
CHAR_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"

DEFAULT_PASSKEY = 1234
MIN_LEVEL = 1
MAX_LEVEL = 10
MIN_TEMP = 8
MAX_TEMP = 36

_XOR_KEY = b"password"


class Command(IntEnum):
    STATUS = 1
    SET_MODE = 2
    POWER = 3
    SET_TARGET = 4  # level in level mode, °C in temperature mode


class RunningMode(IntEnum):
    MANUAL = 0
    LEVEL = 1
    TEMPERATURE = 2


RUNNING_STEPS = {
    0: "standby",
    1: "self-test",
    2: "ignition",
    3: "running",
    4: "cooldown",
    6: "ventilation",
}

ERRORS = {
    0: None,
    1: "E1 startup failure",
    2: "E2 lack of fuel",
    3: "E3 supply voltage",
    4: "E4 outlet sensor",
    5: "E5 inlet sensor",
    6: "E6 fuel pump",
    7: "E7 fan",
    8: "E8 ignition unit",
    9: "E9 overheating",
    10: "E10 overheat sensor",
}


def build_command(command: int, argument: int = 0, passkey: int = DEFAULT_PASSKEY) -> bytes:
    pkt = bytearray(8)
    pkt[0], pkt[1] = 0xAA, 0x55
    pkt[2] = (passkey // 100) % 256
    pkt[3] = passkey % 100
    pkt[4] = command % 256
    pkt[5] = argument % 256
    pkt[6] = (argument // 256) % 256
    pkt[7] = sum(pkt[2:7]) % 256
    return bytes(pkt)


def cmd_status(passkey: int = DEFAULT_PASSKEY) -> bytes:
    return build_command(Command.STATUS, 0, passkey)


def cmd_power(on: bool, passkey: int = DEFAULT_PASSKEY) -> bytes:
    return build_command(Command.POWER, 1 if on else 0, passkey)


def cmd_mode(mode: RunningMode, passkey: int = DEFAULT_PASSKEY) -> bytes:
    return build_command(Command.SET_MODE, int(mode), passkey)


def cmd_level(level: int, passkey: int = DEFAULT_PASSKEY) -> bytes:
    if not MIN_LEVEL <= level <= MAX_LEVEL:
        raise ValueError(f"level must be {MIN_LEVEL}..{MAX_LEVEL}")
    return build_command(Command.SET_TARGET, level, passkey)


def xor_crypt(data: bytes) -> bytes:
    """XOR the first 48 bytes with the 8-byte key (symmetric)."""
    out = bytearray(data)
    for i in range(min(len(out), 48)):
        out[i] ^= _XOR_KEY[i % 8]
    return bytes(out)


@dataclass
class HeaterStatus:
    protocol: str
    running: bool  # heater "switched on" (includes ignition and cooldown)
    running_step: str
    running_mode: str
    level: int | None  # current/target power level 1..10
    set_temp: int | None  # heater-internal target temp (temperature mode)
    room_temp: float | None  # heater's own (control panel) sensor
    case_temp: float | None  # heat exchanger temperature
    voltage: float | None
    altitude: float | None
    error_code: int
    error: str | None

    @property
    def heating(self) -> bool:
        return self.running_step in ("ignition", "running")

    def as_dict(self) -> dict:
        d = asdict(self)
        d["heating"] = self.heating
        return d


def _s16(v: int) -> int:
    return v - 0x10000 if v >= 0x8000 else v


def _clamp_level(v: int) -> int:
    return max(MIN_LEVEL, min(MAX_LEVEL, v))


def _mode_name(m: int) -> str:
    try:
        return RunningMode(m).name.lower()
    except ValueError:
        return f"unknown({m})"


def parse_status(raw: bytes) -> HeaterStatus | None:
    """Parse a status notification. Returns None for frames we don't understand."""
    if len(raw) < 17:
        return None
    header = (raw[0] << 8) | raw[1]
    if header in (0xAA55, 0xAA66) and len(raw) < 40:
        return _parse_plain(raw, "AA55" if header == 0xAA55 else "AA66")
    if len(raw) >= 40:
        data = xor_crypt(raw)
        header = (data[0] << 8) | data[1]
        if header in (0xAA55, 0xAA66):
            return _parse_encrypted(data, "AA55enc" if header == 0xAA55 else "AA66enc")
    return None


def _parse_plain(d: bytes, proto: str) -> HeaterStatus:
    mode = d[8]
    set_temp = None
    if mode == RunningMode.LEVEL:
        level = _clamp_level(d[9])
    elif mode == RunningMode.TEMPERATURE:
        set_temp = d[9]
        level = _clamp_level(d[10] + 1)
    else:
        level = _clamp_level(d[10] + 1)

    if proto == "AA66":
        err = d[17] if len(d) > 17 else 0
        case_raw = d[13] | (d[14] << 8)
        case_temp = case_raw / 10 if case_raw > 350 else float(case_raw)
    else:
        err = d[4]
        case_temp = float(_s16(d[13] | (d[14] << 8)))

    return HeaterStatus(
        protocol=proto,
        running=d[3] == 1,
        running_step=RUNNING_STEPS.get(d[5], f"unknown({d[5]})"),
        running_mode=_mode_name(mode),
        level=level,
        set_temp=set_temp,
        room_temp=float(_s16(d[15] | (d[16] << 8))),
        case_temp=case_temp,
        voltage=(d[11] | (d[12] << 8)) / 10,
        altitude=float(d[6] | (d[7] << 8)),
        error_code=err,
        error=ERRORS.get(err, f"E{err}"),
    )


def _parse_encrypted(d: bytes, proto: str) -> HeaterStatus:
    mode = d[8]
    err = d[35] if proto == "AA66enc" else d[4]
    set_temp = d[9]
    if proto == "AA66enc" and d[27] == 1:  # heater configured for °F
        set_temp = round((set_temp - 32) * 5 / 9)
    return HeaterStatus(
        protocol=proto,
        running=d[3] == 1,
        running_step=RUNNING_STEPS.get(d[5], f"unknown({d[5]})"),
        running_mode=_mode_name(mode),
        level=_clamp_level(d[10]),
        set_temp=set_temp if mode == RunningMode.TEMPERATURE else None,
        room_temp=_s16((d[32] << 8) | d[33]) / 10,
        case_temp=float(_s16((d[13] << 8) | d[14])),
        voltage=((d[11] << 8) | d[12]) / 10,
        altitude=((d[6] << 8) | d[7]) / 10,
        error_code=err,
        error=ERRORS.get(err, f"E{err}"),
    )
