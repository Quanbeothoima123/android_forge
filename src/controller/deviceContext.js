class DeviceContext {
  constructor(deviceId) {
    this.deviceId = deviceId;

    this.state = "UNKNOWN";
    this.model = null;
    this.androidVersion = null;
    this.resolution = null;

    this.agentReady = false;
    this._lastAgentCheckAt = 0;

    this.lastSeenAt = Date.now();

    this._chain = Promise.resolve();
    this._disposed = false;
  }

  updateFromDiscovery({ state, model }) {
    this.lastSeenAt = Date.now();
    this.state = state;
    if (model) this.model = model;
    if (this.state !== "ONLINE") this.agentReady = false;
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
    };
  }

  dispose() {
    this._disposed = true;
  }

  enqueue(taskFn) {
    // IMPORTANT: nếu task trước lỗi, chain vẫn tiếp tục -> tránh “crash khi spam”
    this._chain = this._chain
      .catch(() => {})
      .then(async () => {
        if (this._disposed)
          throw new Error(`DeviceContext disposed: ${this.deviceId}`);
        return await taskFn();
      });

    return this._chain;
  }
}

module.exports = { DeviceContext };
