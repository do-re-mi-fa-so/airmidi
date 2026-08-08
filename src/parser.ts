import type { MidiTimestampedMessage } from "./types";

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const REALTIME_STATUS_MIN = 0xf8;

function channelVoiceDataLength(status: number): number {
  switch (status & 0xf0) {
    case 0x80: // Note Off
    case 0x90: // Note On
    case 0xa0: // Poly Aftertouch
    case 0xb0: // Control Change
    case 0xe0: // Pitch Bend
      return 2;
    case 0xc0: // Program Change
    case 0xd0: // Channel Aftertouch
      return 1;
    default:
      return -1;
  }
}

function systemCommonDataLength(status: number): number {
  switch (status) {
    case 0xf1: // MTC Quarter Frame
    case 0xf3: // Song Select
      return 1;
    case 0xf2: // Song Position Pointer
      return 2;
    case 0xf6: // Tune Request
      return 0;
    default:
      return -1;
  }
}

function toUint8Array(packet: DataView | Uint8Array): Uint8Array {
  return packet instanceof DataView
    ? new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength)
    : packet;
}

/**
 * Stateful decoder for the MMA BLE-MIDI packet framing (header byte,
 * timestamp bytes, running status, SysEx). State must persist across
 * packets on the same characteristic because a single SysEx message can
 * span multiple GATT notifications.
 */
export class BleMidiParser {
  private runningStatus: number | undefined;
  private sysexBuffer: number[] | null = null;

  /** Decodes one BLE-MIDI GATT notification payload into timestamped MIDI messages. */
  parsePacket(packet: DataView | Uint8Array): MidiTimestampedMessage[] {
    const data = toUint8Array(packet);
    if (data.length === 0) return [];

    const messages: MidiTimestampedMessage[] = [];
    const timestampHigh = (data[0]! & 0x3f) << 7;
    // Running status does not carry across packets.
    this.runningStatus = undefined;

    let i = 1;
    while (i < data.length) {
      const byte = data[i]!;

      if (this.sysexBuffer && (byte & 0x80) === 0) {
        this.sysexBuffer.push(byte);
        i++;
        continue;
      }

      if ((byte & 0x80) === 0) {
        // Expected a timestamp byte; drop and resync.
        i++;
        continue;
      }

      const timestampLow = byte & 0x7f;
      i++;
      if (i >= data.length) break;

      let status = data[i]!;
      if ((status & 0x80) !== 0) {
        i++;
      } else if (this.sysexBuffer) {
        // Timestamp byte immediately followed by SysEx continuation data;
        // let the top-of-loop branch consume it next iteration.
        continue;
      } else if (this.runningStatus !== undefined) {
        status = this.runningStatus;
      } else {
        continue;
      }

      const timestamp = timestampHigh | timestampLow;

      if (status >= REALTIME_STATUS_MIN) {
        messages.push({ data: Uint8Array.of(status), timestamp });
        continue;
      }

      if (status === SYSEX_START) {
        this.sysexBuffer = [SYSEX_START];
        this.runningStatus = undefined;
        continue;
      }

      if (status === SYSEX_END) {
        if (this.sysexBuffer) {
          this.sysexBuffer.push(SYSEX_END);
          messages.push({ data: Uint8Array.from(this.sysexBuffer), timestamp });
          this.sysexBuffer = null;
        }
        continue;
      }

      if (status >= 0x80 && status < 0xf0) {
        this.runningStatus = status;
        const len = channelVoiceDataLength(status);
        const bytes = [status];
        for (let n = 0; n < len && i < data.length; n++, i++) bytes.push(data[i]!);
        messages.push({ data: Uint8Array.from(bytes), timestamp });
        continue;
      }

      // System Common (0xf1-0xf6) cancels running status.
      this.runningStatus = undefined;
      const len = systemCommonDataLength(status);
      const bytes = [status];
      for (let n = 0; n < len && i < data.length; n++, i++) bytes.push(data[i]!);
      messages.push({ data: Uint8Array.from(bytes), timestamp });
    }

    return messages;
  }

  /** Discards any in-progress SysEx/running-status state, e.g. after a reconnect. */
  reset(): void {
    this.runningStatus = undefined;
    this.sysexBuffer = null;
  }
}
