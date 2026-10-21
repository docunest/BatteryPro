"""Local web UI + REST API (use from any phone browser on the LAN)."""
from __future__ import annotations

import logging
from pathlib import Path

from aiohttp import web

from .controller import Controller

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"


def make_app(ctl: Controller, token: str | None = None) -> web.Application:
    @web.middleware
    async def auth(request: web.Request, handler):
        if token and request.path.startswith("/api/"):
            supplied = request.headers.get("Authorization", "").removeprefix("Bearer ") or request.query.get("token")
            if supplied != token:
                raise web.HTTPUnauthorized()
        try:
            return await handler(request)
        except (KeyError, ValueError, TypeError) as e:
            raise web.HTTPBadRequest(text=f"bad request: {e}") from e

    async def body(request: web.Request) -> dict:
        try:
            return await request.json()
        except Exception as e:  # noqa: BLE001
            raise web.HTTPBadRequest(text="JSON body required") from e

    def ok() -> web.Response:
        return web.json_response(ctl.snapshot())

    async def index(_r):
        return web.FileResponse(STATIC / "index.html")

    async def state(_r):
        return ok()

    async def power(r):
        ctl.set_enabled(bool((await body(r))["on"]))
        return ok()

    async def level(r):
        ctl.set_level(int((await body(r))["level"]))
        return ok()

    async def target(r):
        ctl.set_target(float((await body(r))["target"]))
        return ok()

    async def mode(r):
        ctl.set_mode((await body(r))["mode"])
        return ok()

    async def temperature(r):
        ctl.set_external_temp(float((await body(r))["temperature"]))
        return ok()

    async def config(r):
        ctl.thermostat.config.update(await body(r))
        return ok()

    app = web.Application(middlewares=[auth])
    app.add_routes([
        web.get("/", index),
        web.get("/api/state", state),
        web.post("/api/power", power),
        web.post("/api/level", level),
        web.post("/api/target", target),
        web.post("/api/mode", mode),
        web.post("/api/temperature", temperature),
        web.post("/api/config", config),
    ])
    return app


async def run_web(ctl: Controller, host: str, port: int, token: str | None) -> None:
    runner = web.AppRunner(make_app(ctl, token))
    await runner.setup()
    await web.TCPSite(runner, host, port).start()
    log.info("Web UI on http://%s:%d", host, port)
