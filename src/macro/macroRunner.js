// src/macro/macroRunner.js
const input = require("../controller/inputControllerSmart");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ✅ NEW: sleep but can be interrupted by shouldStop (stop group/single macro faster)
async function sleepInterruptible(totalMs, shouldStop, tickMs = 60) {
  let remain = Math.max(0, Number(totalMs) || 0);
  const tick = Math.max(15, Number(tickMs) || 60);

  while (remain > 0) {
    if (shouldStop && shouldStop()) return false;
    const s = Math.min(remain, tick);
    await sleep(s);
    remain -= s;
  }
  return true;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function jitterPct(p, jitter) {
  if (!jitter) return p;
  const j = (Math.random() * 2 - 1) * jitter;
  return clamp01(p + j);
}

function pctToPx(pct01, axisMax) {
  return Math.max(0, Math.min(axisMax - 1, Math.round(pct01 * axisMax)));
}

function getDeviceId(ctx) {
  // best-effort
  try {
    const s = ctx.snapshot?.();
    if (s?.deviceId) return s.deviceId;
  } catch {}
  return ctx.deviceId || ctx.id || ctx._deviceId || "";
}

async function runMacroOnDevice(ctx, macro, options = {}, runtime = {}) {
  const shouldStop = runtime.shouldStop || (() => false);
  const onProgress = runtime.onProgress || (() => {});

  const speed = Number(options.speed ?? 1.0) || 1.0;
  const xyJitterPct = Number(
    options.xyJitterPct ?? macro?.settings?.randomize?.xyJitterPct ?? 0
  );
  const delayJitterPct = Number(
    options.delayJitterPct ?? macro?.settings?.randomize?.delayJitterPct ?? 0
  );

  const steps = Array.isArray(macro?.steps) ? macro.steps : [];
  if (!steps.length) return;

  let lastTapPct = null;

  // ✅ ensure ctx.deviceId exists (inputControllerSmart expects ctx.deviceId)
  const deviceId = getDeviceId(ctx);
  if (!ctx.deviceId) ctx.deviceId = deviceId;

  for (let i = 0; i < steps.length; i++) {
    if (shouldStop()) break;

    const s = steps[i];
    const type = String(s.type || "").toUpperCase();

    onProgress({
      deviceId,
      stepIndex: i + 1,
      stepCount: steps.length,
      stepType: type,
    });

    // delay between steps (dtMs) — ✅ interruptible (stop won't "carry on")
    const dt = Number(s.dtMs ?? 60);
    const baseDelay = Math.max(0, Math.round(dt / speed));
    const jitter = baseDelay * delayJitterPct * (Math.random() * 2 - 1);
    const targetDelay = Math.max(0, Math.round(baseDelay + jitter));
    if (targetDelay > 0) {
      const ok = await sleepInterruptible(targetDelay, shouldStop, 60);
      if (!ok) break;
    }

    if (shouldStop()) break;

    const snap = ctx.snapshot?.() || {};
    const res = snap.resolution || {};
    const w = res.width || 1080;
    const h = res.height || 1920;

    if (type === "TAP") {
      const xPct = jitterPct(Number(s.xPct), xyJitterPct);
      const yPct = jitterPct(Number(s.yPct), xyJitterPct);
      const x = pctToPx(xPct, w);
      const y = pctToPx(yPct, h);
      lastTapPct = { xPct, yPct };

      if (shouldStop()) break;
      await input.tap(ctx, x, y);
      continue;
    }

    if (type === "LONG_PRESS") {
      const xPct = jitterPct(Number(s.xPct), xyJitterPct);
      const yPct = jitterPct(Number(s.yPct), xyJitterPct);
      const x = pctToPx(xPct, w);
      const y = pctToPx(yPct, h);
      lastTapPct = { xPct, yPct };
      const dur = Math.max(80, Number(s.durationMs || 600));

      if (shouldStop()) break;
      await input.longPress(ctx, x, y, dur);
      continue;
    }

    if (type === "SWIPE") {
      const x1Pct = jitterPct(Number(s.x1Pct), xyJitterPct);
      const y1Pct = jitterPct(Number(s.y1Pct), xyJitterPct);
      const x2Pct = jitterPct(Number(s.x2Pct), xyJitterPct);
      const y2Pct = jitterPct(Number(s.y2Pct), xyJitterPct);

      const x1 = pctToPx(x1Pct, w);
      const y1 = pctToPx(y1Pct, h);
      const x2 = pctToPx(x2Pct, w);
      const y2 = pctToPx(y2Pct, h);

      const dur = Math.max(80, Number(s.durationMs || 220));

      if (shouldStop()) break;
      await input.swipe(ctx, x1, y1, x2, y2, dur);
      continue;
    }

    if (type === "KEY") {
      const key = String(s.key || "").toUpperCase();

      if (shouldStop()) break;
      await input.key(ctx, key);
      continue;
    }

    if (type === "WAIT") {
      const ms = Math.max(0, Number(s.durationMs || s.ms || 0));
      const scaled = ms ? Math.round(ms / speed) : 0;

      if (scaled > 0) {
        const ok = await sleepInterruptible(scaled, shouldStop, 60);
        if (!ok) break;
      }
      continue;
    }

    if (type === "TEXT") {
      const text = String(s.text || "");

      if (shouldStop()) break;

      // TEXT trong smart controller yêu cầu agentReady = true
      // (đúng mục tiêu của bạn cho Unicode)
      try {
        let r = await input.text(ctx, text);

        if (shouldStop()) break;

        // fallback: nếu agent trả ERR no_focus / not_editable và có lastTapPct
        if (typeof r === "string" && r.startsWith("ERR") && lastTapPct) {
          if (r.includes("no_focus") || r.includes("not_editable")) {
            const x = pctToPx(lastTapPct.xPct, w);
            const y = pctToPx(lastTapPct.yPct, h);

            if (shouldStop()) break;
            await input.tap(ctx, x, y);

            const ok = await sleepInterruptible(120, shouldStop, 40);
            if (!ok) break;

            if (shouldStop()) break;
            r = await input.text(ctx, text);
          }
        }

        if (typeof r === "string" && r.startsWith("ERR")) {
          throw new Error(r);
        }
      } catch (e) {
        // normalize error message (giữ đúng error bạn đang expect)
        const msg = String(e?.message || e || "");
        if (msg.toLowerCase().includes("agent not ready")) {
          throw new Error("ERR unicode_not_supported_without_agent");
        }
        throw e;
      }
      continue;
    }

    // unknown step -> ignore
  }

  // optional progress "done" marker (UI currently logs on macro:state)
  try {
    onProgress({ deviceId, done: true, stepCount: steps.length });
  } catch {}
}

module.exports = { runMacroOnDevice };
