// Dev bridge: owns the laser's serial port and relays raw wire bytes over a local WebSocket, so the app can reach
// the controller from browsers without Web Serial (e.g. the Claude desktop preview pane) and from scripts.
//
// Usage: npm run bridge [-- --port /dev/cu.usbserial-XXXX] [--listen 8765] [--verbose]
//
// Protocol: binary frames = raw (swizzled) bytes in both directions. The bridge sends one text frame
// {"ready": "<port path>"} once the serial port is open, or {"error": "..."}.
// Safety: listens on 127.0.0.1 only and accepts browser connections only from localhost origins. Several clients may
// share the port; it is open only while at least one is connected (so LightBurn or Chrome can use it otherwise).
import { SerialPort } from "serialport";
import { type WebSocket, WebSocketServer } from "ws";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const listenPort = Number(opt("--listen") ?? 8765);
const verbose = args.includes("--verbose");
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

async function findPort(): Promise<string> {
  const explicit = opt("--port");
  if (explicit) return explicit;
  const ports = (await SerialPort.list()).filter((p) => p.vendorId?.toLowerCase() === "0403" && p.productId?.toLowerCase() === "6001");
  if (ports.length === 0) throw new Error("No FTDI FT245R (0403:6001) found. Is the laser connected and powered?");
  // macOS: prefer the call-out device (cu.*), and the FTDI-driver port named after the serial number.
  const paths = ports.map((p) => p.path.replace("/dev/tty.", "/dev/cu."));
  const bySerial = ports.find((p) => p.serialNumber && p.path.endsWith(p.serialNumber));
  return bySerial ? bySerial.path.replace("/dev/tty.", "/dev/cu.") : paths[0]!;
}

const isLocalOrigin = (origin: string | undefined) =>
  !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: listenPort,
  verifyClient: (info: { origin?: string }) => isLocalOrigin(info.origin),
});
// Several clients may share the port (e.g. the browser UI and a terminal CLI). Every serial byte is sent to all
// of them; each client matches replies to its own queries by address, so avoid querying from two at once.
const clients = new Set<WebSocket>();
let serial: SerialPort | null = null;
let serialPath = "";
let opening: Promise<void> | null = null;

function broadcastError(msg: string) {
  console.error(`[bridge] ${msg}`);
  for (const c of clients) {
    if (c.readyState === c.OPEN) {
      c.send(JSON.stringify({ error: msg }));
      c.close(1011, msg.slice(0, 120));
    }
  }
}

async function ensureSerial(): Promise<void> {
  if (serial?.isOpen) return;
  opening ??= (async () => {
    serialPath = await findPort();
    const s = new SerialPort({ path: serialPath, baudRate: 115200, autoOpen: false });
    await new Promise<void>((res, rej) => s.open((e) => (e ? rej(e) : res())));
    s.on("data", (b: Buffer) => {
      if (verbose) console.log(`  RX ${b.length}B ${hex(b)}`);
      for (const c of clients) if (c.readyState === c.OPEN) c.send(b, { binary: true });
    });
    s.on("error", (e) => broadcastError(`Serial error: ${e.message}`));
    s.on("close", () => {
      serial = null;
      if (clients.size) broadcastError("Serial port closed (unplugged?)");
    });
    serial = s;
    console.log(`[bridge] opened ${serialPath}`);
  })().finally(() => (opening = null));
  await opening;
}

function closeSerialIfIdle() {
  if (clients.size === 0 && serial?.isOpen) {
    const s = serial;
    serial = null;
    s.removeAllListeners("close");
    s.close();
    console.log("[bridge] no clients; serial port closed");
  }
}

wss.on("connection", async (ws, req) => {
  const who = `${req.headers.origin ?? "cli"} (${req.socket.remotePort})`;
  clients.add(ws);
  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[bridge] ${who} disconnected (${clients.size} left)`);
    closeSerialIfIdle();
  });
  try {
    await ensureSerial();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[bridge] ${msg}`);
    ws.send(JSON.stringify({ error: msg }));
    ws.close(1011, msg.slice(0, 120));
    return;
  }
  console.log(`[bridge] ${who} connected (${clients.size} client${clients.size === 1 ? "" : "s"})`);
  ws.on("message", (data, isBinary) => {
    if (!isBinary || !serial?.isOpen) return;
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (verbose) console.log(`  TX ${b.length}B ${hex(b)}  [${who}]`);
    serial.write(b);
  });
  ws.send(JSON.stringify({ ready: serialPath }));
});

wss.on("listening", () => console.log(`[bridge] listening on ws://127.0.0.1:${listenPort} (Ctrl-C to stop)`));
wss.on("error", (e) => {
  console.error(`[bridge] ${e.message}`);
  process.exit(1);
});
