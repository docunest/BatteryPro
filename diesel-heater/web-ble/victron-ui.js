// Victron card: listens to Instant Readout broadcasts (no connection needed, so the
// heater link and VictronConnect keep working) and shows live MPPT / charger values.
import { VICTRON_COMPANY_ID as ID, READOUT_TYPES, STATES, errorText, decode, parseKey } from "./victron.js?v=5";

const STORE_KEY = "victron-devices";
const STALE_MS = 30000;

const saved = load(); // id -> {name, key}
const live = new Map(); // id -> {name, raw, result, seen}
let card, root, statusEl, listening = false, renderTimer = null;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch {}
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (v, unit, digits = 1) => (v == null ? "–" : `${v.toFixed(digits)} ${unit}`);

function savedFor(id, name) {
  if (saved[id]) return saved[id];
  // Some browsers hand out a new device id per session; fall back to the name.
  const byName = Object.entries(saved).find(([, d]) => name && d.name === name);
  if (byName) {
    saved[id] = byName[1];
    delete saved[byName[0]];
    persist();
    return saved[id];
  }
  return null;
}

async function onAdvertisement(e) {
  const m = e.manufacturerData && e.manufacturerData.get(ID);
  if (!m) return;
  const raw = new Uint8Array(m.buffer, m.byteOffset, m.byteLength).slice();
  const id = e.device.id;
  const name = e.device.name || e.name || live.get(id)?.name || saved[id]?.name || "Victron device";
  const s = savedFor(id, name);
  const result = await decode(raw, s?.key);
  if (!result) return;
  if (s && s.name !== name) { s.name = name; persist(); }
  live.set(id, { name, raw, result, seen: Date.now() });
  scheduleRender();
}

function scheduleRender() {
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 300);
}

async function setKey(id, name, key) {
  saved[id] = { name, key };
  persist();
  const l = live.get(id);
  if (l) l.result = await decode(l.raw, key);
  render();
}

function deviceBody(id, name, l) {
  const r = l?.result;
  const keyForm = (msg) => `
    <p class="mut">${msg}</p>
    <label>Encryption key <input data-key="${esc(id)}" placeholder="32 hex characters" style="width:14em" autocomplete="off"></label>
    <button data-save="${esc(id)}" data-name="${esc(name)}" style="margin-top:8px">Save key</button>`;

  if (!r) return `<p class="mut">Waiting for a broadcast… (Instant readout must be enabled in VictronConnect)</p>`;
  if (r.error === "no-key") return keyForm("Paste the key from VictronConnect: device ⚙️ → ⋮ → Product info → Instant readout details → Show.");
  if (r.error === "wrong-key") return keyForm("<span class=\"err\">This key doesn't match the device.</span>");
  if (r.error === "unsupported") return `<p class="mut">${esc(READOUT_TYPES[r.readoutType] || "Device type " + r.readoutType)}: not supported yet.</p>`;

  const d = r.data;
  const rows = [];
  let headline;
  if (r.readoutType === 0x01) {
    headline = [fmt(d.solarPower, "W", 0), "solar"];
    rows.push(["Battery", fmt(d.batteryVoltage, "V", 2)], ["Charge current", fmt(d.batteryCurrent, "A")],
      ["Yield today", d.yieldTodayWh == null ? "–" : (d.yieldTodayWh / 1000).toFixed(2) + " kWh"]);
    if (d.loadCurrent != null) rows.push(["Load output", fmt(d.loadCurrent, "A")]);
  } else {
    const o = d.outputs[0] || {};
    headline = [fmt(o.voltage, "V", 2), fmt(o.current, "A")];
    d.outputs.slice(1).forEach((x, i) => rows.push([`Output ${i + 2}`, `${fmt(x.voltage, "V", 2)} · ${fmt(x.current, "A")}`]));
    if (d.temperature != null) rows.push(["Temperature", d.temperature + " °C"]);
    if (d.acCurrent != null) rows.push(["AC input", fmt(d.acCurrent, "A")]);
  }
  const err = errorText(d.error);
  const age = Date.now() - l.seen;
  return `
    <div class="row">
      <div><div class="big" style="font-size:32px">${headline[0]}</div><div class="mut">${headline[1]}</div></div>
      <div style="text-align:right"><div class="mut">State</div><div style="font-weight:600">${esc(STATES[d.state] ?? (d.state == null ? "–" : "state " + d.state))}</div></div>
    </div>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <dl style="margin-top:10px">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${age > STALE_MS ? `<p class="mut">Last update ${Math.round(age / 1000)} s ago</p>` : ""}`;
}

function render() {
  const ids = new Set([...live.keys(), ...Object.keys(saved)]);
  statusEl.textContent = listening ? (ids.size ? "" : "Listening… no Victron devices heard yet.") : "";
  for (const el of root.querySelectorAll("[data-dev]")) if (!ids.has(el.dataset.dev)) el.remove();
  for (const id of ids) {
    const l = live.get(id);
    const name = l?.name || saved[id]?.name || "Victron device";
    let el = root.querySelector(`[data-dev="${CSS.escape(id)}"]`);
    if (!el) {
      el = document.createElement("div");
      el.dataset.dev = id;
      el.style.cssText = "border-top:1px solid var(--bd);padding-top:12px;margin-top:12px";
      root.appendChild(el);
    }
    const typing = document.activeElement?.tagName === "INPUT" && el.contains(document.activeElement);
    if (typing) continue; // don't wipe a key being typed
    const type = l?.result ? READOUT_TYPES[l.result.readoutType] || "" : "";
    el.innerHTML = `
      <div class="row"><b>${esc(name)}</b><span class="mut">${esc(type)}${saved[id] ? ` · <a href="#" data-forget="${esc(id)}">forget</a>` : ""}</span></div>
      ${deviceBody(id, name, l)}`;
  }
}

async function watchDevice(dev) {
  dev.addEventListener("advertisementreceived", onAdvertisement);
  await dev.watchAdvertisements();
  listening = true;
}

// Shown when something doesn't work, so the browser's actual support can be reported.
function capabilities(dev) {
  const bt = navigator.bluetooth || {};
  const has = (o, k) => (o && typeof o[k] === "function" ? "yes" : "no");
  return [
    `requestLEScan: ${has(bt, "requestLEScan")}`,
    `getDevices: ${has(bt, "getDevices")}`,
    `watchAdvertisements: ${dev ? has(dev, "watchAdvertisements") : "?"}`,
    navigator.userAgent.slice(-60),
  ].join(" · ");
}

async function start() {
  const bt = navigator.bluetooth;
  if (!bt) return;
  try {
    if (bt.requestLEScan) {
      // Scans everything Victron broadcasts nearby (Bluefy, Chrome with scanning enabled).
      try {
        await bt.requestLEScan({ filters: [{ manufacturerData: [{ companyIdentifier: ID }] }], keepRepeatedDevices: true });
      } catch (e) {
        if (e.name === "NotAllowedError" || e.name === "AbortError") throw e;
        await bt.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
      }
      if (!listening) bt.addEventListener("advertisementreceived", onAdvertisement);
      listening = true;
      $btn().textContent = "Scanning for Victron devices";
      $btn().disabled = true;
    } else {
      // Pick one device at a time; tap again to add another. Some browsers (e.g. Bluefy)
      // only expose watchAdvertisements on the device object, so check there.
      const dev = await bt.requestDevice({ acceptAllDevices: true, optionalManufacturerData: [ID] });
      if (typeof dev.watchAdvertisements !== "function") {
        statusEl.innerHTML = `This browser can connect to Bluetooth devices but can't receive their broadcasts,
          which Victron Instant Readout needs.<br><small>${esc(capabilities(dev))}</small>`;
        return;
      }
      await watchDevice(dev);
      $btn().textContent = "Add another Victron device";
      const name = dev.name || "the device";
      setTimeout(() => {
        if (!live.has(dev.id)) {
          statusEl.innerHTML = `No broadcasts received from ${esc(name)}. Check that it's a Victron device and that
            Instant readout is enabled in VictronConnect.<br><small>${esc(capabilities(dev))}</small>`;
        }
      }, 15000);
    }
  } catch (e) {
    if (e.name !== "NotFoundError" && e.name !== "AbortError") statusEl.textContent = "Couldn't start: " + e.message;
  }
  render();
}

const $btn = () => card.querySelector("#victron-start");

export function initVictron(container) {
  card = container;
  root = container.querySelector("#victron-list");
  statusEl = container.querySelector("#victron-status");
  $btn().onclick = start;
  root.addEventListener("click", async (e) => {
    const save = e.target.closest("[data-save]");
    if (save) {
      const id = save.dataset.save;
      const input = root.querySelector(`[data-key="${CSS.escape(id)}"]`);
      if (!parseKey(input.value)) { input.style.borderColor = "var(--acc)"; return; }
      input.blur();
      await setKey(id, save.dataset.name, input.value.trim());
    }
    const forget = e.target.closest("[data-forget]");
    if (forget) {
      e.preventDefault();
      delete saved[forget.dataset.forget];
      live.delete(forget.dataset.forget);
      persist();
      render();
    }
  });
  setInterval(render, 5000);
  render();
  // Chrome can re-watch devices granted earlier without a tap.
  navigator.bluetooth?.getDevices?.().then((devs) => devs.forEach((d) => {
    if (saved[d.id] && d.watchAdvertisements) watchDevice(d).then(render).catch(() => {});
  })).catch(() => {});
}
