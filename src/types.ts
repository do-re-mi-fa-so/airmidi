export interface MidiTimestampedMessage {
  /** Raw MIDI status + data bytes (no BLE-MIDI framing). */
  data: Uint8Array;
  /** 13-bit BLE-MIDI timestamp in ms; wraps at 8192. */
  timestamp: number;
}
