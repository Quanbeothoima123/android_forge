// src/main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");

const { DeviceRegistry } = require("./controller/deviceRegistry");
const { scrcpy } = require("./controller/scrcpyController");
const input = require("./controller/inputControllerAdb");

// ✅ Core 3
const { MacroRecorder } = require("./macro/macroRecorder");
const { listMacros, loadMacro, saveMacro } = require("./macro/macroStore");
const { runMacroOnDevice } = require("./macro/macroRunner");

// ✅ V2 Hook
const { ScrcpyHook } = require("./macro/scrcpyHook");

if (require("electron-squirrel-startup")) {
  app.quit();
}

const registry = new DeviceRegistry();
let mainWindow = null;

// ✅ Macro state
const recorder = new MacroRecorder();
const hook = new ScrcpyHook();

// running: deviceId -> { stop:boolean, token:number, startedAt:number, macroId:string }
const runningMacroByDevice = new Map();

function sendMacroState(deviceId, state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("macro:state", { deviceId, ...state });
}

function sendMacroProgress(deviceId, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("macro:progress", { deviceId, ...payload });
}

// ===== settings persistence =====
function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettingsFile() {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSettingsFile(obj) {
  try {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function normalizeScalePct(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return 50;
  const allowed = [25, 50, 75, 100];
  let best = allowed[0];
  let bestDist = Math.abs(p - best);
  for (const a of allowed) {
    const d = Math.abs(p - a);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

// ===== Device order (drag reorder) =====
let deviceOrder = []; // array of deviceId (persisted)
function setDeviceOrder(newOrder) {
  if (!Array.isArray(newOrder)) return;
  const seen = new Set();
  const cleaned = [];
  for (const id of newOrder) {
    const s = String(id || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    cleaned.push(s);
  }
  deviceOrder = cleaned;
}

function sortDevicesByOrder(devices) {
  const idx = new Map();
  deviceOrder.forEach((id, i) => idx.set(id, i));
  return [...devices].sort((a, b) => {
    const ia = idx.has(a.deviceId) ? idx.get(a.deviceId) : 1e9;
    const ib = idx.has(b.deviceId) ? idx.get(b.deviceId) : 1e9;
    if (ia !== ib) return ia - ib;
    return String(a.deviceId).localeCompare(String(b.deviceId));
  });
}

// ===== layout config (persisted) =====
const layoutConfig = {
  scalePct: 50,
  cols: 4,
  rows: 0,
  margin: 8,
  forceResizeOnApply: true,
};

function getLayoutConfig() {
  return {
    ...layoutConfig,
    deviceOrder,
  };
}

function setLayoutConfig(patch = {}) {
  if (patch.scalePct != null)
    layoutConfig.scalePct = normalizeScalePct(patch.scalePct);

  if (patch.cols != null) {
    const c = Math.round(Number(patch.cols));
    layoutConfig.cols = Number.isFinite(c)
      ? Math.max(1, Math.min(20, c))
      : layoutConfig.cols;
  }

  if (patch.rows != null) {
    const r = Math.round(Number(patch.rows));
    layoutConfig.rows = Number.isFinite(r)
      ? Math.max(0, Math.min(20, r))
      : layoutConfig.rows;
  }

  if (patch.margin != null) {
    const m = Math.round(Number(patch.margin));
    layoutConfig.margin = Number.isFinite(m)
      ? Math.max(0, Math.min(60, m))
      : layoutConfig.margin;
  }

  if (patch.forceResizeOnApply != null) {
    layoutConfig.forceResizeOnApply = !!patch.forceResizeOnApply;
  }

  if (patch.deviceOrder != null) {
    setDeviceOrder(patch.deviceOrder);
  }

  writeSettingsFile({ v: 1, ...getLayoutConfig() });
}

// ===== slot manager =====
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

const SCRCPY_BASE_PORT = 27200;
function portForSlot(slotIndex) {
  return SCRCPY_BASE_PORT + (slotIndex % 200);
}

// ===== window =====
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 900,
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

function computeScrcpyCellAndMaxSize(deviceSnapshot, scalePct) {
  const res = deviceSnapshot?.resolution;
  const scale = normalizeScalePct(scalePct) / 100;

  const baseW100 = 360;
  const targetW = clampInt(baseW100 * scale, 160, 1200);

  if (!res || !res.width || !res.height) {
    const targetH = clampInt(780 * scale, 240, 1800);
    const maxSize = clampInt(Math.max(targetW, targetH), 160, 2400);
    return { width: targetW, height: targetH, maxSize };
  }

  const h = Math.round(targetW * (res.height / res.width));
  const targetH = clampInt(h, 240, 2000);

  const deviceMaxDim = Math.max(res.width, res.height);
  const maxSize = clampInt(Math.round(deviceMaxDim * scale), 160, 6000);

  return { width: targetW, height: targetH, maxSize };
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

function rawToPct(raw, axisMax) {
  if (!raw || !Number.isFinite(axisMax) || axisMax <= 0)
    throw new Error("Missing resolution to convert coordinates");

  const unit = String(raw.unit || "px");
  const val = Number(raw.value);

  if (!Number.isFinite(val)) throw new Error("Invalid coordinate");

  if (unit === "pct") {
    let p = val;
    if (p > 1) p = p / 100;
    return Math.max(0, Math.min(1, p));
  }

  // px -> pct
  return Math.max(0, Math.min(1, val / axisMax));
}

app.whenReady().then(() => {
  const saved = readSettingsFile();
  if (saved && typeof saved === "object") {
    setDeviceOrder(saved.deviceOrder || []);
    layoutConfig.scalePct = normalizeScalePct(
      saved.scalePct ?? layoutConfig.scalePct
    );
    layoutConfig.cols = clampInt(saved.cols ?? layoutConfig.cols, 1, 20);
    layoutConfig.rows = clampInt(saved.rows ?? layoutConfig.rows, 0, 20);
    layoutConfig.margin = clampInt(saved.margin ?? layoutConfig.margin, 0, 60);
    layoutConfig.forceResizeOnApply = !!(
      saved.forceResizeOnApply ?? layoutConfig.forceResizeOnApply
    );
  }

  mainWindow = createWindow();
  registry.startPolling(1500);

  scrcpy.on("closed", ({ deviceId, code, signal }) => {
    freeSlot(deviceId);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("scrcpy:closed", { deviceId, code, signal });
  });

  // ===== devices =====
  ipcMain.handle("devices:list", async () => {
    const list = registry.listSnapshots();
    return sortDevicesByOrder(list);
  });

  // ===== layout config =====
  ipcMain.handle("layout:get", async () => getLayoutConfig());
  ipcMain.handle("layout:set", async (_, patch) => {
    setLayoutConfig(patch);
    return getLayoutConfig();
  });

  function ensureInOrder(deviceId) {
    if (!deviceOrder.includes(deviceId)) {
      deviceOrder.push(deviceId);
      writeSettingsFile({ v: 1, ...getLayoutConfig() });
    }
  }

  // ===== scrcpy lifecycle =====
  ipcMain.handle("scrcpy:start", async (_, { deviceId }) => {
    const cfg = getLayoutConfig();
    const ctx = ensureOnline(registry.get(deviceId));
    const snap = ctx.snapshot();

    ensureInOrder(deviceId);

    const slotIndex = Math.max(0, deviceOrder.indexOf(deviceId));
    allocSlot(deviceId);
    const port = portForSlot(slotIndex);

    const { width, height, maxSize } = computeScrcpyCellAndMaxSize(
      snap,
      cfg.scalePct
    );

    await scrcpy.start(deviceId, {
      maxFps: 30,
      bitRate: "8M",
      port,
      window: {
        width,
        height,
        maxSize,
        layout: {
          mode: "grid",
          slotIndex,
          cols: cfg.cols,
          rows: cfg.rows > 0 ? cfg.rows : null,
          margin: cfg.margin,
        },
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

  ipcMain.handle("scrcpy:startAll", async () => {
    const cfg = getLayoutConfig();
    const online = registry.listSnapshots().filter((d) => d.state === "ONLINE");

    for (const d of online) ensureInOrder(d.deviceId);

    const orderedOnline = sortDevicesByOrder(online);
    const started = [];

    for (const d of orderedOnline) {
      try {
        const ctx = ensureOnline(registry.get(d.deviceId));
        const snap = ctx.snapshot();

        const slotIndex = Math.max(0, deviceOrder.indexOf(d.deviceId));
        allocSlot(d.deviceId);
        const port = portForSlot(slotIndex);

        const { width, height, maxSize } = computeScrcpyCellAndMaxSize(
          snap,
          cfg.scalePct
        );

        await scrcpy.start(d.deviceId, {
          maxFps: 30,
          bitRate: "8M",
          port,
          window: {
            width,
            height,
            maxSize,
            layout: {
              mode: "grid",
              slotIndex,
              cols: cfg.cols,
              rows: cfg.rows > 0 ? cfg.rows : null,
              margin: cfg.margin,
            },
            borderless: false,
            alwaysOnTop: false,
            timeoutMs: 15000,
          },
          zOrder: { sendToBottom: true, noActivate: true },
        });

        started.push(d.deviceId);
      } catch {}

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

  ipcMain.handle("scrcpy:applyLayout", async (_, payload = {}) => {
    const cfg = getLayoutConfig();
    const forceResize =
      payload.forceResize != null
        ? !!payload.forceResize
        : !!cfg.forceResizeOnApply;

    const all = registry.listSnapshots();
    const runningOnline = all.filter(
      (d) => d.state === "ONLINE" && scrcpy.isRunning(d.deviceId)
    );

    const ordered = sortDevicesByOrder(runningOnline);

    const items = ordered.map((d) => {
      const s = scrcpy.procs.get(d.deviceId);
      return {
        deviceId: d.deviceId,
        title: s?.title || `forge:${d.deviceId}`,
        slotIndex: Math.max(0, deviceOrder.indexOf(d.deviceId)),
      };
    });

    let cell = { width: 360, height: 780, maxSize: 540 };
    if (ordered.length) {
      const ctx = registry.get(ordered[0].deviceId);
      if (ctx) cell = computeScrcpyCellAndMaxSize(ctx.snapshot(), cfg.scalePct);
    }

    await scrcpy.applyLayout(
      items,
      {
        mode: "grid",
        cols: cfg.cols,
        rows: cfg.rows > 0 ? cfg.rows : null,
        margin: cfg.margin,
      },
      { width: cell.width, height: cell.height },
      {
        forceSize: forceResize,
        sendToBottom: true,
        noActivate: true,
        timeoutMs: 15000,
      }
    );

    return { ok: true, count: items.length, forceResize };
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

      // ✅ If recording, store pct
      if (recorder.isRecording()) {
        const xp = rawToPct(x, res.width);
        const yp = rawToPct(y, res.height);
        recorder.recordTapPct(xp, yp);
      }

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

      // ✅ If recording, store pct
      if (recorder.isRecording()) {
        const x1p = rawToPct(payload.x1, res.width);
        const y1p = rawToPct(payload.y1, res.height);
        const x2p = rawToPct(payload.x2, res.width);
        const y2p = rawToPct(payload.y2, res.height);
        recorder.recordSwipePct(x1p, y1p, x2p, y2p, dur);
      }

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

  // ===== Core 3: Macro IPC =====
  ipcMain.handle("macro:list", async () => {
    return listMacros(app.getPath("userData"));
  });

  // ✅ Record start (V2: hook global mouse on scrcpy window)
  ipcMain.handle("macro:recordStart", async (_, { deviceId }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    const snap = ctx.snapshot();
    const res = snap.resolution;
    if (!res?.width || !res?.height)
      throw new Error("Device resolution not ready yet");

    const running = scrcpy.isRunning(deviceId);
    if (!running) {
      throw new Error(
        "scrcpy is not running for this device. Start scrcpy first."
      );
    }

    // start macro recorder
    recorder.start({ deviceId, deviceRes: res });

    // start hook: mouse => recorder steps (TAP/SWIPE/LONG_PRESS)
    hook.start({
      deviceId,
      deviceRes: res,
      onStep: (s) => {
        // recorder expects "pct steps"
        if (s.type === "TAP") recorder.recordTapPct(s.xPct, s.yPct);
        if (s.type === "LONG_PRESS")
          recorder.recordLongPressPct(s.xPct, s.yPct, s.durationMs);
        if (s.type === "SWIPE")
          recorder.recordSwipePct(
            s.x1Pct,
            s.y1Pct,
            s.x2Pct,
            s.y2Pct,
            s.durationMs
          );
      },
    });

    return { ok: true };
  });

  ipcMain.handle("macro:recordStop", async () => {
    try {
      hook.stop();
    } catch {}

    const { steps } = recorder.stop();
    return { ok: true, steps };
  });

  ipcMain.handle("macro:recordAddText", async (_, { text }) => {
    recorder.injectText(text);
    return { ok: true };
  });

  ipcMain.handle("macro:recordAddKey", async (_, { key }) => {
    recorder.injectKey(key);
    return { ok: true };
  });

  ipcMain.handle("macro:recordAddWait", async (_, { durationMs }) => {
    recorder.injectWait(durationMs);
    return { ok: true };
  });

  ipcMain.handle("macro:save", async (_, { name, description, steps }) => {
    const id =
      String(name || "")
        .trim()
        .replace(/\s+/g, "_")
        .toLowerCase() || randomUUID();

    const macro = {
      meta: {
        id,
        name: name || id,
        description: description || "",
        version: 2,
        createdAt: Date.now(),
      },
      settings: {
        randomize: { xyJitterPct: 0.003, delayJitterPct: 0.12 },
        playbackSpeed: 1.0,
      },
      steps: Array.isArray(steps) ? steps : [],
    };

    return saveMacro(app.getPath("userData"), macro);
  });

  ipcMain.handle("macro:load", async (_, { id }) => {
    return loadMacro(app.getPath("userData"), id);
  });

  // ✅ Play: anti-spam + progress + hard stop
  ipcMain.handle("macro:play", async (_, { deviceId, macroId, options }) => {
    const ctx = ensureOnline(registry.get(deviceId));
    const macro = loadMacro(app.getPath("userData"), macroId);

    // ✅ reject if already running
    if (runningMacroByDevice.has(deviceId)) {
      throw new Error("Macro already running on this device. Stop it first.");
    }

    const state = {
      stop: false,
      token: Date.now(), // run token
      startedAt: Date.now(),
      macroId,
    };
    runningMacroByDevice.set(deviceId, state);

    sendMacroState(deviceId, { running: true, macroId });

    return ctx.enqueue(async () => {
      try {
        const loop = Number(options?.loop ?? 1);
        const loops = Number.isFinite(loop) ? Math.max(1, Math.floor(loop)) : 1;

        for (let li = 0; li < loops; li++) {
          if (state.stop) break;

          await runMacroOnDevice(ctx, macro, options || {}, {
            shouldStop: () => state.stop,
            token: state.token,
            onProgress: (p) => sendMacroProgress(deviceId, p),
          });
        }

        return { ok: true };
      } finally {
        runningMacroByDevice.delete(deviceId);
        sendMacroState(deviceId, { running: false, macroId: "" });
      }
    });
  });

  ipcMain.handle("macro:stop", async (_, { deviceId }) => {
    const s = runningMacroByDevice.get(deviceId);
    if (s) {
      s.stop = true;
      // đổi token để mọi retry/loop exit
      s.token = Date.now();
    }
    return { ok: true };
  });

  app.on("before-quit", () => {
    writeSettingsFile({ v: 1, ...getLayoutConfig() });
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
