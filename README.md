# airmidi

Connect to BLE-MIDI peripherals directly from the browser via the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) — no OS-level MIDI pairing required.

This is a different approach from wrapping [`navigator.requestMIDIAccess()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMIDIAccess) (what [`webmidi`](https://webmidijs.org/) does): it talks to the [BLE-MIDI GATT service](https://midi.org/specifications/midi-transports-specifications/bluetooth-le-midi) directly, so it works anywhere Web Bluetooth is supported, even on platforms where the Web MIDI API doesn't surface BLE devices.

## Browser support

Requires [Web Bluetooth](https://caniuse.com/web-bluetooth) — Chrome, Edge, Opera, and Android WebView. Not supported in Safari or Firefox.

## Install

```sh
npm install airmidi
```

## Usage

```ts
import { connectBleMidi } from "airmidi";

// Opens the browser's Bluetooth device picker, scoped to BLE-MIDI devices,
// and connects to the MIDI I/O characteristic.
const connection = await connectBleMidi();

connection.addEventListener("midimessage", (event) => {
  const { data, timestamp } = event.detail;
  console.log("received", Array.from(data), "at", timestamp);
});

connection.addEventListener("disconnected", () => {
  console.log(`${connection.deviceName} disconnected`);
});

// Send a Note On (channel 0, note 60, velocity 100).
await connection.send({ data: [0x90, 0x3c, 0x64] });

connection.disconnect();
```

### Lower-level pieces

`requestBleMidiDevice()` and `BleMidiConnection.connect()` are exposed separately if you want to manage device selection and connection independently:

```ts
import { requestBleMidiDevice, BleMidiConnection } from "airmidi";

const device = await requestBleMidiDevice();
const connection = await BleMidiConnection.connect(device);
```

`BleMidiParser` and `encodeBleMidiPackets` implement the raw BLE-MIDI packet framing (header/timestamp bytes, running status, SysEx chunking) and have no Web Bluetooth dependency, so they can be reused outside the browser (e.g. against a `noble`-based GATT connection in Node) or tested in isolation.

## Development

```sh
npm install
npm test        # vitest
npm run build   # tsup -> dist/
npm run typecheck
```

## License

[MIT](./LICENSE)
