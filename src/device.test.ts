import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BleMidiConnection } from "./device";

function makeFakeDevice() {
  const characteristic = {
    startNotifications: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const service = {
    getCharacteristic: vi.fn().mockResolvedValue(characteristic),
  };
  const server = {
    getPrimaryService: vi.fn().mockResolvedValue(service),
  };
  const gatt = {
    connect: vi.fn().mockResolvedValue(server),
    disconnect: vi.fn(),
    connected: true,
  };
  const device = {
    name: "Fake BLE-MIDI",
    gatt,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { device, gatt, characteristic };
}

describe("BleMidiConnection.connect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not disconnect a successful connection once the connect timeout elapses", async () => {
    const { device, gatt } = makeFakeDevice();

    const connection = await BleMidiConnection.connect(device as never, { timeoutMs: 1000 });
    expect(connection).toBeInstanceOf(BleMidiConnection);

    // The Promise.race's losing timer must be cleared on success — advancing
    // well past timeoutMs should NOT trigger the timeout's disconnect().
    await vi.advanceTimersByTimeAsync(5000);
    expect(gatt.disconnect).not.toHaveBeenCalled();
  });

  it("aborts and disconnects when connect genuinely hangs past the timeout", async () => {
    const { device, gatt } = makeFakeDevice();
    gatt.connect.mockReturnValue(new Promise(() => {})); // never resolves

    const connectPromise = BleMidiConnection.connect(device as never, { timeoutMs: 1000 });
    // Attach the rejection handler before advancing timers, so the rejection
    // (fired synchronously inside the timer callback) is never briefly unhandled.
    const assertion = expect(connectPromise).rejects.toThrow(/Timed out connecting/);
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);
  });
});
