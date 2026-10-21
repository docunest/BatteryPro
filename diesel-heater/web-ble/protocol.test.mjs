// Run with: node --test web-ble/
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommand, parseStatus, xorCrypt, CMD } from "./protocol.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

test("known command packets", () => {
  assert.equal(hex(buildCommand(CMD.STATUS)), "aa550c220100002f");
  assert.equal(hex(buildCommand(CMD.POWER, 1)), "aa550c2203010032");
  assert.equal(hex(buildCommand(CMD.POWER, 0)), "aa550c2203000031");
});

test("AA55 level frame", () => {
  const s = parseStatus(fromHex("aa5500010303e8030108007e00c800190000"));
  assert.equal(s.protocol, "AA55");
  assert.equal(s.runningStep, "running");
  assert.equal(s.level, 8);
  assert.equal(s.voltage, 12.6);
  assert.equal(s.roomTemp, 25);
  assert.equal(s.errorCode, 3);
});

test("AA55 negative temps", () => {
  const s = parseStatus(fromHex("aa5500010003d204021704f0009cfffbff00"));
  assert.equal(s.setTemp, 23);
  assert.equal(s.caseTemp, -100);
  assert.equal(s.roomTemp, -5);
});

test("encrypted AA55", () => {
  const d = new Uint8Array(48);
  d[0] = 0xaa; d[1] = 0x55; d[3] = 1; d[5] = 3; d[8] = 1; d[10] = 6;
  d[12] = 0x7c; d[14] = 0x96; d[33] = 0xd7;
  const s = parseStatus(xorCrypt(d));
  assert.equal(s.protocol, "AA55enc");
  assert.equal(s.level, 6);
  assert.equal(s.voltage, 12.4);
  assert.equal(s.roomTemp, 21.5);
});
