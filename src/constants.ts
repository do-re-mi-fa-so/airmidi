/**
 * UUIDs from the MMA/AmeiNRAi "MIDI over Bluetooth Low Energy" spec.
 * https://midi.org/specifications/midi-transports-specifications/bluetooth-le-midi
 */
export const BLE_MIDI_SERVICE_UUID = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
export const BLE_MIDI_DATA_IO_CHARACTERISTIC_UUID =
  "7772e5db-3868-4112-a1a9-f2669d106bf3";

/** Conservative default when the GATT MTU can't be determined. */
export const DEFAULT_MAX_PACKET_SIZE = 20;

/**
 * Some platforms silently hang during GATT connect (stale pairing, a
 * peripheral already connected elsewhere) instead of rejecting. Give up
 * after this long rather than leaving callers waiting forever.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
