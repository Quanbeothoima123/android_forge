const {
  listDevicesRaw,
  fetchDeviceInfo,
  checkAgentReady,
} = require("./deviceManager");
const { DeviceContext } = require("./deviceContext");

class DeviceRegistry {
  constructor() {
    this.map = new Map(); // deviceId -> DeviceContext
    this._pollTimer = null;
    this._isPolling = false;
  }

  startPolling(intervalMs = 1500) {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this.pollOnce(), intervalMs);
    this.pollOnce();
  }

  stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  get(deviceId) {
    return this.map.get(deviceId) || null;
  }

  listSnapshots() {
    return Array.from(this.map.values()).map((ctx) => ctx.snapshot());
  }

  async pollOnce() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      const devices = await listDevicesRaw();
      const seen = new Set(devices.map((d) => d.deviceId));

      // Mark removed devices
      for (const [id, ctx] of this.map.entries()) {
        if (!seen.has(id)) {
          ctx.state = "OFFLINE";
          ctx.agentReady = false;
        }
      }

      // Add/update devices
      for (const d of devices) {
        let ctx = this.map.get(d.deviceId);
        if (!ctx) {
          ctx = new DeviceContext(d.deviceId);
          this.map.set(d.deviceId, ctx);
        }

        ctx.updateFromDiscovery({ state: d.state, model: d.model });

        // If ONLINE and missing info, fetch info in its own queue
        if (
          ctx.state === "ONLINE" &&
          (!ctx.androidVersion || !ctx.resolution || !ctx.model)
        ) {
          ctx
            .enqueue(async () => {
              if (ctx.state !== "ONLINE") return;
              const info = await fetchDeviceInfo(ctx.deviceId, ctx.model);
              ctx.setInfo(info);
            })
            .catch(() => {});
        }

        // If ONLINE, periodically check agent readiness (not too often)
        if (ctx.shouldCheckAgent(5000)) {
          ctx
            .enqueue(async () => {
              if (ctx.state !== "ONLINE") return;
              const ok = await checkAgentReady(ctx.deviceId);
              ctx.setAgentReady(ok);
            })
            .catch(() => {
              // If adb fails, keep last known state
            });
        }
      }
    } catch (e) {
      // If adb is down, don't crash the app; registry stays as-is
    } finally {
      this._isPolling = false;
    }
  }
}

module.exports = { DeviceRegistry };
