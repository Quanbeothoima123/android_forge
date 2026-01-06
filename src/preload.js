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

  // stream controls
  streamStart: (deviceId) =>
    ipcRenderer.invoke("device:streamStart", { deviceId }),
  streamStop: (deviceId) =>
    ipcRenderer.invoke("device:streamStop", { deviceId }),
  streamIsRunning: (deviceId) =>
    ipcRenderer.invoke("device:streamIsRunning", { deviceId }),

  // helper: tìm sourceId window scrcpy theo title
  getWindowSourceIdByTitleContains: async (needle) => {
    const sources = await ipcRenderer.invoke("stream:listWindowSources");
    const hit = sources.find((s) => (s.name || "").includes(needle));
    return hit ? hit.id : null;
  },
});
