import { connectBleMidi, BleMidiParser, encodeBleMidiPackets } from "./airmidi.js";

const $ = (sel) => document.querySelector(sel);

const connectBtn = $("#connect-btn");
const disconnectBtn = $("#disconnect-btn");
const statusPill = $("#status-pill");
const deviceNameEl = $("#device-name");
const supportWarning = $("#support-warning");
const logEl = $("#log");

const MAX_LOG_ROWS = 60;

let connection = null;

if (!navigator.bluetooth) {
  supportWarning.style.display = "block";
  connectBtn.disabled = true;
}

function setStatus(state, label) {
  statusPill.dataset.state = state;
  statusPill.textContent = label;
}

connectBtn.addEventListener("click", async () => {
  setStatus("connecting", "Connecting…");
  connectBtn.disabled = true;
  try {
    connection = await connectBleMidi();
    onConnected();
  } catch (err) {
    setStatus("idle", "Not connected");
    logError(err);
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", () => {
  connection?.disconnect();
});

function onConnected() {
  setStatus("connected", "Connected");
  deviceNameEl.textContent = connection.deviceName ?? "Unnamed device";
  connectBtn.hidden = true;
  disconnectBtn.hidden = false;

  connection.addEventListener("midimessage", (event) => {
    handleIncomingMessage(event.detail);
  });

  connection.addEventListener("disconnected", () => {
    setStatus("idle", "Not connected");
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
    deviceNameEl.textContent = "";
  });
}

// ---------------------------------------------------------------------------
// Piano
// ---------------------------------------------------------------------------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const WHITE_SEMITONES = new Set([0, 2, 4, 5, 7, 9, 11]);
const START_NOTE = 60; // C4
const END_NOTE = 84; // C6

const pianoEl = $("#piano");
const keyElements = new Map();
const locallyPressed = new Set();

function noteLabel(note) {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

function buildPiano() {
  const whiteNotes = [];
  const blackNotes = [];
  for (let note = START_NOTE; note <= END_NOTE; note++) {
    (WHITE_SEMITONES.has(note % 12) ? whiteNotes : blackNotes).push(note);
  }
  const whiteWidth = 100 / whiteNotes.length;

  for (const note of whiteNotes) {
    const key = document.createElement("div");
    key.className = "key white";
    key.style.width = `${whiteWidth}%`;
    key.title = noteLabel(note);
    pianoEl.appendChild(key);
    keyElements.set(note, key);
    bindKeyEvents(key, note);
  }

  for (const note of blackNotes) {
    const leftWhiteIndex = whiteNotes.filter((w) => w < note).length - 1;
    const width = whiteWidth * 0.62;
    const key = document.createElement("div");
    key.className = "key black";
    key.style.width = `${width}%`;
    key.style.left = `${(leftWhiteIndex + 1) * whiteWidth - width / 2}%`;
    key.title = noteLabel(note);
    pianoEl.appendChild(key);
    keyElements.set(note, key);
    bindKeyEvents(key, note);
  }
}

function bindKeyEvents(key, note) {
  const press = (ev) => {
    ev.preventDefault();
    if (locallyPressed.has(note)) return;
    locallyPressed.add(note);
    key.classList.add("pressed-local");
    void connection?.send({ data: [0x90, note, 100] });
  };
  const release = () => {
    if (!locallyPressed.has(note)) return;
    locallyPressed.delete(note);
    key.classList.remove("pressed-local");
    void connection?.send({ data: [0x80, note, 0] });
  };
  key.addEventListener("pointerdown", press);
  key.addEventListener("pointerup", release);
  key.addEventListener("pointerleave", release);
}

buildPiano();

function flashKey(note, isOn, velocity) {
  const key = keyElements.get(note);
  if (!key) return;
  if (isOn) {
    key.classList.add("pressed-remote");
    key.style.setProperty("--velocity", Math.max(0.35, velocity / 127));
  } else {
    key.classList.remove("pressed-remote");
    key.style.removeProperty("--velocity");
  }
}

// ---------------------------------------------------------------------------
// Decoding + log
// ---------------------------------------------------------------------------

const REALTIME_LABELS = {
  0xf8: "Timing Clock",
  0xfa: "Start",
  0xfb: "Continue",
  0xfc: "Stop",
  0xfe: "Active Sensing",
  0xff: "Reset",
};

function describeMessage(data) {
  const status = data[0];
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;

  if (status >= 0xf8) return { label: REALTIME_LABELS[status] ?? "Real-Time", detail: "" };
  if (status === 0xf0) return { label: "SysEx", detail: `${data.length} bytes` };
  if (type === 0x90 && d2 > 0) {
    return { label: "Note On", detail: `${noteLabel(d1)} vel ${d2}`, channel, note: d1, velocity: d2, isNoteOn: true };
  }
  if (type === 0x80 || (type === 0x90 && d2 === 0)) {
    return { label: "Note Off", detail: noteLabel(d1), channel, note: d1, isNoteOn: false };
  }
  if (type === 0xb0) return { label: "Control Change", detail: `CC${d1} = ${d2}`, channel };
  if (type === 0xe0) return { label: "Pitch Bend", detail: `${((d2 << 7) | d1) - 8192}`, channel };
  if (type === 0xc0) return { label: "Program Change", detail: `#${d1}`, channel };
  if (type === 0xa0) return { label: "Poly Aftertouch", detail: `${noteLabel(d1)} = ${d2}`, channel };
  if (type === 0xd0) return { label: "Channel Aftertouch", detail: `${d1}`, channel };
  return { label: "Unknown", detail: "" };
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function handleIncomingMessage(message) {
  const decoded = describeMessage(message.data);
  appendLogRow(message, decoded);
  if (decoded.note !== undefined) {
    flashKey(decoded.note, decoded.isNoteOn, decoded.velocity ?? 0);
  }
}

function appendLogRow(message, decoded) {
  const row = document.createElement("div");
  row.className = "log-row";
  const channelPart = decoded.channel ? ` · ch${decoded.channel}` : "";
  row.innerHTML = `<span class="log-time">${message.timestamp}ms</span><span class="log-label">${decoded.label}</span><span class="log-detail">${decoded.detail}${channelPart}</span><span class="log-hex">${toHex(message.data)}</span>`;
  logEl.prepend(row);
  while (logEl.children.length > MAX_LOG_ROWS) logEl.lastChild.remove();
}

function logError(err) {
  console.error(err);
  const row = document.createElement("div");
  row.className = "log-row log-row--error";
  row.textContent = err?.message ?? String(err);
  logEl.prepend(row);
}

// ---------------------------------------------------------------------------
// Playground (works without a connected device)
// ---------------------------------------------------------------------------

function parseHexList(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const value = parseInt(token, 16);
      if (Number.isNaN(value) || value < 0 || value > 0xff) {
        throw new Error(`"${token}" is not a valid hex byte`);
      }
      return value;
    });
}

$("#decode-btn").addEventListener("click", () => {
  const output = $("#decode-output");
  try {
    const bytes = Uint8Array.from(parseHexList($("#decode-input").value));
    const messages = new BleMidiParser().parsePacket(bytes);
    output.textContent = messages.length
      ? messages.map((m) => `[${m.timestamp}ms] ${toHex(m.data)}`).join("\n")
      : "(no messages decoded)";
  } catch (err) {
    output.textContent = `Error: ${err.message}`;
  }
});

$("#encode-btn").addEventListener("click", () => {
  const output = $("#encode-output");
  try {
    const bytes = parseHexList($("#encode-input").value);
    const packets = encodeBleMidiPackets([{ data: bytes }]);
    output.textContent = packets.map((p) => toHex(p)).join("\n");
  } catch (err) {
    output.textContent = `Error: ${err.message}`;
  }
});
