const net = require("net");
const { runAdb } = require("./adb");

const AGENT_PORT = 27183;
const forwardCache = new Map();

async function ensureForward(deviceId) {
  const cached = forwardCache.get(deviceId);
  const now = Date.now();

  if (cached && now - cached.updatedAt < 60_000) return cached.localPort;

  const out = await runAdb(
    ["-s", deviceId, "forward", "tcp:0", `tcp:${AGENT_PORT}`],
    8000
  );

  const localPort = parseInt(String(out).trim(), 10);
  if (!Number.isFinite(localPort) || localPort <= 0) {
    throw new Error(`adb forward failed: output="${out}"`);
  }

  forwardCache.set(deviceId, { localPort, updatedAt: now });
  return localPort;
}

function sendJsonLine(host, port, obj, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    let buf = "";

    const finishOk = (val) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(val);
    };

    const finishErr = (err) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      reject(err);
    };

    const timer = setTimeout(() => {
      finishErr(new Error("socket timeout waiting response"));
    }, timeoutMs);

    socket.on("error", (e) => {
      clearTimeout(timer);
      finishErr(e);
    });

    socket.on("close", () => {
      if (!done) {
        clearTimeout(timer);
        finishErr(new Error("socket closed before response"));
      }
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, idx).trim();
        if (line === "OK") return finishOk("OK");
        if (line.startsWith("ERR")) return finishErr(new Error(line));
        return finishOk(line);
      }
    });

    socket.connect(port, host, () => {
      socket.write(JSON.stringify(obj) + "\n", "utf8");
    });
  });
}

async function ping(deviceId) {
  const localPort = await ensureForward(deviceId);
  await sendJsonLine("127.0.0.1", localPort, { type: "PING" }, 1200);
  return true;
}

async function tap(deviceId, x, y) {
  const localPort = await ensureForward(deviceId);
  await sendJsonLine("127.0.0.1", localPort, { type: "TAP", x, y }, 1500);
  return true;
}

async function longPress(deviceId, x, y, durationMs = 600) {
  const localPort = await ensureForward(deviceId);
  await sendJsonLine(
    "127.0.0.1",
    localPort,
    { type: "LONG_PRESS", x, y, durationMs: Number(durationMs) },
    2500
  );
  return true;
}

async function swipe(deviceId, x1, y1, x2, y2, durationMs = 220) {
  const localPort = await ensureForward(deviceId);
  await sendJsonLine(
    "127.0.0.1",
    localPort,
    { type: "SWIPE", x1, y1, x2, y2, durationMs: Number(durationMs) },
    2500
  );
  return true;
}

async function key(deviceId, keyName) {
  const localPort = await ensureForward(deviceId);
  await sendJsonLine(
    "127.0.0.1",
    localPort,
    { type: "KEY", key: String(keyName).toUpperCase() },
    1500
  );
  return true;
}

async function home(deviceId) {
  return key(deviceId, "HOME");
}

async function back(deviceId) {
  return key(deviceId, "BACK");
}

module.exports = { ping, tap, longPress, swipe, key, home, back };
