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
  groups: [],
};

// Drag reorder local working list (device ids in UI order)
let uiOrder = [];

// ===== Macro state =====
let recordedSteps = [];
const macroRuntimeByDevice = new Map();

// ===== Groups =====
let groups = [];
let selectedGroupId = "";

function setMacroUiEnabled(enabled) {
  $("macroPlayBtn").disabled = !enabled;
  $("macroRecStartBtn").disabled = !enabled;
  $("macroSaveBtn").disabled = !enabled;
  $("macroStopBtn").disabled = false;
}

function renderMacroStatus(deviceId) {
  const st = macroRuntimeByDevice.get(deviceId);
  const el = $("macroStatus");
  if (!el) return;

  if (!deviceId) {
    el.textContent = "Macro: (no device)";
    setMacroUiEnabled(true);
    return;
  }

  if (!st || !st.running) {
    el.textContent = "Macro: IDLE";
    setMacroUiEnabled(true);
    return;
  }

  const idx = st.stepIndex ?? 0;
  const cnt = st.stepCount ?? "?";
  const type = st.stepType || "";
  el.textContent = `Macro: RUNNING • step ${idx}/${cnt} ${type ? `• ${type}` : ""}`;
  setMacroUiEnabled(false);
}

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

    if (Array.isArray(layoutState.groups)) {
      groups = [...layoutState.groups];
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
      renderMacroStatus(selectedDeviceId);
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
    renderMacroStatus("");
    return;
  }

  const d = devicesById.get(selectedDeviceId);
  if (!d) return;

  $("selectedInfo").innerHTML = `
    <div><b>${d.model || selectedDeviceId}</b></div>
    <div class="muted mono">${selectedDeviceId}</div>
    <div class="muted">State: ${d.state} • Android ${d.androidVersion || "?"} • Res: ${fmtRes(d)} • AgentReady: ${d.agentReady ? "YES" : "NO"}</div>
  `;

  try {
    const running = await window.forgeAPI.scrcpyIsRunning(selectedDeviceId);
    const badge = $("runningBadge");
    badge.textContent = `RUNNING: ${running ? "YES" : "NO"}`;
    badge.className = "badge " + (running ? "ok" : "bad");
  } catch {}

  renderMacroStatus(selectedDeviceId);
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

function mustGroupSelected() {
  const gid = String(selectedGroupId || $("groupSel").value || "").trim();
  if (!gid) throw new Error("Chưa chọn group");
  return gid;
}

function readFanoutOpts() {
  const baseDelayMs = Number($("gbBaseDelay").value || 90);
  const jitterMs = Number($("gbJitter").value || 160);
  const xyJitterPct = Number($("gbXyJitter").value || 0);
  return { baseDelayMs, jitterMs, xyJitterPct };
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

// ===== Groups UI =====
async function reloadGroups() {
  try {
    groups = await window.forgeAPI.groupList();
  } catch {
    groups = [];
  }

  const sel = $("groupSel");
  sel.innerHTML = "";
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.name} (${g.id}) • ${g.devices?.length || 0} devices`;
    sel.appendChild(opt);
  }

  if (!selectedGroupId && groups.length) selectedGroupId = groups[0].id;
  if (selectedGroupId) sel.value = selectedGroupId;

  sel.onchange = () => {
    selectedGroupId = sel.value;
  };
}

$("groupReloadBtn").addEventListener("click", () =>
  act("group reload", reloadGroups)
);

$("groupCreateBtn").addEventListener("click", () =>
  act("group create", async () => {
    const id = String($("groupId").value || "").trim();
    const name = String($("groupName").value || "").trim();
    if (!id) throw new Error("group id required");
    await window.forgeAPI.groupCreate(id, name || id);
    selectedGroupId = id;
    await reloadGroups();
  })
);

$("groupRenameBtn").addEventListener("click", () =>
  act("group rename", async () => {
    const gid = mustGroupSelected();
    const name = String($("groupName").value || "").trim();
    if (!name) throw new Error("group name required");
    await window.forgeAPI.groupRename(gid, name);
    await reloadGroups();
  })
);

$("groupRemoveBtn").addEventListener("click", () =>
  act("group remove", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupRemove(gid);
    selectedGroupId = "";
    await reloadGroups();
  })
);

$("groupAddSelectedBtn").addEventListener("click", () =>
  act("group add selected", async () => {
    const gid = mustGroupSelected();
    const did = mustSelected();
    await window.forgeAPI.groupAddDevice(gid, did);
    await reloadGroups();
  })
);

$("groupRemoveSelectedBtn").addEventListener("click", () =>
  act("group remove selected", async () => {
    const gid = mustGroupSelected();
    const did = mustSelected();
    await window.forgeAPI.groupRemoveDevice(gid, did);
    await reloadGroups();
  })
);

// ===== Group Broadcast buttons =====
$("gbHomeBtn").addEventListener("click", () =>
  act("broadcast HOME", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupKey(gid, "HOME", readFanoutOpts());
  })
);

$("gbBackBtn").addEventListener("click", () =>
  act("broadcast BACK", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupKey(gid, "BACK", readFanoutOpts());
  })
);

$("gbRecentsBtn").addEventListener("click", () =>
  act("broadcast RECENTS", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupKey(gid, "RECENTS", readFanoutOpts());
  })
);

$("gbWakeBtn").addEventListener("click", () =>
  act("broadcast WAKE", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupWake(gid, readFanoutOpts());
  })
);

$("gbScreenOffBtn").addEventListener("click", () =>
  act("broadcast SCREEN OFF", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupScreenOff(gid, readFanoutOpts());
  })
);

$("gbShutdownBtn").addEventListener("click", () =>
  act("broadcast SHUTDOWN", async () => {
    const gid = mustGroupSelected();
    // avoid misclick? vẫn chạy thẳng theo yêu cầu bạn
    await window.forgeAPI.groupShutdown(gid, readFanoutOpts());
  })
);

$("gbSwipeUpBtn").addEventListener("click", () =>
  act("broadcast swipe up", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "up", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

$("gbSwipeDownBtn").addEventListener("click", () =>
  act("broadcast swipe down", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "down", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

$("gbSwipeLeftBtn").addEventListener("click", () =>
  act("broadcast swipe left", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "left", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

$("gbSwipeRightBtn").addEventListener("click", () =>
  act("broadcast swipe right", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "right", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

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

// ===== Single device quick controls =====
$("wakeBtn").addEventListener("click", () =>
  act("wake", async () => {
    const id = mustSelected();
    await window.forgeAPI.wake(id);
  })
);

$("screenOffBtn").addEventListener("click", () =>
  act("screen off", async () => {
    const id = mustSelected();
    await window.forgeAPI.screenOff(id);
  })
);

$("shutdownBtn").addEventListener("click", () =>
  act("shutdown", async () => {
    const id = mustSelected();
    await window.forgeAPI.shutdown(id);
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

// ===== Macro UI =====
async function reloadMacroList() {
  const list = await window.forgeAPI.listMacros();
  const sel = $("macroList");
  sel.innerHTML = "";
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    const name = m.meta?.name || m.id;
    opt.textContent = `${name} (${m.id})`;
    sel.appendChild(opt);
  }
}

$("macroReloadBtn").addEventListener("click", () =>
  act("macro reload", reloadMacroList)
);

$("macroRecStartBtn").addEventListener("click", () =>
  act("macro record start", async () => {
    const id = mustSelected();

    const st = macroRuntimeByDevice.get(id);
    if (st?.running) throw new Error("Macro is running. Stop first.");

    await window.forgeAPI.macroRecordStart(id);
    recordedSteps = [];
    log("Recording started (V2: click/drag trực tiếp trên scrcpy window)");
  })
);

$("macroRecStopBtn").addEventListener("click", () =>
  act("macro record stop", async () => {
    const r = await window.forgeAPI.macroRecordStop();
    recordedSteps = r.steps || [];
    log(`Recording stopped. steps=${recordedSteps.length}`);
  })
);

$("macroAddTextBtn").addEventListener("click", () =>
  act("macro add text", async () => {
    const text = $("macroText").value || "";
    await window.forgeAPI.macroRecordAddText(text);
    log(`TEXT step added: "${text}"`);
  })
);

$("macroAddKeyBtn").addEventListener("click", () =>
  act("macro add key", async () => {
    const key = $("macroKeySel").value;
    await window.forgeAPI.macroRecordAddKey(key);
    log(`KEY step added: ${key}`);
  })
);

$("macroAddWaitBtn").addEventListener("click", () =>
  act("macro add wait", async () => {
    const ms = Number($("macroWaitMs").value || 0);
    await window.forgeAPI.macroRecordAddWait(ms);
    log(`WAIT step added: ${ms}ms`);
  })
);

$("macroSaveBtn").addEventListener("click", () =>
  act("macro save", async () => {
    const name = $("macroName").value || "macro_" + Date.now();
    const desc = $("macroDesc").value || "";
    if (!recordedSteps.length)
      throw new Error("No recorded steps. Stop Record first.");
    await window.forgeAPI.macroSave(name, desc, recordedSteps);
    log(`Saved macro: ${name}`);
    await reloadMacroList();
  })
);

$("macroPlayBtn").addEventListener("click", () =>
  act("macro play", async () => {
    const id = mustSelected();

    const st = macroRuntimeByDevice.get(id);
    if (st?.running)
      throw new Error("Macro is already running on this device.");

    const macroId = $("macroList").value;
    if (!macroId) throw new Error("Select a macro");

    const loop = Number($("macroLoop").value || 1);
    const speed = Number($("macroSpeed").value || 1.0);
    const xyJitterPct = Number($("macroJitterXY").value || 0.0);
    const delayJitterPct = Number($("macroJitterDelay").value || 0.0);

    macroRuntimeByDevice.set(id, {
      running: true,
      macroId,
      stepIndex: 0,
      stepCount: "?",
    });
    renderMacroStatus(id);

    await window.forgeAPI.macroPlay(id, macroId, {
      loop,
      speed,
      xyJitterPct,
      delayJitterPct,
    });

    log(`Play macro ${macroId} on ${id}`);
  })
);

$("macroStopBtn").addEventListener("click", () =>
  act("macro stop", async () => {
    const id = mustSelected();
    await window.forgeAPI.macroStop(id);
    log("Stop requested");
  })
);

// Group Macro
$("groupMacroPlayBtn").addEventListener("click", () =>
  act("group macro play", async () => {
    const gid = mustGroupSelected();
    const macroId = $("macroList").value;
    if (!macroId) throw new Error("Select a macro");

    const loop = Number($("macroLoop").value || 1);
    const speed = Number($("macroSpeed").value || 1.0);
    const xyJitterPct = Number($("macroJitterXY").value || 0.0);
    const delayJitterPct = Number($("macroJitterDelay").value || 0.0);

    const gmBaseDelay = Number($("gmBaseDelay").value || 120);
    const gmJitter = Number($("gmJitter").value || 280);

    const r = await window.forgeAPI.groupMacroPlay(
      gid,
      macroId,
      { loop, speed, xyJitterPct, delayJitterPct },
      { baseDelayMs: gmBaseDelay, jitterMs: gmJitter }
    );

    log(
      `Group macro started: group=${gid} macro=${macroId} started=${r?.started?.length || 0}`
    );
  })
);

$("groupMacroStopGroupBtn").addEventListener("click", () =>
  act("group macro stop group", async () => {
    const gid = mustGroupSelected();
    const r = await window.forgeAPI.groupMacroStopGroup(gid);
    log(`Stop group requested: stopped=${r?.stopped ?? "?"}`);
  })
);

$("groupMacroStopSelectedBtn").addEventListener("click", () =>
  act("group macro stop selected device", async () => {
    const gid = mustGroupSelected();
    const did = mustSelected();
    const r = await window.forgeAPI.groupMacroStopDevice(gid, did);
    log(`Stop device requested: ${did} stopped=${r?.stopped ? "YES" : "NO"}`);
  })
);

// macro state/progress events
window.forgeAPI.onMacroState((p) => {
  const { deviceId, running, macroId } = p || {};
  if (!deviceId) return;
  const cur = macroRuntimeByDevice.get(deviceId) || {};
  macroRuntimeByDevice.set(deviceId, {
    ...cur,
    running: !!running,
    macroId: macroId || cur.macroId || "",
    stepIndex: running ? (cur.stepIndex ?? 0) : 0,
    stepCount: running ? (cur.stepCount ?? "?") : 0,
    stepType: running ? (cur.stepType ?? "") : "",
  });

  if (deviceId === selectedDeviceId) renderMacroStatus(deviceId);
});

window.forgeAPI.onMacroProgress((p) => {
  const { deviceId, stepIndex, stepCount, stepType } = p || {};
  if (!deviceId) return;
  const cur = macroRuntimeByDevice.get(deviceId) || {};
  macroRuntimeByDevice.set(deviceId, {
    ...cur,
    running: true,
    stepIndex,
    stepCount,
    stepType,
  });

  if (deviceId === selectedDeviceId) renderMacroStatus(deviceId);
});

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
  log("Control Panel loaded. Core 3 macro enabled (V2 hook) + Core 4 groups.");
  await pullLayoutFromMain();
  await reloadGroups();
  await refreshUI();
  await reloadMacroList();
  setInterval(refreshUI, 1500);
})();
