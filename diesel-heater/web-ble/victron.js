// Victron "Instant Readout" BLE advertisements (SmartSolar/BlueSolar MPPT, Blue Smart chargers).
// Devices broadcast AES-128-CTR encrypted manufacturer data; the per-device key is shown in
// VictronConnect: device > settings > ... > Product info > Instant readout details > Show.
// Format follows Victron's "extra manufacturer data" spec as implemented in
// https://github.com/keshavdv/victron-ble (Unlicense).

export const VICTRON_COMPANY_ID = 0x02e1;

export const READOUT_TYPES = {
  0x01: "Solar charger",
  0x02: "Battery monitor",
  0x03: "Inverter",
  0x04: "DC/DC converter",
  0x05: "Smart lithium",
  0x08: "AC charger",
  0x09: "Smart BatteryProtect",
  0x0d: "DC energy meter",
};

export const STATES = {
  0: "off", 1: "low power", 2: "fault", 3: "bulk", 4: "absorption", 5: "float", 6: "storage",
  7: "equalize", 9: "inverting", 11: "power supply", 245: "starting up", 246: "repeated absorption",
  247: "recondition", 248: "BatterySafe", 249: "active", 252: "external control",
};

const ERRORS = {
  1: "battery temperature too high", 2: "battery voltage too high", 14: "battery temperature too low",
  17: "charger temperature too high", 18: "charger over current", 20: "bulk time limit exceeded",
  26: "terminals overheated", 27: "short circuit", 29: "over-charge protection",
  33: "PV over-voltage", 34: "PV over-current", 35: "PV over-power", 38: "input shutdown (battery voltage)",
  67: "BMS connection lost", 116: "calibration data lost", 117: "invalid firmware", 119: "settings lost",
};

export const errorText = (code) => (code == null || code === 0 ? null : `Err ${code}${ERRORS[code] ? ": " + ERRORS[code] : ""}`);

/** Split the manufacturer data (after the 0x02E1 company id) into its header fields. */
export function parseAdvertisement(bytes) {
  const d = Uint8Array.from(bytes);
  if (d.length < 8 || d[0] !== 0x10) return null; // 0x10 = "product advertisement" record
  return {
    modelId: d[2] | (d[3] << 8),
    readoutType: d[4],
    iv: d[5] | (d[6] << 8),
    keyCheck: d[7],
    encrypted: d.slice(8),
  };
}

export function parseKey(hex) {
  const clean = (hex || "").replace(/[^0-9a-f]/gi, "");
  if (clean.length !== 32) return null;
  return Uint8Array.from(clean.match(/../g).map((h) => parseInt(h, 16)));
}

const keyCache = new Map();
async function importKey(key) {
  const id = Array.from(key).join(",");
  if (!keyCache.has(id)) keyCache.set(id, crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"]));
  return keyCache.get(id);
}

/** AES-CTR with a 128-bit little-endian counter starting at iv (as Victron uses). */
export async function decrypt(adv, key) {
  const ck = await importKey(key);
  const out = new Uint8Array(adv.encrypted.length);
  for (let off = 0, block = 0; off < out.length; off += 16, block++) {
    const counter = new Uint8Array(16);
    let v = adv.iv + block;
    for (let i = 0; i < 4; i++) { counter[i] = v & 0xff; v = Math.floor(v / 256); }
    // One block per call: Web Crypto increments big-endian, Victron little-endian.
    const chunk = adv.encrypted.slice(off, off + 16);
    const ks = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, ck, chunk));
    out.set(ks, off);
  }
  return out;
}

// Bit fields are packed LSB first.
function bitReader(d) {
  let pos = 0;
  return (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v += ((d[pos >> 3] >> (pos & 7)) & 1) * 2 ** i;
    return v;
  };
}
const signed = (v, n) => (v >= 2 ** (n - 1) ? v - 2 ** n : v);
const na = (v, missing, scale = 1) => (v === missing ? null : v * scale);
const round = (v, digits) => (v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

export function parseSolarCharger(d) {
  const r = bitReader(d);
  const state = r(8), error = r(8);
  const voltage = signed(r(16), 16), current = signed(r(16), 16);
  const yieldToday = r(16), pv = r(16), load = r(9);
  return {
    state: state === 0xff ? null : state,
    error: error === 0xff ? null : error,
    batteryVoltage: round(na(voltage, 0x7fff, 0.01), 2),
    batteryCurrent: round(na(current, 0x7fff, 0.1), 1),
    yieldTodayWh: na(yieldToday, 0xffff, 10),
    solarPower: na(pv, 0xffff),
    loadCurrent: round(na(load, 0x1ff, 0.1), 1),
  };
}

export function parseAcCharger(d) {
  const r = bitReader(d);
  const state = r(8), error = r(8);
  const outputs = [];
  for (let i = 0; i < 3; i++) {
    const v = r(13), a = r(11);
    outputs.push({ voltage: round(na(v, 0x1fff, 0.01), 2), current: round(na(a, 0x7ff, 0.1), 1) });
  }
  const temp = r(7), ac = r(9);
  return {
    state: state === 0xff ? null : state,
    error: error === 0xff ? null : error,
    outputs: outputs.filter((o) => o.voltage != null || o.current != null),
    temperature: temp === 0x7f ? null : temp - 40,
    acCurrent: round(na(ac, 0x1ff, 0.1), 1),
  };
}

/**
 * Decode one advertisement. Returns {readoutType, modelId, data} or {readoutType, modelId, error}.
 * error is "no-key", "wrong-key" or "unsupported".
 */
export async function decode(bytes, keyHex) {
  const adv = parseAdvertisement(bytes);
  if (!adv) return null;
  const base = { readoutType: adv.readoutType, modelId: adv.modelId };
  const key = parseKey(keyHex);
  if (!key) return { ...base, error: "no-key" };
  if (adv.keyCheck !== key[0]) return { ...base, error: "wrong-key" };
  const plain = await decrypt(adv, key);
  if (adv.readoutType === 0x01) return { ...base, data: parseSolarCharger(plain) };
  if (adv.readoutType === 0x08) return { ...base, data: parseAcCharger(plain) };
  return { ...base, error: "unsupported" };
}
