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

  // CORE 2 stream
  streamStart: (deviceId) => ipcRenderer.invoke("stream:start", { deviceId }),
  streamStop: (deviceId) => ipcRenderer.invoke("stream:stop", { deviceId }),
  streamUrl: (deviceId) => ipcRenderer.invoke("stream:url", { deviceId }),
});
