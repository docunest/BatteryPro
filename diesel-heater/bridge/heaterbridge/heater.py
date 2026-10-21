"""Persistent BLE connection to the heater with auto-reconnect and polling."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

from . import protocol as p

log = logging.getLogger(__name__)

StatusCallback = Callable[[p.HeaterStatus], None]


async def scan(timeout: float = 8.0, name_prefix: str = "") -> list[tuple[BLEDevice, int | None]]:
    """Find heaters: anything advertising service FFE0 or named BYD-*/<prefix>."""
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    result = []
    for dev, adv in found.values():
        name = dev.name or adv.local_name or ""
        uuids = [u.lower() for u in adv.service_uuids]
        if (
            p.SERVICE_UUID in uuids
            or name.upper().startswith("BYD")
            or (name_prefix and name.startswith(name_prefix))
        ):
            result.append((dev, adv.rssi))
    return result


class Heater:
    """Keeps a BLE link to one heater, polls status and serialises commands.

    `address` may be a MAC (Linux/Android) or a CoreBluetooth UUID (macOS).
    If empty, the first device whose name starts with `name_prefix` is used.
    """

    def __init__(
        self,
        address: str = "",
        name_prefix: str = "BYD",
        passkey: int = p.DEFAULT_PASSKEY,
        poll_interval: float = 5.0,
    ):
        self.address = address
        self.name_prefix = name_prefix
        self.passkey = passkey
        self.poll_interval = poll_interval
        self.status: p.HeaterStatus | None = None
        self.last_update: float = 0.0
        self.connected = False
        self.device_name: str | None = None
        self._client: BleakClient | None = None
        self._lock = asyncio.Lock()
        self._listeners: list[StatusCallback] = []
        self._status_event = asyncio.Event()

    def on_status(self, cb: StatusCallback) -> None:
        self._listeners.append(cb)

    # ---- connection management -------------------------------------------

    async def _find_device(self) -> BLEDevice | None:
        if self.address:
            return await BleakScanner.find_device_by_address(self.address, timeout=15)
        prefix = self.name_prefix.upper()
        return await BleakScanner.find_device_by_filter(
            lambda d, adv: (d.name or adv.local_name or "").upper().startswith(prefix),
            timeout=15,
        )

    async def run(self) -> None:
        """Connect, poll forever, reconnect on failure. Cancel to stop."""
        backoff = 2.0
        while True:
            try:
                dev = await self._find_device()
                if dev is None:
                    log.warning("Heater not found (address=%r prefix=%r)", self.address, self.name_prefix)
                    raise ConnectionError("not found")
                self.device_name = dev.name
                log.info("Connecting to %s (%s)", dev.name, dev.address)
                disconnected = asyncio.Event()
                async with BleakClient(dev, disconnected_callback=lambda _: disconnected.set()) as client:
                    self._client = client
                    await client.start_notify(p.CHAR_UUID, self._on_notify)
                    self.connected = True
                    backoff = 2.0
                    log.info("Connected")
                    while client.is_connected and not disconnected.is_set():
                        try:
                            await self._write(p.cmd_status(self.passkey))
                        except Exception as e:  # noqa: BLE001
                            log.warning("Status poll failed: %s", e)
                            break
                        try:
                            await asyncio.wait_for(disconnected.wait(), self.poll_interval)
                        except asyncio.TimeoutError:
                            pass
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("BLE error: %s", e)
            finally:
                self.connected = False
                self._client = None
            log.info("Reconnecting in %.0fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    def _on_notify(self, _char, data: bytearray) -> None:
        status = p.parse_status(bytes(data))
        if status is None:
            log.debug("Ignoring frame %s", bytes(data).hex())
            return
        self.status = status
        self.last_update = time.time()
        self._status_event.set()
        for cb in self._listeners:
            try:
                cb(status)
            except Exception:  # noqa: BLE001
                log.exception("status listener failed")

    async def _write(self, pkt: bytes) -> None:
        if not self._client or not self._client.is_connected:
            raise ConnectionError("heater not connected")
        async with self._lock:
            log.debug("TX %s", pkt.hex())
            char = self._client.services.get_characteristic(p.CHAR_UUID)
            # Prefer acknowledged writes; some units only support write-without-response.
            response = char is None or "write" in char.properties
            await self._client.write_gatt_char(p.CHAR_UUID, pkt, response=response)
            await asyncio.sleep(0.3)  # the controller drops back-to-back writes

    async def wait_for_status(self, timeout: float = 30.0) -> p.HeaterStatus:
        if self.status is None:
            await asyncio.wait_for(self._status_event.wait(), timeout)
        assert self.status is not None
        return self.status

    # ---- commands ---------------------------------------------------------

    async def set_power(self, on: bool) -> None:
        log.info("Power %s", "ON" if on else "OFF")
        await self._write(p.cmd_power(on, self.passkey))
        await self._write(p.cmd_status(self.passkey))

    async def set_level(self, level: int) -> None:
        level = max(p.MIN_LEVEL, min(p.MAX_LEVEL, int(level)))
        if self.status is None or self.status.running_mode != "level":
            # Built-in temperature mode would fight us; force fixed-level mode.
            await self._write(p.cmd_mode(p.RunningMode.LEVEL, self.passkey))
        log.info("Level -> %d", level)
        await self._write(p.cmd_level(level, self.passkey))
        await self._write(p.cmd_status(self.passkey))
