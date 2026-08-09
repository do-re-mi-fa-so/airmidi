import { BleMidiParser, connectBleMidi, encodeBleMidiPackets } from "./airmidi.js";

const $ = (sel) => document.querySelector(sel);

const connectBtn = $("#connect-btn");
const disconnectBtn = $("#disconnect-btn");
const statusPill = $("#status-pill");
const deviceNameEl = $("#device-name");
const supportWarning = $("#support-warning");
const wideScanToggle = $("#wide-scan-toggle");
const logEl = $("#log");
const encodeSendBtn = $("#encode-send-btn");

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
    connection = await connectBleMidi({ wideScan: wideScanToggle.checked });
    onConnected();
  } catch (err) {
    setStatus("idle", "Not connected");
    logError(err);
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", () => {
  connection?.forget();
});

// Best-effort: don't leave the device connected (and remembered) if the tab
// closes without the user hitting Disconnect. There's no guarantee this
// completes before the page is gone, but browsers give unload handlers a
// brief window and GATT disconnects happen from the OS side regardless.
window.addEventListener("pagehide", () => {
  connection?.forget();
});

function onConnected() {
  setStatus("connected", "Connected");
  deviceNameEl.textContent = connection.deviceName ?? "Unnamed device";
  connectBtn.hidden = true;
  disconnectBtn.hidden = false;
  encodeSendBtn.disabled = false;
  encodeSendBtn.title = "";

  connection.addEventListener("midimessage", (event) => {
    handleIncomingMessage(event.detail);
  });

  connection.addEventListener("disconnected", () => {
    connection = null;
    setStatus("idle", "Not connected");
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
    deviceNameEl.textContent = "";
    encodeSendBtn.disabled = true;
    encodeSendBtn.title = "Connect a device above to send";
    // A dropped link can strand notes "on" with no note-off ever arriving.
    clearAllNotes();
  });
}

// ---------------------------------------------------------------------------
// Piano
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sound — the demo has no MIDI output device, so keys are audited locally
// with a small WebAudio synth. Fires for both notes you click and notes
// received from the connected device.
// ---------------------------------------------------------------------------

const audioToggle = $("#audio-toggle");
let audioCtx = null;
const activeVoices = new Map();

function noteToFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function playNote(note, velocity) {
  if (!audioToggle.checked) return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") void audioCtx.resume();

  stopNote(note);
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.value = noteToFrequency(note);
  const peak = Math.max(0.05, Math.min(0.3, (velocity / 127) * 0.3));
  const now = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.015);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  activeVoices.set(note, { osc, gain });
}

function stopNote(note) {
  const voice = activeVoices.get(note);
  if (!voice) return;
  activeVoices.delete(note);
  const now = audioCtx.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
  voice.gain.gain.linearRampToValueAtTime(0, now + 0.05);
  voice.osc.stop(now + 0.06);
}

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

// ---------------------------------------------------------------------------
// Harmony readout — every note currently sounding, local or remote, named as
// a chord. [intervals relative to root, quality suffix]
// ---------------------------------------------------------------------------

const CHORDS = [
  [[0, 4, 7], ""], [[0, 3, 7], "m"], [[0, 3, 6], "dim"], [[0, 4, 8], "aug"],
  [[0, 5, 7], "sus4"], [[0, 2, 7], "sus2"], [[0, 7], "5"], [[0, 4], "(no5)"], [[0, 3], "m(no5)"],
  [[0, 4, 7, 11], "maj7"], [[0, 4, 7, 10], "7"], [[0, 3, 7, 10], "m7"], [[0, 3, 7, 11], "mMaj7"],
  [[0, 3, 6, 10], "m7♭5"], [[0, 3, 6, 9], "dim7"], [[0, 4, 7, 9], "6"], [[0, 3, 7, 9], "m6"],
  [[0, 2, 4, 7], "add9"], [[0, 4, 7, 10, 2], "9"], [[0, 4, 7, 11, 2], "maj9"], [[0, 3, 7, 10, 2], "m9"],
];
const chordKey = (intervals) => [...new Set(intervals)].sort((a, b) => a - b).join(",");
const CHORD_MAP = new Map(CHORDS.map(([intervals, quality]) => [chordKey(intervals), quality]));

function detectChord(notes) {
  if (!notes.length) return null;
  const bass = Math.min(...notes) % 12;
  const pitchClasses = [...new Set(notes.map((n) => n % 12))].sort((a, b) => a - b);
  if (pitchClasses.length === 1) return { label: NOTE_NAMES[pitchClasses[0]], sub: "single note" };

  let best = null;
  for (const root of pitchClasses) {
    const intervals = chordKey(pitchClasses.map((p) => (p - root + 12) % 12));
    const quality = CHORD_MAP.get(intervals);
    if (quality === undefined) continue;
    const score = (root === bass ? 100 : 0) + (60 - intervals.length);
    if (!best || score > best.score) best = { score, root, quality };
  }

  if (!best) {
    return {
      label: pitchClasses.map((p) => NOTE_NAMES[p]).join(" "),
      sub: `${pitchClasses.length}-note cluster`,
    };
  }
  const slash = best.root !== bass ? `/${NOTE_NAMES[bass]}` : "";
  return {
    label: `${NOTE_NAMES[best.root]}${best.quality}${slash}`,
    sub: `${notes.length} voice${notes.length > 1 ? "s" : ""} · root ${NOTE_NAMES[best.root]}`,
  };
}

const heldNotes = new Set();
const harmonyNameEl = $("#harmony-name");
const harmonySubEl = $("#harmony-sub");
const harmonyNotesEl = $("#harmony-notes");

function updateHarmony() {
  const notes = [...heldNotes].sort((a, b) => a - b);
  const chord = detectChord(notes);
  harmonyNameEl.textContent = chord ? chord.label : "—";
  harmonyNameEl.classList.toggle("dim", !chord);
  harmonySubEl.textContent = chord ? chord.sub : "no notes held";
  harmonyNotesEl.innerHTML = notes.map((n) => `<span>${noteLabel(n)}</span>`).join("");
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
    key.dataset.note = String(note);
    pianoEl.appendChild(key);
    keyElements.set(note, key);
  }

  for (const note of blackNotes) {
    const leftWhiteIndex = whiteNotes.filter((w) => w < note).length - 1;
    const width = whiteWidth * 0.62;
    const key = document.createElement("div");
    key.className = "key black";
    key.style.width = `${width}%`;
    key.style.left = `${(leftWhiteIndex + 1) * whiteWidth - width / 2}%`;
    key.title = noteLabel(note);
    key.dataset.note = String(note);
    pianoEl.appendChild(key);
    keyElements.set(note, key);
  }
}

// ---------------------------------------------------------------------------
// Pointer handling — each pointer (mouse, or a finger on touch) tracks the
// one key it's currently over, so dragging across the keybed slides from
// note to note (a glissando) instead of only triggering the key first touched.
// Pointer capture keeps move events coming even once the finger/cursor
// leaves the piano's bounds; elementFromPoint re-hit-tests on every move.
// ---------------------------------------------------------------------------

const pointerNotes = new Map(); // pointerId -> note currently held by that pointer

function noteAtPoint(x, y) {
  const key = document.elementFromPoint(x, y)?.closest(".key");
  return key ? Number(key.dataset.note) : null;
}

function pressNote(note) {
  if (locallyPressed.has(note)) return;
  locallyPressed.add(note);
  keyElements.get(note)?.classList.add("pressed-local");
  heldNotes.add(note);
  updateHarmony();
  playNote(note, 100);
  const data = [0x90, note, 100];
  if (connection) {
    logSentMessage(data);
    connection.send({ data }).catch(logError);
  }
}

function releaseNote(note) {
  if (!locallyPressed.has(note)) return;
  locallyPressed.delete(note);
  keyElements.get(note)?.classList.remove("pressed-local");
  heldNotes.delete(note);
  updateHarmony();
  stopNote(note);
  const data = [0x80, note, 0];
  if (connection) {
    logSentMessage(data);
    connection.send({ data }).catch(logError);
  }
}

function slideTo(pointerId, note) {
  const prev = pointerNotes.get(pointerId) ?? null;
  if (note === prev) return;
  if (prev !== null) releaseNote(prev);
  pointerNotes.set(pointerId, note);
  if (note !== null) pressNote(note);
}

function endPointer(ev) {
  if (!pointerNotes.has(ev.pointerId)) return;
  slideTo(ev.pointerId, null);
  pointerNotes.delete(ev.pointerId);
}

pianoEl.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  try {
    pianoEl.setPointerCapture(ev.pointerId);
  } catch {
    // Some environments (older Safari, synthetic test input) reject capture —
    // sliding across keys just won't track once the pointer leaves the piano.
  }
  slideTo(ev.pointerId, noteAtPoint(ev.clientX, ev.clientY));
});
pianoEl.addEventListener("pointermove", (ev) => {
  if (pointerNotes.has(ev.pointerId)) slideTo(ev.pointerId, noteAtPoint(ev.clientX, ev.clientY));
});
pianoEl.addEventListener("pointerup", endPointer);
pianoEl.addEventListener("pointercancel", endPointer);

buildPiano();

function flashKey(note, isOn, velocity) {
  const key = keyElements.get(note);
  if (isOn) {
    key?.classList.add("pressed-remote");
    key?.style.setProperty("--velocity", Math.max(0.35, velocity / 127));
    heldNotes.add(note);
    playNote(note, velocity);
  } else {
    key?.classList.remove("pressed-remote");
    key?.style.removeProperty("--velocity");
    heldNotes.delete(note);
    stopNote(note);
  }
  updateHarmony();
}

function clearAllNotes() {
  for (const note of keyElements.keys()) {
    keyElements.get(note).classList.remove("pressed-local", "pressed-remote");
    keyElements.get(note).style.removeProperty("--velocity");
  }
  for (const note of heldNotes) stopNote(note);
  pointerNotes.clear();
  locallyPressed.clear();
  heldNotes.clear();
  updateHarmony();
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
  appendLogRow(message.data, decoded, "recv", `${message.timestamp}ms`);
  if (decoded.note !== undefined) {
    flashKey(decoded.note, decoded.isNoteOn, decoded.velocity ?? 0);
  }
}

function logSentMessage(data) {
  appendLogRow(data, describeMessage(data), "sent", "sent");
}

function appendLogRow(data, decoded, direction, timeText) {
  const row = document.createElement("div");
  row.className = "log-row";
  row.dataset.dir = direction;
  const channelPart = decoded.channel ? ` · ch${decoded.channel}` : "";
  row.innerHTML = `<span class="log-time">${timeText}</span><span class="log-label">${decoded.label}</span><span class="log-detail">${decoded.detail}${channelPart}</span><span class="log-hex">${toHex(data)}</span>`;
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

encodeSendBtn.addEventListener("click", () => {
  if (!connection) return;
  try {
    const bytes = parseHexList($("#encode-input").value);
    logSentMessage(bytes);
    connection.send({ data: bytes }).catch(logError);
  } catch (err) {
    $("#encode-output").textContent = `Error: ${err.message}`;
  }
});

// Note On/Off buttons are a friendlier front end for the hex input above —
// picking a note + velocity writes the raw MIDI bytes into it and encodes,
// so you don't need to know that C4 is 0x3C to try this out.
const encodeNoteSelect = $("#encode-note");
for (let note = 21; note <= 108; note++) {
  const option = document.createElement("option");
  option.value = String(note);
  option.textContent = `${noteLabel(note)} (${note})`;
  encodeNoteSelect.appendChild(option);
}
encodeNoteSelect.value = "60";

function encodeNoteMessage(status, velocity) {
  const note = Number(encodeNoteSelect.value);
  $("#encode-input").value = toHex([status, note, velocity]).toUpperCase();
  $("#encode-btn").click();
}

$("#encode-note-on-btn").addEventListener("click", () => {
  const velocity = Math.max(0, Math.min(127, Number($("#encode-velocity").value) || 0));
  encodeNoteMessage(0x90, velocity);
});

$("#encode-note-off-btn").addEventListener("click", () => {
  encodeNoteMessage(0x80, 0);
});
