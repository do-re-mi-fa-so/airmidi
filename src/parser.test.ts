import { describe, expect, it } from "vitest";
import { BleMidiParser } from "./parser";

describe("BleMidiParser", () => {
  it("parses a single Note On message", () => {
    const parser = new BleMidiParser();
    // header(ts_high=0), ts_low=0x0D, Note On ch0 vel 0x40
    const packet = Uint8Array.of(0x80, 0x8d, 0x90, 0x3c, 0x40);
    const messages = parser.parsePacket(packet);
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0]!.data)).toEqual([0x90, 0x3c, 0x40]);
    expect(messages[0]!.timestamp).toBe(0x0d);
  });

  it("parses three full Control Change messages (worked example)", () => {
    const parser = new BleMidiParser();
    const packet = Uint8Array.of(
      0xb9, 0xfd, 0xb0, 0x62, 0x48, 0xfd, 0xb0, 0x06, 0x00, 0xfd, 0xb0, 0x26, 0x0a
    );
    const messages = parser.parsePacket(packet);
    expect(messages.map((m) => Array.from(m.data))).toEqual([
      [0xb0, 0x62, 0x48],
      [0xb0, 0x06, 0x00],
      [0xb0, 0x26, 0x0a],
    ]);
  });

  it("applies running status when the status byte is omitted", () => {
    const parser = new BleMidiParser();
    // header, ts, NoteOn 0x90 3C 40, ts, (running status) 40 00 (note off velocity via running NoteOn w/ vel 0)
    const packet = Uint8Array.of(0x80, 0x81, 0x90, 0x3c, 0x40, 0x82, 0x3c, 0x00);
    const messages = parser.parsePacket(packet);
    expect(messages.map((m) => Array.from(m.data))).toEqual([
      [0x90, 0x3c, 0x40],
      [0x90, 0x3c, 0x00],
    ]);
  });

  it("parses a System Real-Time message interleaved with other messages", () => {
    const parser = new BleMidiParser();
    // header, ts, Timing Clock (0xF8, no data), ts, Note On
    const packet = Uint8Array.of(0x80, 0x81, 0xf8, 0x82, 0x90, 0x3c, 0x40);
    const messages = parser.parsePacket(packet);
    expect(messages.map((m) => Array.from(m.data))).toEqual([[0xf8], [0x90, 0x3c, 0x40]]);
  });

  it("parses a SysEx message contained in a single packet", () => {
    const parser = new BleMidiParser();
    // header, ts, F0, 01 02 03 (raw data, no MSB), ts, F7
    const packet = Uint8Array.of(0x80, 0x81, 0xf0, 0x01, 0x02, 0x03, 0x82, 0xf7);
    const messages = parser.parsePacket(packet);
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0]!.data)).toEqual([0xf0, 0x01, 0x02, 0x03, 0xf7]);
  });

  it("reassembles a SysEx message split across two packets", () => {
    const parser = new BleMidiParser();
    const first = Uint8Array.of(0x80, 0x81, 0xf0, 0x01, 0x02);
    const second = Uint8Array.of(0x80, 0x03, 0x04, 0x82, 0xf7);
    expect(parser.parsePacket(first)).toHaveLength(0);
    const messages = parser.parsePacket(second);
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0]!.data)).toEqual([0xf0, 0x01, 0x02, 0x03, 0x04, 0xf7]);
  });

  it("does not carry running status across packets", () => {
    const parser = new BleMidiParser();
    parser.parsePacket(Uint8Array.of(0x80, 0x81, 0x90, 0x3c, 0x40));
    // New packet omits the status byte with no running status established yet -> dropped.
    const messages = parser.parsePacket(Uint8Array.of(0x80, 0x82, 0x3c, 0x00));
    expect(messages).toHaveLength(0);
  });
});
