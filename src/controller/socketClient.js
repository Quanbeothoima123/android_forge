const net = require("net");
const { runAdb } = require("./adb");

const DEVICE_PORT = 27183;

// ensure per-device forward: hostPort -> device 27183
async function ensureForward(deviceId, hostPort) {
  await runAdb(
    ["-s", deviceId, "forward", `tcp:${hostPort}`, `tcp:${DEVICE_PORT}`],
    8000
  );
}

function sendJson(hostPort, payload, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      reject(new Error("socket timeout"));
    }, timeoutMs);

    socket.connect(hostPort, "127.0.0.1", () => {
      const line = JSON.stringify(payload) + "\n";
      socket.write(line, "utf8", () => {
        socket.end();
      });
    });

    socket.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });

    socket.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

module.exports = { ensureForward, sendJson };
