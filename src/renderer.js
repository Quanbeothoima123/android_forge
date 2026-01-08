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

// ===== FIX: prevent autostart spamming =====
const autoStartPending = new Set(); // deviceId

function renderDevices(devices) {
  const wrap = $("devices");
  wrap.innerHTML = "";

  if (!devices.length) {
    wrap.innerHTML = `<div class="muted">(Không thấy thiết bị — kiểm tra adb devices -l)</div>`;
    return;
  }

  for (const d of devices) {
    const div = document.createElement("div");
    div.className =
      "deviceItem" + (d.deviceId === selectedDeviceId ? " selected" : "");
    div.dataset.deviceId = d.deviceId;

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
  } catch {
    // ignore
  }
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

$("startAllBtn").addEventListener("click", async () => {
  try {
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

  if (!selectedDeviceId) {
    const firstOnline = devices.find((d) => d.state === "ONLINE");
    if (firstOnline) selectedDeviceId = firstOnline.deviceId;
  }

  renderDevices(devices);

  // ✅ FIX: AutoStart no spam, no duplicate starts
  if ($("autoStartChk").checked) {
    for (const d of devices) {
      if (d.state !== "ONLINE") continue;

      // if start already in flight, skip
      if (autoStartPending.has(d.deviceId)) continue;

      try {
        const running = await window.forgeAPI.scrcpyIsRunning(d.deviceId);
        if (!running) {
          autoStartPending.add(d.deviceId);
          await window.forgeAPI.scrcpyStart(d.deviceId);
        }
      } catch {
        // ignore
      } finally {
        // release pending shortly; if start fails it can retry next loop
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
  await refreshUI();
  setInterval(refreshUI, 1500);
})();
