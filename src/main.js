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

// ===== Layout config (from UI) =====
// scalePct affects: scrcpy -m + initial --window-width/--window-height + grid cell size
const layoutConfig = {
  scalePct: 50, // 25/50/75/100/125
  cols: 4,
  rows: 0, // 0 => no clamp rows
  margin: 8,
  forceResizeOnApply: true, // Apply layout => resize windows to cell size
};

// ===== window =====
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/**
 * Convert raw coordinate -> pixel
 * raw = { value: number, unit: 'px'|'pct' }
 * axisMax = res.width or res.height
 */
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
  return SCRCPY_BASE_PORT + (slotIndex % 200);
}

// ---- helpers: derive window cell size + scrcpy maxSize from scale ----
function normalizeScalePct(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return 50;
  const allowed = [25, 50, 75, 100, 125];
  // snap to closest
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

/**
 * Decide initial window size for scrcpy and cell spacing.
 * - baseW is "farm friendly" width at 100% (you can tweak).
 * - scale multiplies baseW/baseH
 * - keep aspect from device resolution when available.
 */
function computeScrcpyCellAndMaxSize(deviceSnapshot, scalePct) {
  const res = deviceSnapshot?.resolution;
  const scale = normalizeScalePct(scalePct) / 100;

  const baseW100 = 360; // your farm base
  const targetW = clampInt(baseW100 * scale, 160, 1200);

  if (!res || !res.width || !res.height) {
    const targetH = clampInt(780 * scale, 240, 1800);
    // maxSize: use max dimension
    const maxSize = clampInt(Math.max(targetW, targetH), 160, 2400);
    return { width: targetW, height: targetH, maxSize };
  }

  const h = Math.round(targetW * (res.height / res.width));
  const targetH = clampInt(h, 240, 2000);

  // scrcpy -m is the "max render size" (max of width/height)
  // we scale by same factor against device max dimension.
  const deviceMaxDim = Math.max(res.width, res.height);
  const maxSize = clampInt(Math.round(deviceMaxDim * scale), 160, 6000);

  return { width: targetW, height: targetH, maxSize };
}

function getLayoutConfig() {
  return {
    scalePct: layoutConfig.scalePct,
    cols: layoutConfig.cols,
    rows: layoutConfig.rows,
    margin: layoutConfig.margin,
    forceResizeOnApply: layoutConfig.forceResizeOnApply,
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
    // 0 => no clamp; else 1..20
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

  // ===== layout config =====
  ipcMain.handle("layout:get", async () => getLayoutConfig());
  ipcMain.handle("layout:set", async (_, patch) => {
    setLayoutConfig(patch);
    return getLayoutConfig();
  });

  // ===== scrcpy lifecycle =====
  ipcMain.handle("scrcpy:start", async (_, { deviceId }) => {
    const cfg = getLayoutConfig();
    const ctx = ensureOnline(registry.get(deviceId));
    const snap = ctx.snapshot();

    const slotIndex = allocSlot(deviceId);
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
        borderless: false, // must be false for manual resize
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

  // startAll sequential + delay to avoid adb/scrcpy race
  ipcMain.handle("scrcpy:startAll", async () => {
    const cfg = getLayoutConfig();
    const online = registry.listSnapshots().filter((d) => d.state === "ONLINE");
    const started = [];

    for (const d of online) {
      try {
        const ctx = ensureOnline(registry.get(d.deviceId));
        const snap = ctx.snapshot();

        const slotIndex = allocSlot(d.deviceId);
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
      } catch {
        // ignore per-device start errors
      }

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

  /**
   * Apply layout to currently running windows without restart.
   * payload: { forceResize?: boolean }
   */
  ipcMain.handle("scrcpy:applyLayout", async (_, payload = {}) => {
    const cfg = getLayoutConfig();
    const forceResize =
      payload.forceResize != null
        ? !!payload.forceResize
        : !!cfg.forceResizeOnApply;

    // build running window list from scrcpyController internal map order:
    // we want stable order by slotIndex (allocSlot)
    const runningIds = [];
    for (const d of registry.listSnapshots()) {
      if (d.state !== "ONLINE") continue;
      if (!scrcpy.isRunning(d.deviceId)) continue;
      runningIds.push(d.deviceId);
    }

    // sort by slotIndex for stable grid
    runningIds.sort(
      (a, b) => (slotByDevice.get(a) ?? 1e9) - (slotByDevice.get(b) ?? 1e9)
    );

    const items = runningIds.map((id) => {
      const s = scrcpy.procs?.get ? scrcpy.procs.get(id) : null;
      // NOTE: scrcpyController.procs is internal but exists in your class
      // If future refactor hides it, we'd add a getter.
      return {
        deviceId: id,
        title: s?.title || `forge:${id}`,
        slotIndex: allocSlot(id),
      };
    });

    // we need a representative cell size.
    // Use first running device snapshot to compute, then apply same cell to all.
    let cell = { width: 360, height: 780, maxSize: 540 };
    if (runningIds.length) {
      const ctx = registry.get(runningIds[0]);
      if (ctx) {
        const snap = ctx.snapshot();
        cell = computeScrcpyCellAndMaxSize(snap, cfg.scalePct);
      }
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

  // raw tap: {x:{value,unit}, y:{value,unit}}
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

  // raw swipe: x1,y1,x2,y2 are raw units
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

  // directional swipes by percent presets
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
