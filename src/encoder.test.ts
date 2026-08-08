import { describe, expect, it } from "vitest";
import { encodeBleMidiPackets } from "./encoder";
import { BleMidiParser } from "./parser";

describe("encodeBleMidiPackets", () => {
  it("encodes a single Note On into one packet decodable by BleMidiParser", () => {
    const packets = encodeBleMidiPackets([{ data: [0x90, 0x3c, 0x40], timestamp: 13 }]);
    expect(packets).toHaveLength(1);
    expect(Array.from(packets[0]!)).toEqual([0x80, 0x8d, 0x90, 0x3c, 0x40]);

    const parser = new BleMidiParser();
    const messages = parser.parsePacket(packets[0]!);
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0]!.data)).toEqual([0x90, 0x3c, 0x40]);
    expect(messages[0]!.timestamp).toBe(13);
  });

  it("round-trips multiple messages across a tight packet size limit", () => {
    const original = [
      { data: [0x90, 0x3c, 0x40], timestamp: 10 },
      { data: [0x80, 0x3c, 0x00], timestamp: 20 },
      { data: [0xb0, 0x07, 0x7f], timestamp: 30 },
    ];
    const packets = encodeBleMidiPackets(original, 8); // forces multiple packets
    expect(packets.length).toBeGreaterThan(1);

    const parser = new BleMidiParser();
    const decoded = packets.flatMap((packet) => parser.parsePacket(packet));
    expect(decoded.map((m) => Array.from(m.data))).toEqual(original.map((m) => m.data));
    expect(decoded.map((m) => m.timestamp)).toEqual(original.map((m) => m.timestamp));
  });

  it("chunks a SysEx message across packets when it doesn't fit in one", () => {
    const sysex = [0xf0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0xf7];
    const packets = encodeBleMidiPackets([{ data: sysex, timestamp: 5 }], 8);
    expect(packets.length).toBeGreaterThan(1);

    const parser = new BleMidiParser();
    const decoded = packets.flatMap((packet) => parser.parsePacket(packet));
    expect(decoded).toHaveLength(1);
    expect(Array.from(decoded[0]!.data)).toEqual(sysex);
  });

  it("wraps timestamps modulo 8192", () => {
    const packets = encodeBleMidiPackets([{ data: [0x90, 0x3c, 0x40], timestamp: 8192 + 5 }]);
    const parser = new BleMidiParser();
    const [message] = parser.parsePacket(packets[0]!);
    expect(message!.timestamp).toBe(5);
  });
});
