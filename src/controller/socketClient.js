// src/controller/socketClient.js
const net = require("net");
const { runAdb } = require("./adb");

const DEVICE_PORT = 27183;

async function ensureForward(deviceId, hostPort) {
  await runAdb(
    ["-s", deviceId, "forward", `tcp:${hostPort}`, `tcp:${DEVICE_PORT}`],
    8000
  );
}

function sendJson(hostPort, payload, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    let buf = "";

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
      socket.write(line, "utf8");
    });

    socket.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("\n")) {
        const line = buf.split("\n")[0].trim();
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.end();
        } catch {}
        if (line === "OK") return resolve({ ok: true, resp: line });
        return reject(new Error(line || "ERR empty response"));
      }
    });

    socket.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });

    socket.on("close", () => {
      // nếu server không trả dòng nào
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error("socket closed without response"));
    });
  });
}

module.exports = { ensureForward, sendJson };
