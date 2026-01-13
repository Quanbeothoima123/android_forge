// src/controller/groupBroadcast.js
const inputSmart = require("./inputControllerSmart");
const adbInput = require("./inputControllerAdb");
const { runMacroOnDevice } = require("../macro/macroRunner");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function jitterPct(p, jitter) {
  if (!jitter) return p;
  const j = (Math.random() * 2 - 1) * jitter;
  return clamp01(p + j);
}

function pctToPx(pct01, axisMax) {
  return Math.max(0, Math.min(axisMax - 1, Math.round(pct01 * axisMax)));
}

/**
 * GroupBroadcast
 * - Broadcast actions to many devices, staggered by per-device delay + jitter
 * - Per-device random offset (xy jitter)
 * - Group Macro run with stop per device
 *
 * Requires:
 * - registry: DeviceRegistry
 * - getGroup: (groupId)=>{id,name,devices:Set|Array}
 * - loadMacroById: (macroId)=>macroObj
 * - runningMacroByDevice: Map for locking (shared with single-device macro)
 * - sendMacroState/progress: same channel as existing renderer (macro:state, macro:progress)
 */
class GroupBroadcast {
  constructor({
    registry,
    getGroup,
    loadMacroById,
    runningMacroByDevice,
    sendMacroState,
    sendMacroProgress,
  }) {
    this.registry = registry;
    this.getGroup = getGroup;
    this.loadMacroById = loadMacroById;

    this.runningMacroByDevice = runningMacroByDevice;

    this.sendMacroState = sendMacroState || (() => {});
    this.sendMacroProgress = sendMacroProgress || (() => {});

    // groupId -> { runId, states: Map(deviceId -> {stop:boolean, startedAt:number, macroId:string}) }
    this.runningByGroup = new Map();
  }

  _devicesOfGroup(groupId) {
    const g = this.getGroup(groupId);
    if (!g) throw new Error("group not found");
    const arr = Array.isArray(g.devices) ? g.devices : Array.from(g.devices);
    return arr.map((x) => String(x)).filter(Boolean);
  }

  /**
   * Fanout helper: schedule per device with baseDelay*i + jitter
   */
  async _fanout(groupId, fn, opts = {}) {
    const deviceIds = this._devicesOfGroup(groupId);

    const base = Number.isFinite(opts.baseDelayMs)
      ? Number(opts.baseDelayMs)
      : 90;
    const jitter = Number.isFinite(opts.jitterMs) ? Number(opts.jitterMs) : 160;

    let i = 0;
    for (const deviceId of deviceIds) {
      const ctx = this.registry.get(deviceId);
      if (!ctx || ctx.state !== "ONLINE") continue;

      const delay = base * i + rand(0, jitter);
      i++;

      ctx
        .enqueue(async () => {
          await sleep(delay);
          await fn(ctx, { delay });
        })
        .catch(() => {});
    }

    return true;
  }

  /**
   * Broadcast TAP by pct (0..1)
   * opts: { baseDelayMs, jitterMs, xyJitterPct }
   */
  tapPct(groupId, xPct, yPct, opts = {}) {
    const xyJitterPct = Number(opts.xyJitterPct || 0);

    return this._fanout(
      groupId,
      async (ctx) => {
        const snap = ctx.snapshot();
        const r = snap.resolution;
        if (!r?.width || !r?.height) return;

        const xp = jitterPct(Number(xPct), xyJitterPct);
        const yp = jitterPct(Number(yPct), xyJitterPct);

        const x = pctToPx(xp, r.width);
        const y = pctToPx(yp, r.height);

        await inputSmart.tap(ctx, x, y);
      },
      opts
    );
  }

  /**
   * Broadcast SWIPE by pct
   */
  swipePct(groupId, x1Pct, y1Pct, x2Pct, y2Pct, durationMs = 220, opts = {}) {
    const xyJitterPct = Number(opts.xyJitterPct || 0);
    const dur = Math.max(80, Number(durationMs) || 220);

    return this._fanout(
      groupId,
      async (ctx) => {
        const snap = ctx.snapshot();
        const r = snap.resolution;
        if (!r?.width || !r?.height) return;

        const x1p = jitterPct(Number(x1Pct), xyJitterPct);
        const y1p = jitterPct(Number(y1Pct), xyJitterPct);
        const x2p = jitterPct(Number(x2Pct), xyJitterPct);
        const y2p = jitterPct(Number(y2Pct), xyJitterPct);

        const x1 = pctToPx(x1p, r.width);
        const y1 = pctToPx(y1p, r.height);
        const x2 = pctToPx(x2p, r.width);
        const y2 = pctToPx(y2p, r.height);

        await inputSmart.swipe(ctx, x1, y1, x2, y2, dur);
      },
      opts
    );
  }

  /**
   * Broadcast KEY
   * - HOME/BACK => smart (agent if ready)
   * - Others => ADB key fallback (stable)
   */
  key(groupId, keyName, opts = {}) {
    const k = String(keyName || "").toUpperCase();

    return this._fanout(
      groupId,
      async (ctx) => {
        if (k === "HOME" || k === "BACK") {
          await inputSmart.key(ctx, k);
          return;
        }
        // use adbInput.key which supports more keys
        await adbInput.key(ctx.deviceId, k);
      },
      opts
    );
  }

  /**
   * Run macro on whole group
   * - Stagger start (baseDelayMs/jitterMs)
   * - Per device stop
   * - Locks device if already running macro
   *
   * Returns { ok:true, runId, started:[deviceId...] }
   */
  async playMacro(groupId, macroId, options = {}, fanoutOpts = {}) {
    const gDevices = this._devicesOfGroup(groupId);
    const macro = this.loadMacroById(macroId);
    if (!macro) throw new Error("Macro not found: " + macroId);

    // new run
    const runId = Date.now();
    const states = new Map();
    this.runningByGroup.set(groupId, { runId, states });

    const base = Number.isFinite(fanoutOpts.baseDelayMs)
      ? Number(fanoutOpts.baseDelayMs)
      : 120;
    const jitter = Number.isFinite(fanoutOpts.jitterMs)
      ? Number(fanoutOpts.jitterMs)
      : 280;

    const started = [];

    let i = 0;
    for (const deviceId of gDevices) {
      const ctx = this.registry.get(deviceId);
      if (!ctx || ctx.state !== "ONLINE") continue;

      // lock: if per-device macro already running, skip
      if (this.runningMacroByDevice.has(deviceId)) continue;

      const state = {
        stop: false,
        startedAt: Date.now(),
        macroId: String(macroId),
      };
      states.set(deviceId, state);
      started.push(deviceId);

      // also lock device globally
      this.runningMacroByDevice.set(deviceId, {
        stop: false,
        token: runId,
        startedAt: Date.now(),
        macroId: String(macroId),
        source: "group",
        groupId,
      });

      const delay = base * i + rand(0, jitter);
      i++;

      this.sendMacroState(deviceId, {
        running: true,
        macroId: String(macroId),
      });

      ctx
        .enqueue(async () => {
          await sleep(delay);

          try {
            await runMacroOnDevice(ctx, macro, options || {}, {
              shouldStop: () => {
                const curGroup = this.runningByGroup.get(groupId);
                if (!curGroup || curGroup.runId !== runId) return true;
                const st = curGroup.states.get(deviceId);
                const lock = this.runningMacroByDevice.get(deviceId);
                return !!(st?.stop || lock?.stop);
              },
              token: runId,
              onProgress: (p) => {
                this.sendMacroProgress(deviceId, p);
              },
            });

            return { ok: true };
          } finally {
            // unlock per device
            const lock = this.runningMacroByDevice.get(deviceId);
            if (lock && lock.token === runId)
              this.runningMacroByDevice.delete(deviceId);

            // clean group state
            const cur = this.runningByGroup.get(groupId);
            if (cur && cur.runId === runId) {
              cur.states.delete(deviceId);
              if (cur.states.size === 0) this.runningByGroup.delete(groupId);
            }

            this.sendMacroState(deviceId, { running: false, macroId: "" });
          }
        })
        .catch(() => {});
    }

    return { ok: true, runId, started };
  }

  /**
   * Stop macro for whole group
   */
  stopGroup(groupId) {
    const cur = this.runningByGroup.get(groupId);
    if (!cur) return { ok: true, stopped: 0 };

    let stopped = 0;
    for (const deviceId of cur.states.keys()) {
      const st = cur.states.get(deviceId);
      if (st) st.stop = true;

      const lock = this.runningMacroByDevice.get(deviceId);
      if (lock && lock.source === "group" && lock.groupId === groupId) {
        lock.stop = true;
      }
      stopped++;
    }

    // keep states, tasks will exit and cleanup
    return { ok: true, stopped };
  }

  /**
   * Stop macro for a single device in a group run
   */
  stopDevice(groupId, deviceId) {
    const cur = this.runningByGroup.get(groupId);
    if (!cur) return { ok: true, stopped: false };

    const did = String(deviceId || "");
    const st = cur.states.get(did);
    if (st) st.stop = true;

    const lock = this.runningMacroByDevice.get(did);
    if (lock && lock.source === "group" && lock.groupId === groupId) {
      lock.stop = true;
    }

    return { ok: true, stopped: !!st };
  }

  /**
   * Snapshot group macro run (optional)
   */
  snapshot(groupId) {
    const cur = this.runningByGroup.get(groupId);
    if (!cur) return null;
    return {
      groupId,
      runId: cur.runId,
      devices: Array.from(cur.states.entries()).map(([deviceId, st]) => ({
        deviceId,
        stop: !!st.stop,
        startedAt: st.startedAt,
        macroId: st.macroId,
      })),
    };
  }
}

module.exports = { GroupBroadcast };
