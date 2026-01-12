// src/macro/scrcpyHook.js
const { windowManager } = require("node-window-manager");

// ✅ FIX: uiohook-napi export { uIOhook }
const { uIOhook } = require("uiohook-napi");

function findScrcpyWindow(deviceId) {
  const target = `forge:${deviceId}`;
  const wins = windowManager.getWindows();

  let best = wins.find((w) => String(w.getTitle?.() || "") === target);
  if (best) return best;

  best = wins.find((w) => String(w.getTitle?.() || "").includes(target));
  return best || null;
}

function computeDisplayRect(bounds, res) {
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);

  const rw = Math.max(1, res.width);
  const rh = Math.max(1, res.height);

  const scale = Math.min(w / rw, h / rh);
  const dw = rw * scale;
  const dh = rh * scale;

  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;

  return { ox, oy, dw, dh, w, h };
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

class ScrcpyHook {
  constructor() {
    this._running = false;
    this._deviceId = "";
    this._res = null;
    this._win = null;
    this._onStep = null;

    this._mouseDown = null; // { t, x, y, moved, startPct }
    this._moveThreshold = 6;
    this._longPressMinMs = 520;

    this._handleDown = this._handleDown.bind(this);
    this._handleUp = this._handleUp.bind(this);
    this._handleMove = this._handleMove.bind(this);
  }

  isRunning() {
    return this._running;
  }

  start({ deviceId, deviceRes, onStep }) {
    if (this._running) return { ok: true };

    this._deviceId = deviceId;
    this._res = deviceRes;
    this._onStep = onStep;

    const win = findScrcpyWindow(deviceId);
    if (!win) {
      throw new Error(
        `Cannot find scrcpy window "forge:${deviceId}". Make sure scrcpy is running and title is correct.`
      );
    }
    this._win = win;

    // ✅ FIX: dùng uIOhook thay vì uiohook
    uIOhook.on("mousedown", this._handleDown);
    uIOhook.on("mouseup", this._handleUp);
    uIOhook.on("mousemove", this._handleMove);

    uIOhook.start();
    this._running = true;
    return { ok: true };
  }

  stop() {
    if (!this._running) return { ok: true };

    try {
      // Một số bản uiohook có off, một số dùng removeListener
      if (typeof uIOhook.off === "function") {
        uIOhook.off("mousedown", this._handleDown);
        uIOhook.off("mouseup", this._handleUp);
        uIOhook.off("mousemove", this._handleMove);
      } else if (typeof uIOhook.removeListener === "function") {
        uIOhook.removeListener("mousedown", this._handleDown);
        uIOhook.removeListener("mouseup", this._handleUp);
        uIOhook.removeListener("mousemove", this._handleMove);
      }

      if (typeof uIOhook.stop === "function") uIOhook.stop();
    } catch {}

    this._running = false;
    this._deviceId = "";
    this._res = null;
    this._win = null;
    this._onStep = null;
    this._mouseDown = null;

    return { ok: true };
  }

  _insideScrcpy(x, y) {
    if (!this._win || !this._res) return null;

    const b = this._win.getBounds();
    const localX = x - b.x;
    const localY = y - b.y;

    const rect = computeDisplayRect(
      { width: b.width, height: b.height },
      this._res
    );

    const dx = localX - rect.ox;
    const dy = localY - rect.oy;

    if (dx < 0 || dy < 0 || dx > rect.dw || dy > rect.dh) return null;

    const xp = clamp01(dx / rect.dw);
    const yp = clamp01(dy / rect.dh);
    return { xp, yp };
  }

  _handleDown(e) {
    if (!this._running) return;
    const hit = this._insideScrcpy(e.x, e.y);
    if (!hit) return;

    this._mouseDown = {
      t: Date.now(),
      x: e.x,
      y: e.y,
      moved: false,
      startPct: { x: hit.xp, y: hit.yp },
    };
  }

  _handleMove(e) {
    if (!this._running || !this._mouseDown) return;
    const dx = e.x - this._mouseDown.x;
    const dy = e.y - this._mouseDown.y;
    if (Math.hypot(dx, dy) >= this._moveThreshold) {
      this._mouseDown.moved = true;
    }
  }

  _handleUp(e) {
    if (!this._running || !this._mouseDown) return;

    const md = this._mouseDown;
    this._mouseDown = null;

    const hitEnd = this._insideScrcpy(e.x, e.y);
    if (!hitEnd) return;

    const dt = Date.now() - md.t;
    const s = md.startPct;
    const t = { x: hitEnd.xp, y: hitEnd.yp };

    if (!md.moved) {
      if (dt >= this._longPressMinMs) {
        this._onStep?.({
          type: "LONG_PRESS",
          xPct: s.x,
          yPct: s.y,
          durationMs: dt,
          t: Date.now(),
        });
      } else {
        this._onStep?.({
          type: "TAP",
          xPct: s.x,
          yPct: s.y,
          t: Date.now(),
        });
      }
      return;
    }

    const durationMs = Math.max(80, Math.min(1200, dt));
    this._onStep?.({
      type: "SWIPE",
      x1Pct: s.x,
      y1Pct: s.y,
      x2Pct: t.x,
      y2Pct: t.y,
      durationMs,
      t: Date.now(),
    });
  }
}

module.exports = { ScrcpyHook };
