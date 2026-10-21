// Vectors from keshavdv/victron-ble's test suite (captured from real devices).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, decrypt, parseAdvertisement, parseKey, parseSolarCharger, parseAcCharger } from "./victron.js";

const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

test("MPPT 75/15 end to end", async () => {
  const r = await decode(fromHex("100242a0016207adceb37b605d7e0ee21b24df5c"), "adeccb947395801a4dd45a2eaa44bf17");
  assert.equal(r.modelId, 0xa042);
  assert.equal(r.readoutType, 1);
  assert.deepEqual(r.data, {
    state: 4, error: 0, batteryVoltage: 13.88, batteryCurrent: 1.4,
    yieldTodayWh: 30, solarPower: 19, loadCurrent: 0,
  });
});

test("Blue Smart IP22 charger end to end", async () => {
  const r = await decode(fromHex("100030a308f926c1b5170a0d2280335bf12d5ed083"), "c129cf8f75c3fe5a1655b481e205fb7d");
  assert.equal(r.readoutType, 8);
  assert.equal(r.data.state, 6);
  assert.equal(r.data.error, 0);
  assert.deepEqual(r.data.outputs, [{ voltage: 13.49, current: 0.4 }]);
  assert.equal(r.data.temperature, 21);
  assert.equal(r.data.acCurrent, null);
});

test("wrong and missing keys", async () => {
  const adv = fromHex("100242a0016207adceb37b605d7e0ee21b24df5c");
  assert.equal((await decode(adv, "00eccb947395801a4dd45a2eaa44bf17")).error, "wrong-key");
  assert.equal((await decode(adv, "")).error, "no-key");
  assert.equal(parseKey("ad ec cb 94 73 95 80 1a 4d d4 5a 2e aa 44 bf 17").length, 16);
  assert.equal(await decode(fromHex("0102"), "x"), null);
});

test("solar charger decrypted payloads", () => {
  const big = parseSolarCharger(fromHex("0300fb09650032000901ffff31bc45ad"));
  assert.equal(big.batteryVoltage, 25.55);
  assert.equal(big.batteryCurrent, 10.1);
  assert.equal(big.solarPower, 265);
  assert.equal(big.yieldTodayWh, 500);
  assert.equal(big.loadCurrent, null);
});

test("AC charger decrypted payload", () => {
  const r = parseAcCharger(fromHex("060046a500ffffffffffffbdffeb3d1f"));
  assert.deepEqual(r.outputs, [{ voltage: 13.5, current: 0.5 }]);
  assert.equal(r.temperature, 21);
});

test("multi-block payloads use a little-endian counter", async () => {
  // Reference keystream built with AES-ECB over little-endian counter blocks (as PyCryptodome's
  // Counter.new(128, little_endian=True) does), here for iv=0xffff so the 2nd block carries.
  const { createCipheriv } = await import("node:crypto");
  const key = parseKey("adeccb947395801a4dd45a2eaa44bf17");
  const plain = Uint8Array.from({ length: 24 }, (_, i) => i);
  const ks = [];
  for (const ctr of [0xffff, 0x10000]) {
    const block = Buffer.alloc(16);
    block.writeUInt32LE(ctr, 0);
    const c = createCipheriv("aes-128-ecb", Buffer.from(key), null);
    c.setAutoPadding(false);
    ks.push(...c.update(block));
  }
  const enc = plain.map((b, i) => b ^ ks[i]);
  const adv = parseAdvertisement(Uint8Array.from([0x10, 0, 0x42, 0xa0, 1, 0xff, 0xff, key[0], ...enc]));
  assert.deepEqual(Array.from(await decrypt(adv, key)), Array.from(plain));
});
