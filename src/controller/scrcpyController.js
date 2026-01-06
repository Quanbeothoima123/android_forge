const { spawn } = require("child_process");

const procs = new Map(); // deviceId -> ChildProcess

function buildArgs(deviceId) {
  // scrcpy GUI, đặt title để desktopCapturer bắt được
  // --no-audio giảm tải
  return ["-s", deviceId, "--no-audio", "--window-title", `forge:${deviceId}`];
}

function start(deviceId) {
  if (procs.has(deviceId)) return;

  const args = buildArgs(deviceId);

  // windows: spawn scrcpy từ PATH
  const p = spawn("scrcpy", args, {
    stdio: ["ignore", "ignore", "pipe"], // giữ stderr để debug nếu cần
    windowsHide: false,
  });

  p.on("error", (e) => {
    // lỗi kiểu ENOENT (không tìm thấy scrcpy)
    procs.delete(deviceId);
  });

  p.on("exit", () => {
    procs.delete(deviceId);
  });

  procs.set(deviceId, p);
}

function stop(deviceId) {
  const p = procs.get(deviceId);
  if (!p) return;

  try {
    p.kill("SIGTERM");
  } catch {}

  // fallback force kill
  setTimeout(() => {
    try {
      p.kill("SIGKILL");
    } catch {}
  }, 800);

  procs.delete(deviceId);
}

function isRunning(deviceId) {
  return procs.has(deviceId);
}

function stopAll() {
  for (const id of Array.from(procs.keys())) stop(id);
}

module.exports = {
  scrcpy: { start, stop, isRunning, stopAll },
};
