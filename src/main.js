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

  // ===== CORE 2 (GUI scrcpy + desktopCapturer capture window) =====

  ipcMain.handle("device:streamStart", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    // đảm bảo device thật vẫn ok
    await ctx.enqueue(() => ping(deviceId));

    // start GUI scrcpy với title cố định để capture
    scrcpy.start(deviceId);
    return true;
  });

  ipcMain.handle("device:streamStop", async (_, { deviceId }) => {
    scrcpy.stop(deviceId);
    return true;
  });

  ipcMain.handle("device:streamIsRunning", async (_, { deviceId }) => {
    return scrcpy.isRunning(deviceId);
  });

  // renderer KHÔNG require electron được, nên expose API tìm sourceId từ main
  ipcMain.handle("stream:listWindowSources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      fetchWindowIcons: false,
    });

    // trả nhẹ: id + name
    return sources.map((s) => ({ id: s.id, name: s.name }));
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  registry.stopPolling();
  scrcpy.stopAll();
  if (process.platform !== "darwin") app.quit();
});
