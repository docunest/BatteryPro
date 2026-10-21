# Diesel heater Bluetooth control

Control a Vevor (or other "AirHeaterBLE" app) diesel heater over Bluetooth LE.
These heaters advertise as `BYD-xxxx`. The project has two parts:

| | What | Runs on | Use it for |
|---|---|---|---|
| [`web-ble/`](web-ble) | Web app using Web Bluetooth | **iPhone/iPad via the Bluefy app**, Chrome/Edge on **Android** and **macOS** | Phone/laptop remote: on/off, level 1-10, live status |
| [`bridge/`](bridge) | Python service (`heaterbridge`) | **macOS**, Linux, Raspberry Pi | Exposing the heater as a **smart device**: Home Assistant (MQTT auto-discovery), Apple HomeKit/Siri, REST API + web UI, and a better thermostat |

> The heater accepts **one** Bluetooth connection at a time. Close the
> AirHeaterBLE app, and don't run the web app and the bridge at once.

## Why a custom thermostat

The heater's built-in temperature mode measures at the control panel and
swings between full blast and stop. `heaterbridge` instead keeps the heater in
**fixed-level mode** and runs its own controller:

- picks the level 1-10 with a PI loop (proportional + slow integral), max 2
  steps per minute so the flame stays stable;
- starts the burner when the room is 1 °C below target; stops only after a
  sustained 1.5 °C overshoot, and never within 30 min of starting
  (short burns coke up diesel heaters) or restarting within 10 min of a stop;
- can use an **external room sensor** (any MQTT topic, e.g. a Zigbee sensor,
  or `POST /api/temperature`) instead of the heater's own sensor;
- `allow_stop = false` keeps the heater idling at level 1 instead of cycling.

All of these are tunable in `config.toml` (`[thermostat]`).

---

## web-ble: phone / browser app

Web Bluetooth needs the page on an HTTPS address (or `localhost`). The repo's
GitHub Pages workflow (`.github/workflows/pages.yml`) publishes `web-ble/`
next to the AI chat app on every push to `main`:

**<https://docunest.github.io/BatteryPro/diesel-heater/>**

To try changes locally on the Mac: `cd web-ble && python3 -m http.server 8000`
and open <http://localhost:8000> in Chrome.

Then open the URL in:

- **iPhone / iPad:** the free **Bluefy** browser from the App Store (Safari
  and Chrome on iOS don't support Web Bluetooth). Bookmark the page in Bluefy.
- **Android:** Chrome, then *Add to Home screen*. It works like an app.
- **Mac:** Chrome or Edge.

Tap **Connect**, pick `BYD-xxxx`, then use **Turn on/off** and levels **1-10**.
Changing level switches the heater into fixed-level mode automatically.
If your heater isn't named `BYD…`, change the prefix or tick *Show all
devices* under Settings. Set the passkey there if you changed it from 1234.

The page only controls the heater while it's open in the foreground. On
iPhone the connection drops when you switch apps or lock the screen, and it
reconnects when you come back.

## bridge: smart-home service (macOS)

```bash
cd bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[all]'              # or '.[mqtt]' / '.[homekit]'

heaterbridge scan                    # find the heater; macOS shows a UUID, not a MAC
heaterbridge status                  # one-shot read
heaterbridge on | off | level 6      # one-shot commands

cp config.example.toml config.toml   # edit: MQTT host, HomeKit on/off, ...
heaterbridge -c config.toml run
```

The first time, macOS asks to allow Bluetooth for your terminal (or Python).
To start the bridge at login, see `bridge/macos/com.heaterbridge.plist`.

### What you get

- **Web UI** at `http://<mac>:8080`. Open it from your phone on the same Wi-Fi.
  It has on/off, a level picker, Fixed level / Thermostat, target ±, and diagnostics.
- **Home Assistant**: set `[mqtt] enabled = true`. One device appears
  automatically with:
  - a climate entity (Off/Heat, target temperature, presets *manual* and
    *thermostat*);
  - a Power switch, a Level slider (1-10) and a Control mode select;
  - sensors: temperature, voltage, heat-exchanger temperature, state, error.
- **Apple Home / Siri**: set `[homekit] enabled = true`, then add the accessory
  in the Home app with the code printed in the log. It shows a *Heater*
  (on/off, target temperature, fan-speed slider = level 10-100 %) plus a
  *Smart thermostat* switch.
- **REST API**: `GET /api/state`, `POST /api/power {"on":true}`,
  `/api/level {"level":6}`, `/api/target {"target":20.5}`,
  `/api/mode {"mode":"thermostat"|"manual"}`, `/api/temperature {"temperature":19.2}`,
  `/api/config {...thermostat keys...}`. Set `[web] token` to require
  `Authorization: Bearer <token>`.

### Behaviour

- **Power** is the master switch. In *manual* mode the heater runs at the chosen
  level. In *thermostat* mode the controller decides on/off and level.
- Setting a level switches to manual mode; setting a target temperature
  switches to thermostat mode.
- If you switch the heater on or off, or change the level, from the panel or
  remote, the bridge adopts that change instead of fighting it.
- After a restart, the bridge never starts the burner on its own. Target, level and mode are restored.
- On a heater fault code (E1-E10) the bridge stops sending commands and shows the error.
- If a power command isn't confirmed after 3 tries, the bridge reports a fault
  and stops retrying. It doesn't restart the heater during cooldown.

### Running on Android

The web app above is the Android solution. To have Android itself act as an
always-on smart-home hub you would need a native app. In practice a Mac,
Raspberry Pi or old laptop near the heater running `heaterbridge` is more
reliable.

## Protocol notes

Service `FFE0`, characteristic `FFE1` (write + notify). Commands are 8 bytes:
`AA 55 <pk/100> <pk%100> <cmd> <arg lo> <arg hi> <sum(bytes 2..6)>`, with
`cmd` 1 = status, 2 = mode (1 level / 2 temperature), 3 = power (1/0),
4 = level or temperature. Four status frame variants are decoded (AA55, AA66,
and their 48-byte XOR-"password" encrypted forms). Byte layouts are from the
community reverse engineering in
[diesel-heater-ble](https://github.com/Spettacolo83/diesel-heater-ble) and
[vevor-heater-ble](https://pypi.org/project/vevor-heater-ble/).

## Tests

```bash
cd bridge && pip install -e '.[all,dev]' && pytest     # protocol, thermostat simulation, controller, web, MQTT
cd web-ble && node --test                               # JS protocol parity
```
