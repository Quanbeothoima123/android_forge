const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const { DeviceRegistry } = require("./controller/deviceRegistry");
const { StreamManager } = require("./controller/streamManager");
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
const streams = new StreamManager();

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
}

function ensureOnline(ctx) {
  if (!ctx) throw new Error("Device not found");
  if (ctx.state !== "ONLINE")
    throw new Error(`Device not ONLINE (${ctx.state})`);
  return ctx;
}

app.whenReady().then(() => {
  registry.startPolling(1500);

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

  // ========== CORE 2: STREAM ==========
  ipcMain.handle("stream:start", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    // stream không “enqueue” vì scrcpy không dùng adb sau khi chạy.
    // nhưng vẫn cần ping agent để chắc device đang ok.
    await ctx.enqueue(() => ping(deviceId));
    const url = await streams.start(deviceId, { maxFps: 30, bitRate: "8M" });
    return { url };
  });

  ipcMain.handle("stream:stop", async (_, { deviceId }) => {
    streams.stop(deviceId);
    return true;
  });

  ipcMain.handle("stream:url", async (_, { deviceId }) => {
    if (!streams.isRunning(deviceId)) throw new Error("Stream not running");
    return { url: streams.getWsUrl(deviceId) };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  registry.stopPolling();
  streams.stopAll();
  if (process.platform !== "darwin") app.quit();
});
