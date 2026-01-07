const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forgeAPI", {
  listDevices: () => ipcRenderer.invoke("devices:list"),
  agentPing: (deviceId) => ipcRenderer.invoke("device:agentPing", { deviceId }),

  tap: (deviceId, x, y) => ipcRenderer.invoke("device:tap", { deviceId, x, y }),
  home: (deviceId) => ipcRenderer.invoke("device:home", { deviceId }),
  back: (deviceId) => ipcRenderer.invoke("device:back", { deviceId }),

  swipe: (deviceId, x1, y1, x2, y2, durationMs) =>
    ipcRenderer.invoke("device:swipe", {
      deviceId,
      x1,
      y1,
      x2,
      y2,
      durationMs,
    }),

  longPress: (deviceId, x, y, durationMs) =>
    ipcRenderer.invoke("device:longPress", { deviceId, x, y, durationMs }),

  streamStart: (deviceId) => ipcRenderer.invoke("stream:start", { deviceId }),
  streamStop: (deviceId) => ipcRenderer.invoke("stream:stop", { deviceId }),
  streamIsRunning: (deviceId) =>
    ipcRenderer.invoke("stream:isRunning", { deviceId }),

  // helper: tìm sourceId window scrcpy theo title
  getWindowSourceIdByTitleContains: async (needle) => {
    const sources = await ipcRenderer.invoke("stream:listWindowSources");

    // ưu tiên match EXACT/startsWith trước để tránh nhầm khi nhiều window
    const n = String(needle || "");
    let hit =
      sources.find((s) => String(s.name || "") === n) ||
      sources.find((s) => String(s.name || "").startsWith(n)) ||
      sources.find((s) => String(s.name || "").includes(n));

    return hit ? hit.id : null;
  },

  onStreamEnded: (cb) => {
    ipcRenderer.on("stream:ended", (_, payload) => cb(payload));
  },
});
