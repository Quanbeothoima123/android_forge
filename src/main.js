// src/main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");

const { DeviceRegistry } = require("./controller/deviceRegistry");
const { scrcpy } = require("./controller/scrcpyController");
const input = require("./controller/inputControllerAdb");

// Core 3
const { MacroRecorder } = require("./macro/macroRecorder");
const { listMacros, loadMacro, saveMacro } = require("./macro/macroStore");
const { runMacroOnDevice } = require("./macro/macroRunner");

// V2 Hook
const { ScrcpyHook } = require("./macro/scrcpyHook");

// Core 4
const { GroupManager } = require("./controller/groupManager");
const { GroupBroadcast } = require("./controller/groupBroadcast");

// ✅ Core 5: Logger
const { Logger } = require("./controller/logger");

if (require("electron-squirrel-startup")) {
  app.quit();
}

const registry = new DeviceRegistry();
let mainWindow = null;

// Macro state
const recorder = new MacroRecorder();
const hook = new ScrcpyHook();

// running: deviceId -> { stop:boolean, token:number, ... }
const runningMacroByDevice = new Map();

function safeSend(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch {}
}

// ========= settings persistence =========
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

// ========= Device order =========
let deviceOrder = [];
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

// ========= layout config =========
const layoutConfig = {
  scalePct: 50,
  cols: 4,
  rows: 0,
  margin: 8,
  forceResizeOnApply: true,

  // ✅ Core 5: move AutoStart to MAIN (reliable long-run)
  autoStartEnabled: false,

  // ✅ Core 5: wake screen after auto recover (default true)
  autoWakeOnRecover: true,
};

// persist: broadcast defaults + group macro defaults + device aliases
let broadcastDefaults = {
  baseDelayMs: 90,
  jitterMs: 160,
  xyJitterPct: 0.004,
};

let groupMacroDefaults = {
  baseDelayMs: 120,
  jitterMs: 280,
};

// deviceId -> alias
let deviceAliases = {}; // { [deviceId]: "My Name" }

// ========= Groups (persisted) =========
let groupManager = new GroupManager([]);

function getGroupsForSave() {
  return groupManager.toJSON();
}

function getLayoutConfig() {
  return {
    ...layoutConfig,
    deviceOrder,
    groups: getGroupsForSave(),
    broadcastDefaults,
    groupMacroDefaults,
    deviceAliases,
  };
}

function persistSettings() {
  writeSettingsFile({ v: 4, ...getLayoutConfig() });
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

  if (patch.autoStartEnabled != null) {
    layoutConfig.autoStartEnabled = !!patch.autoStartEnabled;
  }

  if (patch.autoWakeOnRecover != null) {
    layoutConfig.autoWakeOnRecover = !!patch.autoWakeOnRecover;
  }

  if (patch.deviceOrder != null) {
    setDeviceOrder(patch.deviceOrder);
  }

  if (patch.groups != null && Array.isArray(patch.groups)) {
    groupManager = new GroupManager(patch.groups);
  }

  if (patch.broadcastDefaults && typeof patch.broadcastDefaults === "object") {
    const bd = patch.broadcastDefaults;
    if (bd.baseDelayMs != null)
      broadcastDefaults.baseDelayMs = Math.max(0, Number(bd.baseDelayMs) || 0);
    if (bd.jitterMs != null)
      broadcastDefaults.jitterMs = Math.max(0, Number(bd.jitterMs) || 0);
    if (bd.xyJitterPct != null)
      broadcastDefaults.xyJitterPct = Math.max(0, Number(bd.xyJitterPct) || 0);
  }

  if (
    patch.groupMacroDefaults &&
    typeof patch.groupMacroDefaults === "object"
  ) {
    const gd = patch.groupMacroDefaults;
    if (gd.baseDelayMs != null)
      groupMacroDefaults.baseDelayMs = Math.max(0, Number(gd.baseDelayMs) || 0);
    if (gd.jitterMs != null)
      groupMacroDefaults.jitterMs = Math.max(0, Number(gd.jitterMs) || 0);
  }

  if (patch.deviceAliases && typeof patch.deviceAliases === "object") {
    deviceAliases = { ...deviceAliases, ...patch.deviceAliases };
    for (const k of Object.keys(deviceAliases)) {
      const v = String(deviceAliases[k] ?? "").trim();
      if (!v) delete deviceAliases[k];
      else deviceAliases[k] = v;
    }
  }

  persistSettings();
}

function setDeviceAlias(deviceId, alias) {
  const did = String(deviceId || "").trim();
  if (!did) throw new Error("deviceId required");
  const a = String(alias ?? "").trim();

  if (!a) {
    delete deviceAliases[did];
  } else {
    deviceAliases[did] = a;
  }
  persistSettings();
  return { ok: true, deviceId: did, alias: deviceAliases[did] || "" };
}

// ========= slot manager =========
const slotByDevice = new Map();
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

// ========= window =========
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

  return Math.max(0, Math.min(1, val / axisMax));
}

// ========= Core 4: Broadcast Engine instance =========
function loadMacroByIdFromStore(id) {
  return loadMacro(app.getPath("userData"), id);
}

let groupBroadcast = null;
function initGroupBroadcast() {
  groupBroadcast = new GroupBroadcast({
    registry,
    getGroup: (groupId) => groupManager.get(groupId),
    loadMacroById: loadMacroByIdFromStore,
    runningMacroByDevice,
    sendMacroState,
    sendMacroProgress,
  });
}

function sendMacroState(deviceId, state) {
  safeSend("macro:state", { deviceId, ...state });
}

function sendMacroProgress(deviceId, payload) {
  safeSend("macro:progress", { deviceId, ...payload });
}

// ========= Core 5: logger + auto recover =========
let logger = null;

// prevent spam restart
const autoRecoverPending = new Set();

function ensureInOrder(deviceId) {
  if (!deviceOrder.includes(deviceId)) {
    deviceOrder.push(deviceId);
    persistSettings();
  }
}

async function autoRecoverScrcpy(deviceId, reason) {
  if (!layoutConfig.autoStartEnabled) return;
  if (autoRecoverPending.has(deviceId)) return;

  const ctx = registry.get(deviceId);
  if (!ctx || ctx.state !== "ONLINE") return;

  autoRecoverPending.add(deviceId);

  try {
    ensureInOrder(deviceId);

    // wait a bit after reconnect so adb is stable
    await sleep(450);

    const snap = ctx.snapshot();
    const slotIndex = Math.max(0, deviceOrder.indexOf(deviceId));
    allocSlot(deviceId);
    const port = portForSlot(slotIndex);

    const { width, height, maxSize } = computeScrcpyCellAndMaxSize(
      snap,
      layoutConfig.scalePct
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
          cols: layoutConfig.cols,
          rows: layoutConfig.rows > 0 ? layoutConfig.rows : null,
          margin: layoutConfig.margin,
        },
        borderless: false,
        alwaysOnTop: false,
        timeoutMs: 15000,
      },
      zOrder: { sendToBottom: true, noActivate: true },
    });

    logger?.health("autoRecover scrcpy:started", { deviceId, reason });

    // ✅ wake screen so you SEE "bật lại màn hình"
    if (layoutConfig.autoWakeOnRecover) {
      try {
        await input.wake(deviceId);
        logger?.health("autoRecover wake:ok", { deviceId });
      } catch (e) {
        logger?.error("autoRecover wake:fail", {
          deviceId,
          message: String(e?.message || e || ""),
        });
      }
    }
  } catch (e) {
    logger?.error("autoRecover scrcpy:fail", {
      deviceId,
      reason,
      message: String(e?.message || e || ""),
    });
  } finally {
    setTimeout(() => autoRecoverPending.delete(deviceId), 1500);
  }
}

function attachRegistryLoggingAndRecover() {
  registry.on("device:state", (evt) => {
    const { deviceId, prev, next, changed, snapshot } = evt || {};
    if (!deviceId) return;

    if (changed) {
      logger?.info("device:state", {
        deviceId,
        prev,
        next,
        onlineSince: snapshot?.onlineSince || null,
        totalOnlineMs: snapshot?.totalOnlineMs || 0,
        adbErrorCount: snapshot?.adbErrorCount || 0,
      });

      // OFFLINE -> ONLINE : auto recover
      if (prev !== "ONLINE" && next === "ONLINE") {
        autoRecoverScrcpy(deviceId, "reconnect");
      }

      // ONLINE -> OFFLINE : cleanup
      if (prev === "ONLINE" && next !== "ONLINE") {
        try {
          if (scrcpy.isRunning(deviceId)) {
            scrcpy.stop(deviceId).catch(() => {});
            freeSlot(deviceId);
          }
        } catch {}
      }
    }
  });

  registry.on("device:adbError", (evt) => {
    logger?.error("device:adbError", evt);
  });

  registry.on("registry:adbDown", (evt) => {
    logger?.error("registry:adbDown", evt);
  });
}

function attachProcessGuards() {
  process.on("uncaughtException", (e) => {
    logger?.error("process:uncaughtException", {
      message: String(e?.stack || e),
    });
  });
  process.on("unhandledRejection", (e) => {
    logger?.error("process:unhandledRejection", {
      message: String(e?.stack || e),
    });
  });
}

app.whenReady().then(() => {
  // init window first for log streaming
  mainWindow = createWindow();

  logger = new Logger({
    userDataPath: app.getPath("userData"),
    onLine: (line) => safeSend("log:line", line),
  });

  attachProcessGuards();

  // load settings
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

    // ✅ Core 5 load
    layoutConfig.autoStartEnabled = !!(
      saved.autoStartEnabled ?? layoutConfig.autoStartEnabled
    );
    layoutConfig.autoWakeOnRecover = !!(
      saved.autoWakeOnRecover ?? layoutConfig.autoWakeOnRecover
    );

    if (Array.isArray(saved.groups)) {
      groupManager = new GroupManager(saved.groups);
    }

    if (
      saved.broadcastDefaults &&
      typeof saved.broadcastDefaults === "object"
    ) {
      broadcastDefaults = { ...broadcastDefaults, ...saved.broadcastDefaults };
    }
    if (
      saved.groupMacroDefaults &&
      typeof saved.groupMacroDefaults === "object"
    ) {
      groupMacroDefaults = {
        ...groupMacroDefaults,
        ...saved.groupMacroDefaults,
      };
    }
    if (saved.deviceAliases && typeof saved.deviceAliases === "object") {
      deviceAliases = { ...saved.deviceAliases };
      for (const k of Object.keys(deviceAliases)) {
        const v = String(deviceAliases[k] ?? "").trim();
        if (!v) delete deviceAliases[k];
        else deviceAliases[k] = v;
      }
    }
  }

  initGroupBroadcast();

  attachRegistryLoggingAndRecover();

  // start polling after listeners attached
  registry.startPolling(1500);

  // scrcpy close handling
  scrcpy.on("closed", ({ deviceId, code, signal }) => {
    freeSlot(deviceId);
    safeSend("scrcpy:closed", { deviceId, code, signal });

    logger?.audit("scrcpy:closed", { deviceId, code, signal });

    // ✅ Core 5: auto recover if closed unexpectedly & device still ONLINE
    if (layoutConfig.autoStartEnabled) {
      autoRecoverScrcpy(deviceId, "scrcpy_closed");
    }
  });

  // ========= IPC: logs =========
  ipcMain.handle("log:tail", async (_, { maxLines }) => {
    return logger?.tailLines(Number(maxLines) || 250) || [];
  });

  // ========= devices =========
  ipcMain.handle("devices:list", async () => {
    const list = registry.listSnapshots();
    const sorted = sortDevicesByOrder(list);
    return sorted.map((d) => ({
      ...d,
      alias: deviceAliases[d.deviceId] || "",
    }));
  });

  // alias get/set
  ipcMain.handle("device:aliasSet", async (_, { deviceId, alias }) => {
    const r = setDeviceAlias(deviceId, alias);
    logger?.audit("device:aliasSet", { deviceId, alias: r.alias || "" });
    return r;
  });

  ipcMain.handle("device:aliasGetAll", async () => {
    return { ...deviceAliases };
  });

  // layout
  ipcMain.handle("layout:get", async () => getLayoutConfig());
  ipcMain.handle("layout:set", async (_, patch) => {
    setLayoutConfig(patch);
    logger?.audit("layout:set", {
      autoStartEnabled: layoutConfig.autoStartEnabled,
      autoWakeOnRecover: layoutConfig.autoWakeOnRecover,
      scalePct: layoutConfig.scalePct,
      cols: layoutConfig.cols,
      rows: layoutConfig.rows,
      margin: layoutConfig.margin,
    });
    return getLayoutConfig();
  });

  // ========= scrcpy lifecycle =========
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

    logger?.audit("scrcpy:start", { deviceId });
    return { ok: true };
  });

  ipcMain.handle("scrcpy:stop", async (_, { deviceId }) => {
    await scrcpy.stop(deviceId);
    freeSlot(deviceId);
    logger?.audit("scrcpy:stop", { deviceId });
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
        logger?.audit("scrcpy:startAll:item", { deviceId: d.deviceId });
      } catch (e) {
        logger?.error("scrcpy:startAll:itemFail", {
          deviceId: d.deviceId,
          message: String(e?.message || e || ""),
        });
      }

      await sleep(180);
    }

    logger?.audit("scrcpy:startAll", { count: started.length });
    return started;
  });

  ipcMain.handle("scrcpy:stopAll", async () => {
    await scrcpy.stopAll();
    slotByDevice.clear();
    nextSlot = 0;
    logger?.audit("scrcpy:stopAll", {});
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

    logger?.audit("scrcpy:applyLayout", { count: items.length, forceResize });
    return { ok: true, count: items.length, forceResize };
  });

  // ========= Control panel actions =========
  ipcMain.handle("control:home", async (_, { deviceId }) => {
    logger?.audit("control:home", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.home(deviceId));
  });

  ipcMain.handle("control:back", async (_, { deviceId }) => {
    logger?.audit("control:back", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.back(deviceId));
  });

  ipcMain.handle("control:recents", async (_, { deviceId }) => {
    logger?.audit("control:recents", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.recents(deviceId));
  });

  ipcMain.handle("control:wake", async (_, { deviceId }) => {
    logger?.audit("control:wake", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.wake(deviceId));
  });

  ipcMain.handle("control:screenOff", async (_, { deviceId }) => {
    logger?.audit("control:screenOff", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.screenOff(deviceId));
  });

  ipcMain.handle("control:shutdown", async (_, { deviceId }) => {
    logger?.audit("control:shutdown", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.shutdown(deviceId));
  });

  ipcMain.handle("control:tapRaw", async (_, { deviceId, x, y }) => {
    logger?.audit("control:tapRaw", { deviceId, x, y });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const px = rawToPx(x, res.width);
      const py = rawToPx(y, res.height);

      if (recorder.isRecording()) {
        const xp = rawToPct(x, res.width);
        const yp = rawToPct(y, res.height);
        recorder.recordTapPct(xp, yp);
      }

      return input.tap(deviceId, px, py);
    });
  });

  ipcMain.handle("control:swipeRaw", async (_, payload) => {
    logger?.audit("control:swipeRaw", payload);
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
    logger?.audit("control:swipeDir", { deviceId, dir });
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

  // ========= Macro IPC =========
  ipcMain.handle("macro:list", async () => listMacros(app.getPath("userData")));

  ipcMain.handle("macro:recordStart", async (_, { deviceId }) => {
    logger?.audit("macro:recordStart", { deviceId });

    const ctx = ensureOnline(registry.get(deviceId));
    const snap = ctx.snapshot();
    const res = snap.resolution;
    if (!res?.width || !res?.height)
      throw new Error("Device resolution not ready yet");

    const running = scrcpy.isRunning(deviceId);
    if (!running)
      throw new Error(
        "scrcpy is not running for this device. Start scrcpy first."
      );

    recorder.start({ deviceId, deviceRes: res });

    hook.start({
      deviceId,
      deviceRes: res,
      onStep: (s) => {
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
    logger?.audit("macro:recordStop", {});
    try {
      hook.stop();
    } catch {}
    const { steps } = recorder.stop();
    return { ok: true, steps };
  });

  ipcMain.handle("macro:recordAddText", async (_, { text }) => {
    logger?.audit("macro:recordAddText", { text });
    recorder.injectText(text);
    return { ok: true };
  });

  ipcMain.handle("macro:recordAddKey", async (_, { key }) => {
    logger?.audit("macro:recordAddKey", { key });
    recorder.injectKey(key);
    return { ok: true };
  });

  ipcMain.handle("macro:recordAddWait", async (_, { durationMs }) => {
    logger?.audit("macro:recordAddWait", { durationMs });
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

    logger?.audit("macro:save", {
      id,
      name: macro.meta.name,
      steps: macro.steps.length,
    });
    return saveMacro(app.getPath("userData"), macro);
  });

  ipcMain.handle("macro:load", async (_, { id }) => {
    logger?.audit("macro:load", { id });
    return loadMacro(app.getPath("userData"), id);
  });

  ipcMain.handle("macro:play", async (_, { deviceId, macroId, options }) => {
    logger?.audit("macro:play", { deviceId, macroId, options });

    const ctx = ensureOnline(registry.get(deviceId));
    const macro = loadMacro(app.getPath("userData"), macroId);

    if (runningMacroByDevice.has(deviceId)) {
      throw new Error("Macro already running on this device. Stop it first.");
    }

    const state = {
      stop: false,
      token: Date.now(),
      startedAt: Date.now(),
      macroId,
      source: "single",
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
    logger?.audit("macro:stop", { deviceId });
    const s = runningMacroByDevice.get(deviceId);
    if (s) {
      s.stop = true;
      s.token = Date.now();
    }
    return { ok: true };
  });

  // ========= Groups IPC =========
  ipcMain.handle("group:list", async () => groupManager.list());

  ipcMain.handle("group:create", async (_, { id, name }) => {
    const g = groupManager.create(id, name);
    persistSettings();
    logger?.audit("group:create", { id: g.id, name: g.name });
    return {
      ok: true,
      group: { id: g.id, name: g.name, devices: Array.from(g.devices) },
    };
  });

  ipcMain.handle("group:rename", async (_, { id, name }) => {
    const g = groupManager.rename(id, name);
    persistSettings();
    logger?.audit("group:rename", { id: g.id, name: g.name });
    return {
      ok: true,
      group: { id: g.id, name: g.name, devices: Array.from(g.devices) },
    };
  });

  ipcMain.handle("group:remove", async (_, { id }) => {
    groupManager.remove(id);
    persistSettings();
    logger?.audit("group:remove", { id });
    return { ok: true };
  });

  ipcMain.handle("group:addDevice", async (_, { groupId, deviceId }) => {
    groupManager.addDevice(groupId, deviceId);
    persistSettings();
    logger?.audit("group:addDevice", { groupId, deviceId });
    return { ok: true };
  });

  ipcMain.handle("group:removeDevice", async (_, { groupId, deviceId }) => {
    groupManager.removeDevice(groupId, deviceId);
    persistSettings();
    logger?.audit("group:removeDevice", { groupId, deviceId });
    return { ok: true };
  });

  // ---- Group Broadcast ----
  ipcMain.handle("group:tapPct", async (_, { groupId, xPct, yPct, opts }) => {
    logger?.audit("group:tapPct", { groupId, xPct, yPct, opts });
    return groupBroadcast.tapPct(
      groupId,
      Number(xPct),
      Number(yPct),
      opts || {}
    );
  });

  ipcMain.handle(
    "group:swipePct",
    async (_, { groupId, x1Pct, y1Pct, x2Pct, y2Pct, durationMs, opts }) => {
      logger?.audit("group:swipePct", {
        groupId,
        x1Pct,
        y1Pct,
        x2Pct,
        y2Pct,
        durationMs,
        opts,
      });
      return groupBroadcast.swipePct(
        groupId,
        Number(x1Pct),
        Number(y1Pct),
        Number(x2Pct),
        Number(y2Pct),
        Number(durationMs || 220),
        opts || {}
      );
    }
  );

  ipcMain.handle("group:swipeDir", async (_, { groupId, dir, opts }) => {
    logger?.audit("group:swipeDir", { groupId, dir, opts });
    return groupBroadcast.swipeDir(groupId, dir, opts || {});
  });

  ipcMain.handle("group:key", async (_, { groupId, key, opts }) => {
    logger?.audit("group:key", { groupId, key, opts });
    return groupBroadcast.key(groupId, key, opts || {});
  });

  ipcMain.handle("group:wake", async (_, { groupId, opts }) => {
    logger?.audit("group:wake", { groupId, opts });
    return groupBroadcast.wake(groupId, opts || {});
  });

  ipcMain.handle("group:screenOff", async (_, { groupId, opts }) => {
    logger?.audit("group:screenOff", { groupId, opts });
    return groupBroadcast.screenOff(groupId, opts || {});
  });

  ipcMain.handle("group:shutdown", async (_, { groupId, opts }) => {
    logger?.audit("group:shutdown", { groupId, opts });
    return groupBroadcast.shutdown(groupId, opts || {});
  });

  // ---- Group Macro ----
  ipcMain.handle(
    "group:macroPlay",
    async (_, { groupId, macroId, options, fanoutOpts }) => {
      logger?.audit("group:macroPlay", {
        groupId,
        macroId,
        options,
        fanoutOpts,
      });
      return groupBroadcast.playMacro(
        groupId,
        macroId,
        options || {},
        fanoutOpts || {}
      );
    }
  );

  ipcMain.handle("group:macroStopGroup", async (_, { groupId }) => {
    logger?.audit("group:macroStopGroup", { groupId });
    return groupBroadcast.stopGroup(groupId);
  });

  ipcMain.handle("group:macroStopDevice", async (_, { groupId, deviceId }) => {
    logger?.audit("group:macroStopDevice", { groupId, deviceId });
    return groupBroadcast.stopDevice(groupId, deviceId);
  });

  ipcMain.handle("group:macroSnapshot", async (_, { groupId }) => {
    return groupBroadcast.snapshot(groupId);
  });

  app.on("before-quit", () => {
    persistSettings();
    logger?.info("app:beforeQuit", {});
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  // show last log lines in UI quickly
  try {
    const tail = logger.tailLines(120);
    for (const line of tail) safeSend("log:line", line);
  } catch {}

  logger?.info("app:ready", {
    autoStartEnabled: layoutConfig.autoStartEnabled,
    autoWakeOnRecover: layoutConfig.autoWakeOnRecover,
  });
});

app.on("window-all-closed", () => {
  registry.stopPolling();
  scrcpy.stopAll();
  if (process.platform !== "darwin") app.quit();
});
