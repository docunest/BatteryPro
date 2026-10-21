from heaterbridge import protocol as p


def test_known_command_packets():
    # Packets captured from the AirHeaterBLE app with default passkey 1234
    assert p.cmd_status().hex() == "aa550c220100002f"
    assert p.cmd_power(True).hex() == "aa550c2203010032"
    assert p.cmd_power(False).hex() == "aa550c2203000031"


def test_level_and_mode_packets():
    assert p.cmd_level(7) == bytes([0xAA, 0x55, 12, 34, 4, 7, 0, (12 + 34 + 4 + 7) % 256])
    assert p.cmd_mode(p.RunningMode.LEVEL)[4:6] == bytes([2, 1])


def test_custom_passkey():
    pkt = p.build_command(p.Command.STATUS, 0, 9876)
    assert pkt[2:4] == bytes([98, 76])
    assert pkt[7] == (98 + 76 + 1) % 256


def test_level_out_of_range():
    import pytest
    with pytest.raises(ValueError):
        p.cmd_level(11)


def test_parse_aa55_level_mode():
    s = p.parse_status(bytes.fromhex("aa5500010303e8030108007e00c800190000"))
    assert s.protocol == "AA55"
    assert s.running and s.running_step == "running" and s.heating
    assert s.running_mode == "level" and s.level == 8
    assert s.voltage == 12.6 and s.case_temp == 200 and s.room_temp == 25
    assert s.error_code == 3 and s.error.startswith("E3")


def test_parse_aa55_temperature_mode_negative_temps():
    s = p.parse_status(bytes.fromhex("aa5500010003d204021704f0009cfffbff00"))
    assert s.running_mode == "temperature" and s.set_temp == 23 and s.level == 5
    assert s.case_temp == -100 and s.room_temp == -5 and s.voltage == 24.0


def test_parse_aa66_plain():
    d = bytearray(20)
    d[0], d[1] = 0xAA, 0x66
    d[3], d[5], d[8], d[9] = 1, 3, 1, 4
    d[11], d[12] = 0x7E, 0x00  # 12.6 V
    d[13], d[14] = 0xE8, 0x03  # 1000 -> 100.0 °C (0.1 °C scale)
    d[15], d[16] = 19, 0
    d[17] = 0
    s = p.parse_status(bytes(d))
    assert s.protocol == "AA66" and s.level == 4 and s.case_temp == 100.0 and s.room_temp == 19
    assert s.error is None


def test_parse_encrypted_aa55():
    d = bytearray(48)
    d[0], d[1] = 0xAA, 0x55
    d[3], d[5], d[8], d[10] = 1, 3, 1, 6
    d[11], d[12] = 0x00, 0x7C  # 12.4 V (big endian)
    d[13], d[14] = 0x00, 0x96  # 150 °C
    d[32], d[33] = 0x00, 0xD7  # 21.5 °C
    s = p.parse_status(p.xor_crypt(bytes(d)))
    assert s.protocol == "AA55enc"
    assert s.level == 6 and s.voltage == 12.4 and s.case_temp == 150 and s.room_temp == 21.5


def test_parse_encrypted_aa66_error_position():
    d = bytearray(48)
    d[0], d[1] = 0xAA, 0x66
    d[10] = 1
    d[35] = 2
    s = p.parse_status(p.xor_crypt(bytes(d)))
    assert s.protocol == "AA66enc" and s.error_code == 2 and not s.running


def test_garbage_is_ignored():
    assert p.parse_status(b"\x01\x02") is None
    assert p.parse_status(bytes(20)) is None
