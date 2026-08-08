import {
  BLE_MIDI_DATA_IO_CHARACTERISTIC_UUID,
  BLE_MIDI_SERVICE_UUID,
  DEFAULT_CONNECT_TIMEOUT_MS,
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
  /**
   * List every nearby Bluetooth device instead of filtering by the BLE-MIDI
   * service UUID. Some peripherals connect and work fine but never advertise
   * the MIDI service in their advertisement packet, which hides them from
   * the default filtered picker. Takes precedence over `filters`.
   */
  wideScan?: boolean;
}

/** Opens the browser's Bluetooth device picker, scoped to BLE-MIDI peripherals. */
export async function requestBleMidiDevice(
  options: RequestDeviceOptions = {}
): Promise<BluetoothDevice> {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth is not available in this browser.");
  }
  if (options.wideScan) {
    return navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_MIDI_SERVICE_UUID],
    });
  }
  return navigator.bluetooth.requestDevice({
    filters: options.filters?.length ? options.filters : [{ services: [BLE_MIDI_SERVICE_UUID] }],
    optionalServices: [BLE_MIDI_SERVICE_UUID],
  });
}

export interface ConnectOptions {
  /** Max bytes per outgoing BLE-MIDI packet. */
  maxPacketSize?: number;
  /**
   * Abort and throw if the GATT connect/service/characteristic/notify
   * sequence hasn't finished within this many milliseconds, instead of
   * hanging forever. Set to 0 to disable. Defaults to
   * {@link DEFAULT_CONNECT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * A connected BLE-MIDI peripheral. Emits `midimessage` events (see
 * {@link MidiMessageEvent}) and `disconnected` on GATT disconnect.
 */
export class BleMidiConnection extends EventTarget {
  private readonly parser = new BleMidiParser();
  // GATT tolerates no overlap: firing writeValueWithoutResponse concurrently
  // (e.g. two keys pressed in quick succession) floods the peripheral's write
  // queue and can wedge the link into a disconnect. Chain writes so each
  // waits for the previous one to settle.
  private writeChain: Promise<void> = Promise.resolve();
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
    options: ConnectOptions = {}
  ): Promise<BleMidiConnection> {
    const {
      maxPacketSize = DEFAULT_MAX_PACKET_SIZE,
      timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    } = options;
    if (!device.gatt) throw new Error("Device does not expose a GATT server.");

    const attempt = (async () => {
      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService(BLE_MIDI_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(
        BLE_MIDI_DATA_IO_CHARACTERISTIC_UUID
      );
      const connection = new BleMidiConnection(device, characteristic, maxPacketSize);
      await characteristic.startNotifications();
      characteristic.addEventListener("characteristicvaluechanged", connection.onNotify);
      return connection;
    })();

    if (!timeoutMs) return attempt;

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Best-effort: abort whatever GATT operation is stuck, so the next
        // attempt doesn't inherit the same wedged state.
        device.gatt?.disconnect();
        reject(
          new Error(
            `Timed out connecting to ${device.name ?? "device"} ` +
              `(no response after ${timeoutMs}ms). It may already be connected ` +
              "elsewhere, or stuck pairing at the OS level."
          )
        );
      }, timeoutMs);
    });

    // Promise.race doesn't cancel the loser: without clearing this timer, it
    // keeps running and would forcibly disconnect a connection that had
    // already succeeded, exactly `timeoutMs` after the call to `connect()`.
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer!);
    }
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
    const chain = this.writeChain.then(async () => {
      for (const packet of packets) {
        // Uint8Array<ArrayBufferLike> vs. lib.dom's BufferSource<ArrayBuffer> is a type-only
        // mismatch (TS 5.7+); Uint8Array satisfies BufferSource at runtime.
        await this.characteristic.writeValueWithoutResponse(packet as BufferSource);
      }
    });
    // Swallow so one failed write doesn't wedge the chain for later sends;
    // the caller still observes the rejection via the returned `chain`.
    this.writeChain = chain.catch(() => {});
    return chain;
  }

  disconnect(): void {
    this.characteristic.removeEventListener("characteristicvaluechanged", this.onNotify);
    this.parser.reset();
    this.device.gatt?.disconnect();
  }
}

/** Convenience helper: opens the device picker and connects in one step. */
export async function connectBleMidi(
  options: RequestDeviceOptions & ConnectOptions = {}
): Promise<BleMidiConnection> {
  const device = await requestBleMidiDevice(options);
  return BleMidiConnection.connect(device, options);
}
