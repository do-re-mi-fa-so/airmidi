import {
  BLE_MIDI_DATA_IO_CHARACTERISTIC_UUID,
  BLE_MIDI_SERVICE_UUID,
  DEFAULT_MAX_PACKET_SIZE,
} from "./constants";
import { encodeBleMidiPackets, type EncodableMessage } from "./encoder";
import { BleMidiParser } from "./parser";
import type { MidiTimestampedMessage } from "./types";

export class MidiMessageEvent extends CustomEvent<MidiTimestampedMessage> {
  constructor(detail: MidiTimestampedMessage) {
    super("midimessage", { detail });
  }
}

export interface RequestDeviceOptions {
  /** Overrides the default BLE-MIDI service filter (e.g. to also filter by name). */
  filters?: BluetoothLEScanFilter[];
}

/** Opens the browser's Bluetooth device picker, scoped to BLE-MIDI peripherals. */
export async function requestBleMidiDevice(
  options: RequestDeviceOptions = {}
): Promise<BluetoothDevice> {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth is not available in this browser.");
  }
  return navigator.bluetooth.requestDevice({
    filters: options.filters?.length ? options.filters : [{ services: [BLE_MIDI_SERVICE_UUID] }],
    optionalServices: [BLE_MIDI_SERVICE_UUID],
  });
}

/**
 * A connected BLE-MIDI peripheral. Emits `midimessage` events (see
 * {@link MidiMessageEvent}) and `disconnected` on GATT disconnect.
 */
export class BleMidiConnection extends EventTarget {
  private readonly parser = new BleMidiParser();
  private readonly onNotify = (event: Event): void => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    const value = characteristic.value;
    if (!value) return;
    for (const message of this.parser.parsePacket(value)) {
      this.dispatchEvent(new MidiMessageEvent(message));
    }
  };

  private constructor(
    private readonly device: BluetoothDevice,
    private readonly characteristic: BluetoothRemoteGATTCharacteristic,
    private readonly maxPacketSize: number
  ) {
    super();
    this.device.addEventListener("gattserverdisconnected", () => {
      this.dispatchEvent(new Event("disconnected"));
    });
  }

  static async connect(
    device: BluetoothDevice,
    maxPacketSize: number = DEFAULT_MAX_PACKET_SIZE
  ): Promise<BleMidiConnection> {
    if (!device.gatt) throw new Error("Device does not expose a GATT server.");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_MIDI_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(
      BLE_MIDI_DATA_IO_CHARACTERISTIC_UUID
    );
    const connection = new BleMidiConnection(device, characteristic, maxPacketSize);
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", connection.onNotify);
    return connection;
  }

  get deviceName(): string | undefined {
    return this.device.name ?? undefined;
  }

  get connected(): boolean {
    return this.device.gatt?.connected ?? false;
  }

  /** Sends one or more raw MIDI messages, framing/chunking them as BLE-MIDI packets. */
  async send(messages: EncodableMessage | EncodableMessage[]): Promise<void> {
    const list = Array.isArray(messages) ? messages : [messages];
    const packets = encodeBleMidiPackets(list, this.maxPacketSize);
    for (const packet of packets) {
      // Uint8Array<ArrayBufferLike> vs. lib.dom's BufferSource<ArrayBuffer> is a type-only
      // mismatch (TS 5.7+); Uint8Array satisfies BufferSource at runtime.
      await this.characteristic.writeValueWithoutResponse(packet as BufferSource);
    }
  }

  disconnect(): void {
    this.characteristic.removeEventListener("characteristicvaluechanged", this.onNotify);
    this.parser.reset();
    this.device.gatt?.disconnect();
  }
}

/** Convenience helper: opens the device picker and connects in one step. */
export async function connectBleMidi(
  options: RequestDeviceOptions = {}
): Promise<BleMidiConnection> {
  const device = await requestBleMidiDevice(options);
  return BleMidiConnection.connect(device);
}
