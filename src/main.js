const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const path = require("path");

const { DeviceRegistry } = require("./controller/deviceRegistry");
const { scrcpy } = require("./controller/scrcpyController");
const {
  ping,
  tap,
  home,
  back,
  swipe,
  longPress,
} = require("./controller/inputController");

if (require("electron-squirrel-startup")) {
  app.quit();
}

const registry = new DeviceRegistry();
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
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

// helper: compute scrcpy window size based on device resolution
function computeScrcpyWindowSize(deviceSnapshot) {
  const res = deviceSnapshot?.resolution;
  // fallback
  if (!res || !res.width || !res.height) return { width: 420, height: 900 };

  // capture width bạn muốn (tăng lên để nét hơn, và tránh “hơi thấp”)
  const targetW = 420;

  // height theo aspect, cộng thêm một chút dư địa
  const h = Math.round(targetW * (res.height / res.width));

  // clamp để không quá cao
  const targetH = Math.max(480, Math.min(1100, h));

  return { width: targetW, height: targetH };
}

app.whenReady().then(() => {
  mainWindow = createWindow();
  registry.startPolling(1500);

  // forward scrcpy close events -> renderer
  scrcpy.on("closed", ({ deviceId, code, signal }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("stream:ended", { deviceId, code, signal });
  });

  ipcMain.handle("devices:list", async () => registry.listSnapshots());

  ipcMain.handle("device:agentPing", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => ping(deviceId));
  });

  ipcMain.handle("device:tap", async (_, { deviceId, x, y }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => tap(deviceId, x, y));
  });

  ipcMain.handle("device:home", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => home(deviceId));
  });

  ipcMain.handle("device:back", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => back(deviceId));
  });

  ipcMain.handle("device:swipe", async (_, payload) => {
    const ctx = ensureOnline(registry.get(payload.deviceId));
    return ctx.enqueue(() =>
      swipe(
        payload.deviceId,
        payload.x1,
        payload.y1,
        payload.x2,
        payload.y2,
        payload.durationMs
      )
    );
  });

  ipcMain.handle("device:longPress", async (_, payload) => {
    const ctx = ensureOnline(registry.get(payload.deviceId));
    return ctx.enqueue(() =>
      longPress(payload.deviceId, payload.x, payload.y, payload.durationMs)
    );
  });

  // ===== STREAM: start/stop scrcpy GUI =====
  ipcMain.handle("stream:start", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    await ctx.enqueue(() => ping(deviceId));

    const snap = registry.get(deviceId)?.snapshot?.()
      ? registry.get(deviceId).snapshot()
      : null;

    const { width, height } = computeScrcpyWindowSize(snap);

    // Start scrcpy (corner + borderless). KHÔNG offscreen, KHÔNG minimize.
    scrcpy.start(deviceId, {
      maxFps: 30,
      bitRate: "8M",
      portRange: "27200:27299",

      window: {
        width,
        height,
        corner: "bottom-right",
        margin: 12,
        borderless: true,
        alwaysOnTop: false,
        timeoutMs: 9000,
      },

      // Trick: push scrcpy xuống dưới (Electron sẽ che lên)
      zOrder: {
        sendToBottom: true,
        noActivate: true,
      },
    });

    return { ok: true };
  });

  ipcMain.handle("stream:stop", async (_, { deviceId }) => {
    scrcpy.stop(deviceId);
    return true;
  });

  ipcMain.handle("stream:isRunning", async (_, { deviceId }) => {
    return scrcpy.isRunning(deviceId);
  });

  // renderer cannot require electron -> expose list window sources
  ipcMain.handle("stream:listWindowSources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({ id: s.id, name: s.name }));
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  registry.stopPolling();
  scrcpy.stopAll();
  if (process.platform !== "darwin") app.quit();
});
