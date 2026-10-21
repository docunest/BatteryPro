// Vevor / AirHeaterBLE ("BYD-xxxx") diesel heater protocol.
// Mirror of bridge/heaterbridge/protocol.py - keep the two in sync.

export const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
export const CHAR_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
export const CMD = { STATUS: 1, SET_MODE: 2, POWER: 3, SET_TARGET: 4 };
export const MODE = { MANUAL: 0, LEVEL: 1, TEMPERATURE: 2 };

const STEPS = { 0: "standby", 1: "self-test", 2: "ignition", 3: "running", 4: "cooldown", 6: "ventilation" };
const ERRORS = {
  1: "E1 startup failure", 2: "E2 lack of fuel", 3: "E3 supply voltage", 4: "E4 outlet sensor",
  5: "E5 inlet sensor", 6: "E6 fuel pump", 7: "E7 fan", 8: "E8 ignition unit", 9: "E9 overheating",
  10: "E10 overheat sensor",
};
const MODES = { 0: "manual", 1: "level", 2: "temperature" };
const KEY = [...new TextEncoder().encode("password")];

export function buildCommand(cmd, arg = 0, passkey = 1234) {
  const p = new Uint8Array(8);
  p[0] = 0xaa; p[1] = 0x55;
  p[2] = Math.floor(passkey / 100) % 256; p[3] = passkey % 100;
  p[4] = cmd % 256; p[5] = arg % 256; p[6] = Math.floor(arg / 256) % 256;
  p[7] = (p[2] + p[3] + p[4] + p[5] + p[6]) % 256;
  return p;
}

export function xorCrypt(data) {
  const out = Uint8Array.from(data);
  for (let i = 0; i < Math.min(out.length, 48); i++) out[i] ^= KEY[i % 8];
  return out;
}

const s16 = (v) => (v >= 0x8000 ? v - 0x10000 : v);
const clampLevel = (v) => Math.max(1, Math.min(10, v));

export function parseStatus(raw) {
  const d = Uint8Array.from(raw);
  if (d.length < 17) return null;
  let header = (d[0] << 8) | d[1];
  if ((header === 0xaa55 || header === 0xaa66) && d.length < 40) return parsePlain(d, header === 0xaa55 ? "AA55" : "AA66");
  if (d.length >= 40) {
    const x = xorCrypt(d);
    header = (x[0] << 8) | x[1];
    if (header === 0xaa55 || header === 0xaa66) return parseEncrypted(x, header === 0xaa55 ? "AA55enc" : "AA66enc");
  }
  return null;
}

function common(d, proto, mode, err) {
  return {
    protocol: proto,
    running: d[3] === 1,
    runningStep: STEPS[d[5]] ?? `unknown(${d[5]})`,
    runningMode: MODES[mode] ?? `unknown(${mode})`,
    errorCode: err,
    error: err ? ERRORS[err] ?? `E${err}` : null,
  };
}

function parsePlain(d, proto) {
  const mode = d[8];
  const level = clampLevel(mode === MODE.LEVEL ? d[9] : d[10] + 1);
  let err, caseTemp;
  if (proto === "AA66") {
    err = d.length > 17 ? d[17] : 0;
    const c = d[13] | (d[14] << 8);
    caseTemp = c > 350 ? c / 10 : c;
  } else {
    err = d[4];
    caseTemp = s16(d[13] | (d[14] << 8));
  }
  return {
    ...common(d, proto, mode, err),
    level,
    setTemp: mode === MODE.TEMPERATURE ? d[9] : null,
    roomTemp: s16(d[15] | (d[16] << 8)),
    caseTemp,
    voltage: (d[11] | (d[12] << 8)) / 10,
  };
}

function parseEncrypted(d, proto) {
  const mode = d[8];
  const err = proto === "AA66enc" ? d[35] : d[4];
  let setTemp = d[9];
  if (proto === "AA66enc" && d[27] === 1) setTemp = Math.round(((setTemp - 32) * 5) / 9);
  return {
    ...common(d, proto, mode, err),
    level: clampLevel(d[10]),
    setTemp: mode === MODE.TEMPERATURE ? setTemp : null,
    roomTemp: s16((d[32] << 8) | d[33]) / 10,
    caseTemp: s16((d[13] << 8) | d[14]),
    voltage: ((d[11] << 8) | d[12]) / 10,
  };
}
