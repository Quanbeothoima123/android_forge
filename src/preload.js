// src/preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forgeAPI", {
  listDevices: () => ipcRenderer.invoke("devices:list"),

  // layout
  getLayout: () => ipcRenderer.invoke("layout:get"),
  setLayout: (patch) => ipcRenderer.invoke("layout:set", patch),

  // scrcpy
  scrcpyStart: (deviceId) => ipcRenderer.invoke("scrcpy:start", { deviceId }),
  scrcpyStop: (deviceId) => ipcRenderer.invoke("scrcpy:stop", { deviceId }),
  scrcpyIsRunning: (deviceId) =>
    ipcRenderer.invoke("scrcpy:isRunning", { deviceId }),
  scrcpyStartAll: () => ipcRenderer.invoke("scrcpy:startAll"),
  scrcpyStopAll: () => ipcRenderer.invoke("scrcpy:stopAll"),
  scrcpyApplyLayout: (payload) =>
    ipcRenderer.invoke("scrcpy:applyLayout", payload),

  onScrcpyClosed: (cb) => {
    ipcRenderer.on("scrcpy:closed", (_, payload) => cb(payload));
  },

  // controls
  home: (deviceId) => ipcRenderer.invoke("control:home", { deviceId }),
  back: (deviceId) => ipcRenderer.invoke("control:back", { deviceId }),
  recents: (deviceId) => ipcRenderer.invoke("control:recents", { deviceId }),
  wake: (deviceId) => ipcRenderer.invoke("control:wake", { deviceId }),

  tapRaw: (deviceId, x, y) =>
    ipcRenderer.invoke("control:tapRaw", { deviceId, x, y }),

  swipeRaw: (deviceId, x1, y1, x2, y2, durationMs) =>
    ipcRenderer.invoke("control:swipeRaw", {
      deviceId,
      x1,
      y1,
      x2,
      y2,
      durationMs,
    }),

  swipeDir: (deviceId, dir) =>
    ipcRenderer.invoke("control:swipeDir", { deviceId, dir }),

  // ✅ macros
  listMacros: () => ipcRenderer.invoke("macro:list"),
  macroRecordStart: (deviceId) =>
    ipcRenderer.invoke("macro:recordStart", { deviceId }),
  macroRecordStop: () => ipcRenderer.invoke("macro:recordStop"),
  macroRecordAddText: (text) =>
    ipcRenderer.invoke("macro:recordAddText", { text }),
  macroRecordAddKey: (key) => ipcRenderer.invoke("macro:recordAddKey", { key }),
  macroRecordAddWait: (durationMs) =>
    ipcRenderer.invoke("macro:recordAddWait", { durationMs }),
  macroSave: (name, description, steps) =>
    ipcRenderer.invoke("macro:save", { name, description, steps }),
  macroLoad: (id) => ipcRenderer.invoke("macro:load", { id }),
  macroPlay: (deviceId, macroId, options) =>
    ipcRenderer.invoke("macro:play", { deviceId, macroId, options }),
  macroStop: (deviceId) => ipcRenderer.invoke("macro:stop", { deviceId }),

  // ✅ realtime macro state/progress
  onMacroState: (cb) => {
    ipcRenderer.on("macro:state", (_, payload) => cb(payload));
  },
  onMacroProgress: (cb) => {
    ipcRenderer.on("macro:progress", (_, payload) => cb(payload));
  },
});
