// src/macro/macroRecorder.js
class MacroRecorder {
  constructor() {
    this._recording = false;
    this._deviceId = "";
    this._deviceRes = null;

    this._steps = [];
    this._lastTs = 0;
  }

  isRecording() {
    return this._recording;
  }

  start({ deviceId, deviceRes }) {
    this._recording = true;
    this._deviceId = deviceId;
    this._deviceRes = deviceRes || null;
    this._steps = [];
    this._lastTs = Date.now();
  }

  stop() {
    const out = { steps: this._steps.slice() };
    this._recording = false;
    this._deviceId = "";
    this._deviceRes = null;
    this._steps = [];
    this._lastTs = 0;
    return out;
  }

  _push(step) {
    if (!this._recording) return;

    const now = Date.now();
    const dtMs = Math.max(0, now - (this._lastTs || now));
    this._lastTs = now;

    this._steps.push({
      ...step,
      dtMs,
      t: now,
    });
  }

  // ---- Recorded from scrcpyHook (pct 0..1) ----
  recordTapPct(xPct, yPct) {
    this._push({
      type: "TAP",
      xPct: Number(xPct),
      yPct: Number(yPct),
    });
  }

  recordSwipePct(x1Pct, y1Pct, x2Pct, y2Pct, durationMs) {
    this._push({
      type: "SWIPE",
      x1Pct: Number(x1Pct),
      y1Pct: Number(y1Pct),
      x2Pct: Number(x2Pct),
      y2Pct: Number(y2Pct),
      durationMs: Number(durationMs) || 220,
    });
  }

  recordLongPressPct(xPct, yPct, durationMs) {
    this._push({
      type: "LONG_PRESS",
      xPct: Number(xPct),
      yPct: Number(yPct),
      durationMs: Number(durationMs) || 600,
    });
  }

  // ---- Manual inject from UI ----
  injectText(text) {
    this._push({
      type: "TEXT",
      text: String(text ?? ""),
    });
  }

  injectKey(key) {
    const k = String(key || "").toUpperCase();
    this._push({
      type: "KEY",
      key: k,
    });
  }

  injectWait(durationMs) {
    this._push({
      type: "WAIT",
      durationMs: Number(durationMs) || 0,
    });
  }
}

module.exports = { MacroRecorder };
