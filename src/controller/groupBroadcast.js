// src/controller/groupBroadcast.js
const input = require("./inputControllerSmart");
const { runMacroOnDevice } = require("../macro/macroRunner");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

class GroupBroadcast {
  constructor(registry) {
    this.registry = registry;
    this.running = new Map(); // groupId -> Map(deviceId -> state)
  }

  async _fanout(group, fn, opts = {}) {
    const base = opts.baseDelayMs ?? 80;
    const jitter = opts.jitterMs ?? 120;

    let i = 0;
    for (const deviceId of group.devices) {
      const ctx = this.registry.get(deviceId);
      if (!ctx || ctx.state !== "ONLINE") continue;

      const delay = base * i + rand(0, jitter);
      i++;

      ctx
        .enqueue(async () => {
          await sleep(delay);
          await fn(ctx);
        })
        .catch(() => {});
    }
  }

  tap(group, xPct, yPct) {
    return this._fanout(group, async (ctx) => {
      const r = ctx.snapshot().resolution;
      if (!r) return;
      const x = Math.round(xPct * r.width);
      const y = Math.round(yPct * r.height);
      await input.tap(ctx, x, y);
    });
  }

  key(group, key) {
    return this._fanout(group, async (ctx) => {
      await input.key(ctx, key);
    });
  }

  macro(group, macro, options = {}) {
    const states = new Map();
    this.running.set(group.id, states);

    let i = 0;
    for (const deviceId of group.devices) {
      const ctx = this.registry.get(deviceId);
      if (!ctx || ctx.state !== "ONLINE") continue;

      const state = { stop: false };
      states.set(deviceId, state);

      const delay = rand(0, 600) + i * 150;
      i++;

      ctx
        .enqueue(async () => {
          await sleep(delay);
          await runMacroOnDevice(ctx, macro, options, {
            shouldStop: () => state.stop,
          });
        })
        .finally(() => {
          states.delete(deviceId);
        });
    }
  }

  stopGroup(groupId) {
    const m = this.running.get(groupId);
    if (!m) return;
    for (const s of m.values()) s.stop = true;
    this.running.delete(groupId);
  }
}

module.exports = { GroupBroadcast };
