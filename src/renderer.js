// src/renderer.js
function $(id) {
  return document.getElementById(id);
}

function log(msg, isError = false) {
  const el = $("log");
  const t = new Date().toLocaleTimeString();
  el.innerHTML =
    `<div class="${isError ? "err" : ""}">[${t}] ${msg}</div>` + el.innerHTML;
}

function fmtRes(d) {
  if (d?.resolution?.width)
    return `${d.resolution.width}x${d.resolution.height}`;
  return "?";
}

// ===== selection =====
let selectedDeviceId = "";
const devicesById = new Map();

// ===== AutoStart anti-spam =====
const autoStartPending = new Set();

// ===== Layout state (from main) =====
let layoutState = {
  scalePct: 50,
  cols: 4,
  rows: 0,
  margin: 8,
  forceResizeOnApply: true,
  deviceOrder: [],
};

// Drag reorder local working list (device ids in UI order)
let uiOrder = [];

async function pullLayoutFromMain() {
  try {
    const cfg = await window.forgeAPI.getLayout();
    if (!cfg) return;

    layoutState = { ...layoutState, ...cfg };

    $("scaleSel").value = String(layoutState.scalePct ?? 50);
    $("gridCols").value = String(layoutState.cols ?? 4);
    $("gridRows").value = String(layoutState.rows ?? 0);
    $("gridMargin").value = String(layoutState.margin ?? 8);
    $("forceResizeChk").checked = !!layoutState.forceResizeOnApply;

    if (Array.isArray(layoutState.deviceOrder)) {
      uiOrder = [...layoutState.deviceOrder];
    }
  } catch {}
}

function readLayoutFromUI() {
  const scalePct = Number($("scaleSel").value || 50);
  const cols = Number($("gridCols").value || 4);
  const rows = Number($("gridRows").value || 0);
  const margin = Number($("gridMargin").value || 8);
  const forceResizeOnApply = !!$("forceResizeChk").checked;
  return { scalePct, cols, rows, margin, forceResizeOnApply };
}

async function pushLayoutToMain(extra = {}) {
  const patch = { ...readLayoutFromUI(), ...extra };
  try {
    const cfg = await window.forgeAPI.setLayout(patch);
    if (cfg) layoutState = { ...layoutState, ...cfg };
  } catch {}
}

function ensureInUiOrder(devices) {
  const existing = new Set(uiOrder);
  for (const d of devices) {
    if (!existing.has(d.deviceId)) uiOrder.push(d.deviceId);
  }
  // also remove ids that are gone (optional)
  const alive = new Set(devices.map((d) => d.deviceId));
  uiOrder = uiOrder.filter((id) => alive.has(id));
}

function sortDevicesForRender(devices) {
  const idx = new Map();
  uiOrder.forEach((id, i) => idx.set(id, i));
  return [...devices].sort((a, b) => {
    const ia = idx.has(a.deviceId) ? idx.get(a.deviceId) : 1e9;
    const ib = idx.has(b.deviceId) ? idx.get(b.deviceId) : 1e9;
    if (ia !== ib) return ia - ib;
    return String(a.deviceId).localeCompare(String(b.deviceId));
  });
}

let dragSrcId = "";

function renderDevices(devices) {
  const wrap = $("devices");
  wrap.innerHTML = "";

  if (!devices.length) {
    wrap.innerHTML = `<div class="muted">(Không thấy thiết bị — kiểm tra adb devices -l)</div>`;
    return;
  }

  const list = sortDevicesForRender(devices);

  for (const d of list) {
    const div = document.createElement("div");
    div.className =
      "deviceItem" + (d.deviceId === selectedDeviceId ? " selected" : "");
    div.dataset.deviceId = d.deviceId;
    div.draggable = true;

    const badgeClass = d.agentReady ? "badge ok" : "badge bad";
    const badgeText = d.agentReady ? "READY" : "AGENT OFF";

    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
        <div style="min-width:0;">
          <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${d.model || d.deviceId}
          </div>
          <div class="kv muted mono" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${d.deviceId}
          </div>
          <div class="kv muted">
            Android ${d.androidVersion || "?"} • ${fmtRes(d)} • ${d.state}
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
          <span class="${badgeClass}">${badgeText}</span>
        </div>
      </div>
    `;

    div.addEventListener("click", () => {
      selectedDeviceId = d.deviceId;
      refreshUI();
    });

    // drag & drop reorder
    div.addEventListener("dragstart", (e) => {
      dragSrcId = d.deviceId;
      div.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", d.deviceId);
      } catch {}
    });

    div.addEventListener("dragend", () => {
      div.classList.remove("dragging");
      dragSrcId = "";
      // clear hints
      for (const el of wrap.querySelectorAll(".deviceItem.dropHint")) {
        el.classList.remove("dropHint");
      }
    });

    div.addEventListener("dragover", (e) => {
      e.preventDefault();
      div.classList.add("dropHint");
      e.dataTransfer.dropEffect = "move";
    });

    div.addEventListener("dragleave", () => {
      div.classList.remove("dropHint");
    });

    div.addEventListener("drop", async (e) => {
      e.preventDefault();
      div.classList.remove("dropHint");

      const targetId = d.deviceId;
      const srcId =
        dragSrcId ||
        (() => {
          try {
            return e.dataTransfer.getData("text/plain");
          } catch {
            return "";
          }
        })();

      if (!srcId || srcId === targetId) return;

      const from = uiOrder.indexOf(srcId);
      const to = uiOrder.indexOf(targetId);
      if (from < 0 || to < 0) return;

      uiOrder.splice(from, 1);
      uiOrder.splice(to, 0, srcId);

      await pushLayoutToMain({ deviceOrder: uiOrder });
      refreshUI();
    });

    wrap.appendChild(div);
  }
}

async function updateSelectedInfo() {
  if (!selectedDeviceId) {
    $("selectedInfo").textContent = "(chọn thiết bị bên trái)";
    $("runningBadge").textContent = "RUNNING: ?";
    return;
  }

  const d = devicesById.get(selectedDeviceId);
  if (!d) return;

  $("selectedInfo").innerHTML = `
    <div><b>${d.model || selectedDeviceId}</b></div>
    <div class="muted mono">${selectedDeviceId}</div>
    <div class="muted">State: ${d.state} • Android ${d.androidVersion || "?"} • Res: ${fmtRes(d)}</div>
  `;

  try {
    const running = await window.forgeAPI.scrcpyIsRunning(selectedDeviceId);
    const badge = $("runningBadge");
    badge.textContent = `RUNNING: ${running ? "YES" : "NO"}`;
    badge.className = "badge " + (running ? "ok" : "bad");
  } catch {}
}

// ===== Hybrid parse =====
function parseHybrid(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("Empty coordinate");

  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1).trim());
    if (!Number.isFinite(n)) throw new Error(`Invalid percent: ${s}`);
    return { value: n, unit: "pct" };
  }

  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${s}`);

  if (n >= 0 && n <= 1) return { value: n, unit: "pct" };
  return { value: n, unit: "px" };
}

function mustSelected() {
  if (!selectedDeviceId) throw new Error("Chưa chọn thiết bị");
  const d = devicesById.get(selectedDeviceId);
  if (!d) throw new Error("Thiết bị không tồn tại");
  if (d.state !== "ONLINE")
    throw new Error(`Thiết bị không ONLINE (${d.state})`);
  return selectedDeviceId;
}

async function act(name, fn) {
  try {
    await fn();
    log(name);
    refreshUI();
  } catch (e) {
    log(`${name} failed: ${e.message}`, true);
  }
}

// ===== Layout controls =====
["scaleSel", "gridCols", "gridRows", "gridMargin", "forceResizeChk"].forEach(
  (id) => {
    $(id).addEventListener("change", () =>
      pushLayoutToMain({ deviceOrder: uiOrder })
    );
    $(id).addEventListener("input", () =>
      pushLayoutToMain({ deviceOrder: uiOrder })
    );
  }
);

$("applyLayoutBtn").addEventListener("click", () =>
  act("apply layout", async () => {
    await pushLayoutToMain({ deviceOrder: uiOrder });
    const forceResize = !!$("forceResizeChk").checked;
    const r = await window.forgeAPI.scrcpyApplyLayout({ forceResize });
    log(
      `Apply layout: ${r?.count ?? "?"} windows (forceResize=${r?.forceResize ?? forceResize})`
    );
  })
);

$("startAllBtn").addEventListener("click", async () => {
  try {
    await pushLayoutToMain({ deviceOrder: uiOrder });
    const ids = await window.forgeAPI.scrcpyStartAll();
    log(`StartAll: ${ids.length} devices`);
  } catch (e) {
    log(e.message, true);
  }
});

$("stopAllBtn").addEventListener("click", async () => {
  try {
    await window.forgeAPI.scrcpyStopAll();
    autoStartPending.clear();
    log("StopAll done");
  } catch (e) {
    log(e.message, true);
  }
});

$("startBtn").addEventListener("click", () =>
  act("scrcpy start", async () => {
    await pushLayoutToMain({ deviceOrder: uiOrder });
    const id = mustSelected();
    await window.forgeAPI.scrcpyStart(id);
  })
);

$("stopBtn").addEventListener("click", () =>
  act("scrcpy stop", async () => {
    const id = mustSelected();
    await window.forgeAPI.scrcpyStop(id);
    autoStartPending.delete(id);
  })
);

$("wakeBtn").addEventListener("click", () =>
  act("wake", async () => {
    const id = mustSelected();
    await window.forgeAPI.wake(id);
  })
);

$("homeBtn").addEventListener("click", () =>
  act("home", async () => {
    const id = mustSelected();
    await window.forgeAPI.home(id);
  })
);

$("backBtn").addEventListener("click", () =>
  act("back", async () => {
    const id = mustSelected();
    await window.forgeAPI.back(id);
  })
);

$("recentsBtn").addEventListener("click", () =>
  act("recents", async () => {
    const id = mustSelected();
    await window.forgeAPI.recents(id);
  })
);

$("swipeUpBtn").addEventListener("click", () =>
  act("swipe up", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "up");
  })
);

$("swipeDownBtn").addEventListener("click", () =>
  act("swipe down", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "down");
  })
);

$("swipeLeftBtn").addEventListener("click", () =>
  act("swipe left", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "left");
  })
);

$("swipeRightBtn").addEventListener("click", () =>
  act("swipe right", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "right");
  })
);

$("tapBtn").addEventListener("click", () =>
  act("tap", async () => {
    const id = mustSelected();
    const x = parseHybrid($("tapX").value);
    const y = parseHybrid($("tapY").value);
    await window.forgeAPI.tapRaw(id, x, y);
  })
);

$("swipeBtn").addEventListener("click", () =>
  act("swipe raw", async () => {
    const id = mustSelected();
    const x1 = parseHybrid($("swX1").value);
    const y1 = parseHybrid($("swY1").value);
    const x2 = parseHybrid($("swX2").value);
    const y2 = parseHybrid($("swY2").value);
    const dur = Number($("swDur").value || 220);
    await window.forgeAPI.swipeRaw(id, x1, y1, x2, y2, dur);
  })
);

// ===== refresh loop =====
async function refreshUI() {
  const devices = await window.forgeAPI.listDevices();

  devicesById.clear();
  for (const d of devices) devicesById.set(d.deviceId, d);

  ensureInUiOrder(devices);

  if (!selectedDeviceId) {
    const firstOnline = devices.find((d) => d.state === "ONLINE");
    if (firstOnline) selectedDeviceId = firstOnline.deviceId;
  }

  renderDevices(devices);

  // AutoStart no spam
  if ($("autoStartChk").checked) {
    for (const d of devices) {
      if (d.state !== "ONLINE") continue;
      if (autoStartPending.has(d.deviceId)) continue;

      try {
        const running = await window.forgeAPI.scrcpyIsRunning(d.deviceId);
        if (!running) {
          autoStartPending.add(d.deviceId);
          await pushLayoutToMain({ deviceOrder: uiOrder });
          await window.forgeAPI.scrcpyStart(d.deviceId);
        }
      } catch {
        // ignore
      } finally {
        setTimeout(() => autoStartPending.delete(d.deviceId), 1200);
      }
    }
  }

  await updateSelectedInfo();
}

window.forgeAPI.onScrcpyClosed(({ deviceId, code, signal }) => {
  autoStartPending.delete(deviceId);
  log(
    `scrcpy closed: ${deviceId} (code=${code ?? "?"}, signal=${signal ?? "?"})`,
    true
  );
  refreshUI();
});

(async function boot() {
  log(
    "Control Panel loaded. scrcpy windows are direct (no Electron streaming)."
  );
  await pullLayoutFromMain();
  await refreshUI();
  setInterval(refreshUI, 1500);
})();
