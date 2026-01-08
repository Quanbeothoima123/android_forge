// src/main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const { DeviceRegistry } = require("./controller/deviceRegistry");
const { scrcpy } = require("./controller/scrcpyController");
const input = require("./controller/inputControllerAdb");

if (require("electron-squirrel-startup")) {
  app.quit();
}

const registry = new DeviceRegistry();
let mainWindow = null;

// ===== slot layout manager (grid) =====
const slotByDevice = new Map(); // deviceId -> slotIndex
let nextSlot = 0;

function allocSlot(deviceId) {
  if (slotByDevice.has(deviceId)) return slotByDevice.get(deviceId);
  const s = nextSlot++;
  slotByDevice.set(deviceId, s);
  return s;
}

function freeSlot(deviceId) {
  slotByDevice.delete(deviceId);
}

// ===== window =====
function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

function ensureOnline(ctx) {
  if (!ctx) throw new Error("Device not found");
  if (ctx.state !== "ONLINE")
    throw new Error(`Device not ONLINE (${ctx.state})`);
  return ctx;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// helper: compute scrcpy window size based on device resolution
function computeScrcpyWindowSize(deviceSnapshot) {
  const res = deviceSnapshot?.resolution;
  const targetW = 360; // unify width for farm

  if (!res || !res.width || !res.height) return { width: targetW, height: 780 };

  const h = Math.round(targetW * (res.height / res.width));
  const targetH = Math.max(520, Math.min(980, h));
  return { width: targetW, height: targetH };
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function rawToPx(raw, axisMax) {
  if (!raw || !Number.isFinite(axisMax) || axisMax <= 0)
    throw new Error("Missing resolution to convert coordinates");

  const unit = String(raw.unit || "px");
  const val = Number(raw.value);

  if (!Number.isFinite(val)) throw new Error("Invalid coordinate");

  if (unit === "pct") {
    let p = val;
    if (p <= 1) p = p * 100;
    p = Math.max(0, Math.min(100, p));
    const px = Math.round((p / 100) * axisMax);
    return clampInt(px, 0, axisMax - 1);
  }

  return clampInt(val, 0, axisMax - 1);
}

// ===== FIX: stable port allocator =====
const SCRCPY_BASE_PORT = 27200;
function portForSlot(slotIndex) {
  // plenty for dozens devices; change base if you want
  return SCRCPY_BASE_PORT + (slotIndex % 200);
}

app.whenReady().then(() => {
  mainWindow = createWindow();
  registry.startPolling(1500);

  scrcpy.on("closed", ({ deviceId, code, signal }) => {
    freeSlot(deviceId);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("scrcpy:closed", { deviceId, code, signal });
  });

  // ===== devices =====
  ipcMain.handle("devices:list", async () => registry.listSnapshots());

  // ===== scrcpy lifecycle =====
  ipcMain.handle("scrcpy:start", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    const snap = ctx.snapshot();
    const { width, height } = computeScrcpyWindowSize(snap);

    const slotIndex = allocSlot(deviceId);
    const port = portForSlot(slotIndex);

    await scrcpy.start(deviceId, {
      maxFps: 30,
      bitRate: "8M",
      port, // ✅ FIX: one port per device
      window: {
        width,
        height,
        layout: { mode: "grid", slotIndex, margin: 8 },
        borderless: false,
        alwaysOnTop: false,
        timeoutMs: 15000,
      },
      zOrder: { sendToBottom: true, noActivate: true },
    });

    return { ok: true };
  });

  ipcMain.handle("scrcpy:stop", async (_, { deviceId }) => {
    await scrcpy.stop(deviceId);
    freeSlot(deviceId);
    return true;
  });

  ipcMain.handle("scrcpy:isRunning", async (_, { deviceId }) => {
    return scrcpy.isRunning(deviceId);
  });

  // ✅ FIX: startAll sequential + delay to avoid adb/scrcpy race
  ipcMain.handle("scrcpy:startAll", async () => {
    const online = registry.listSnapshots().filter((d) => d.state === "ONLINE");
    const started = [];

    for (const d of online) {
      try {
        const ctx = ensureOnline(registry.get(d.deviceId));
        const snap = ctx.snapshot();
        const { width, height } = computeScrcpyWindowSize(snap);

        const slotIndex = allocSlot(d.deviceId);
        const port = portForSlot(slotIndex);

        await scrcpy.start(d.deviceId, {
          maxFps: 30,
          bitRate: "8M",
          port,
          window: {
            width,
            height,
            layout: { mode: "grid", slotIndex, margin: 8 },
            borderless: false,
            alwaysOnTop: false,
            timeoutMs: 15000,
          },
          zOrder: { sendToBottom: true, noActivate: true },
        });

        started.push(d.deviceId);
      } catch {
        // ignore per-device start errors
      }

      // small spacing prevents intermittent "Server connection failed"
      await sleep(180);
    }

    return started;
  });

  ipcMain.handle("scrcpy:stopAll", async () => {
    await scrcpy.stopAll();
    slotByDevice.clear();
    nextSlot = 0;
    return true;
  });

  // ===== Control panel actions (ADB shell input) =====
  ipcMain.handle("control:home", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.home(deviceId));
  });

  ipcMain.handle("control:back", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.back(deviceId));
  });

  ipcMain.handle("control:recents", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.recents(deviceId));
  });

  ipcMain.handle("control:wake", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.wake(deviceId));
  });

  ipcMain.handle("control:tapRaw", async (_, { deviceId, x, y }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const px = rawToPx(x, res.width);
      const py = rawToPx(y, res.height);

      return input.tap(deviceId, px, py);
    });
  });

  ipcMain.handle("control:swipeRaw", async (_, payload) => {
    const ctx = ensureOnline(registry.get(payload.deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const x1 = rawToPx(payload.x1, res.width);
      const y1 = rawToPx(payload.y1, res.height);
      const x2 = rawToPx(payload.x2, res.width);
      const y2 = rawToPx(payload.y2, res.height);

      const dur = Number(payload.durationMs) || 220;
      return input.swipe(payload.deviceId, x1, y1, x2, y2, dur);
    });
  });

  ipcMain.handle("control:swipeDir", async (_, { deviceId, dir }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const w = res.width;
      const h = res.height;

      const xMid = Math.round(w * 0.5);
      const yMid = Math.round(h * 0.5);

      const xL = Math.round(w * 0.2);
      const xR = Math.round(w * 0.8);
      const yT = Math.round(h * 0.25);
      const yB = Math.round(h * 0.75);

      const d = String(dir || "").toLowerCase();
      if (d === "up") return input.swipe(deviceId, xMid, yB, xMid, yT, 220);
      if (d === "down") return input.swipe(deviceId, xMid, yT, xMid, yB, 220);
      if (d === "left") return input.swipe(deviceId, xR, yMid, xL, yMid, 220);
      if (d === "right") return input.swipe(deviceId, xL, yMid, xR, yMid, 220);

      throw new Error("Unknown dir");
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  registry.stopPolling();
  scrcpy.stopAll();
  if (process.platform !== "darwin") app.quit();
});
