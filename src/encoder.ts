import { DEFAULT_MAX_PACKET_SIZE } from "./constants";

export interface EncodableMessage {
  /** Raw MIDI status + data bytes (no BLE-MIDI framing). SysEx must include both 0xF0 and 0xF7. */
  data: Uint8Array | number[];
  /** Timestamp in ms; wrapped mod 8192. Defaults to `now`. */
  timestamp?: number;
}

function timestampParts(timestampMs: number): { high: number; low: number } {
  const t = ((timestampMs % 8192) + 8192) % 8192;
  return { high: (t >> 7) & 0x3f, low: t & 0x7f };
}

/**
 * Packs MIDI messages into BLE-MIDI packets no larger than `maxPacketSize`
 * bytes (the negotiated ATT MTU minus 3 bytes of ATT overhead; 20 is a safe
 * default for the un-negotiated minimum MTU of 23). SysEx messages are
 * chunked across multiple packets when they don't fit in one. Running
 * status is never used on encode, so every message carries its own status
 * byte and is unambiguous to decode.
 */
export function encodeBleMidiPackets(
  messages: EncodableMessage[],
  maxPacketSize: number = DEFAULT_MAX_PACKET_SIZE,
  now: number = Date.now()
): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let current: number[] = [];
  let headerHigh: number | null = null;

  const flush = () => {
    if (current.length > 1) packets.push(Uint8Array.from(current));
    current = [];
    headerHigh = null;
  };

  const ensureHeader = (high: number) => {
    if (headerHigh === null) {
      headerHigh = high;
      current.push(0x80 | high);
    } else if (headerHigh !== high) {
      flush();
      headerHigh = high;
      current.push(0x80 | high);
    }
  };

  for (const message of messages) {
    const bytes =
      message.data instanceof Uint8Array ? message.data : Uint8Array.from(message.data);
    if (bytes.length === 0) continue;
    const { high, low } = timestampParts(message.timestamp ?? now);

    if (bytes[0] === 0xf0) {
      const lastIndex = bytes.length - 1; // expected to be 0xf7
      ensureHeader(high);
      current.push(0x80 | low, bytes[0]);
      let offset = 1;
      while (offset < lastIndex) {
        if (current.length >= maxPacketSize) {
          flush();
          ensureHeader(high);
        }
        current.push(bytes[offset]!);
        offset++;
      }
      if (current.length + 2 > maxPacketSize) {
        flush();
        ensureHeader(high);
      }
      current.push(0x80 | low, bytes[lastIndex]!);
      continue;
    }

    ensureHeader(high);
    const framed = [0x80 | low, ...bytes];
    if (current.length + framed.length > maxPacketSize) {
      flush();
      ensureHeader(high);
    }
    current.push(...framed);
  }

  flush();
  return packets;
}
