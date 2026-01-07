class DeviceContext {
  constructor(deviceId) {
    this.deviceId = deviceId;

    this.state = "UNKNOWN"; // ONLINE/OFFLINE/UNAUTHORIZED/UNKNOWN
    this.model = null;
    this.androidVersion = null;
    this.resolution = null;

    // AndroidForgeAgent readiness
    this.agentReady = false;
    this._lastAgentCheckAt = 0;

    this.lastSeenAt = Date.now();

    // Simple per-device queue: promise chain
    this._chain = Promise.resolve();
    this._disposed = false;

    // NEW: protect against spam (Back/Home/Tap spam)
    this._pending = 0;
    this.maxPending = 25; // tune: 15~40 tùy bạn
  }

  updateFromDiscovery({ state, model }) {
    this.lastSeenAt = Date.now();
    this.state = state;
    if (model) this.model = model;

    if (this.state !== "ONLINE") {
      this.agentReady = false;
    }
  }

  setInfo({ model, androidVersion, resolution }) {
    if (model) this.model = model;
    if (androidVersion) this.androidVersion = androidVersion;
    if (resolution) this.resolution = resolution;
  }

  setAgentReady(isReady) {
    this.agentReady = !!isReady;
    this._lastAgentCheckAt = Date.now();
  }

  shouldCheckAgent(thresholdMs = 5000) {
    if (this.state !== "ONLINE") return false;
    return Date.now() - this._lastAgentCheckAt > thresholdMs;
  }

  snapshot() {
    return {
      deviceId: this.deviceId,
      state: this.state,
      model: this.model,
      androidVersion: this.androidVersion,
      resolution: this.resolution,
      agentReady: this.agentReady,
      lastSeenAt: this.lastSeenAt,
      pending: this._pending,
    };
  }

  dispose() {
    this._disposed = true;
  }

  enqueue(taskFn, opts = {}) {
    const dropIfBusy = opts.dropIfBusy !== false; // default true
    if (dropIfBusy && this._pending >= this.maxPending) {
      // tránh crash do spam
      return Promise.reject(
        new Error(
          `Device busy: too many pending actions (${this._pending}). Slow down.`
        )
      );
    }

    this._pending++;

    // FIX: nếu task trước reject, chain vẫn phải tiếp tục
    this._chain = this._chain
      .catch(() => {}) // swallow previous error to keep queue alive
      .then(async () => {
        if (this._disposed)
          throw new Error(`DeviceContext disposed: ${this.deviceId}`);
        return await taskFn();
      })
      .finally(() => {
        this._pending = Math.max(0, this._pending - 1);
      });

    return this._chain;
  }
}

module.exports = { DeviceContext };
