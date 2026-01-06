function $(id) {
  return document.getElementById(id);
}

function log(msg, isError = false) {
  const el = $("log");
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.innerHTML =
    `<div class="${isError ? "err" : ""}">[${t}] ${msg}</div>` + el.innerHTML;
}

function formatDevice(d) {
  const model = d.model ? d.model : "(unknown model)";
  const ver = d.androidVersion ? d.androidVersion : "(unknown ver)";
  const res =
    d.resolution && d.resolution.width && d.resolution.height
      ? `${d.resolution.width}x${d.resolution.height}`
      : "(unknown res)";
  const agent = d.agentReady ? "AGENT:READY" : "AGENT:OFF";
  return `${d.deviceId} — ${d.state} — ${model} — Android ${ver} — ${res} — ${agent}`;
}

async function refreshDevices() {
  const listEl = $("devices");
  const selEl = $("deviceSelect");

  try {
    const devices = await window.forgeAPI.listDevices();

    if (!devices.length) {
      listEl.innerHTML =
        "<li>(Không thấy thiết bị — kiểm tra <code>adb devices -l</code>)</li>";
    } else {
      listEl.innerHTML = devices
        .map((d) => `<li>${formatDevice(d)}</li>`)
        .join("");
    }

    const online = devices.filter((d) => d.state === "ONLINE");
    const current = selEl.value;

    selEl.innerHTML = online
      .map((d) => {
        const label = d.model
          ? `${d.model} (${d.deviceId.slice(0, 8)}…)`
          : d.deviceId;
        return `<option value="${d.deviceId}">${label}</option>`;
      })
      .join("");

    if (current && online.some((d) => d.deviceId === current))
      selEl.value = current;

    if (!online.length) {
      selEl.innerHTML = `<option value="">(Không có thiết bị ONLINE)</option>`;
    }
  } catch (e) {
    listEl.innerHTML = `<li class="err">Lỗi: ${e.message}</li>`;
  }
}

function getSelectedDeviceId() {
  const id = $("deviceSelect").value;
  if (!id) throw new Error("Chưa có thiết bị ONLINE để điều khiển");
  return id;
}

async function ensureAgent(deviceId) {
  await window.forgeAPI.agentPing(deviceId);
}

async function getSelectedDeviceSnapshot(deviceId) {
  const devices = await window.forgeAPI.listDevices();
  return devices.find((x) => x.deviceId === deviceId) || null;
}

function mustHaveResolution(d) {
  if (!d || !d.resolution)
    throw new Error("Chưa có resolution (đợi 1-2s rồi thử lại)");
  return d.resolution;
}

// ====== Core1 buttons ======
async function tapCenter() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);

  const d = await getSelectedDeviceSnapshot(deviceId);
  const res = mustHaveResolution(d);

  const x = Math.floor(res.width / 2);
  const y = Math.floor(res.height / 2);

  await window.forgeAPI.tap(deviceId, x, y);
  log(`Tap center on ${deviceId} at ${x},${y}`);
}

async function longPressCenter() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);

  const d = await getSelectedDeviceSnapshot(deviceId);
  const res = mustHaveResolution(d);

  const x = Math.floor(res.width / 2);
  const y = Math.floor(res.height / 2);

  await window.forgeAPI.longPress(deviceId, x, y, 700);
  log(`Long press center on ${deviceId} at ${x},${y}`);
}

async function swipeUp() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);

  const d = await getSelectedDeviceSnapshot(deviceId);
  const res = mustHaveResolution(d);

  const x = Math.floor(res.width / 2);
  const y1 = Math.floor(res.height * 0.7);
  const y2 = Math.floor(res.height * 0.3);

  await window.forgeAPI.swipe(deviceId, x, y1, x, y2, 240);
  log(`Swipe UP on ${deviceId} from ${x},${y1} to ${x},${y2}`);
}

async function swipeDown() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);

  const d = await getSelectedDeviceSnapshot(deviceId);
  const res = mustHaveResolution(d);

  const x = Math.floor(res.width / 2);
  const y1 = Math.floor(res.height * 0.3);
  const y2 = Math.floor(res.height * 0.7);

  await window.forgeAPI.swipe(deviceId, x, y1, x, y2, 240);
  log(`Swipe DOWN on ${deviceId} from ${x},${y1} to ${x},${y2}`);
}

function parseIntStrict(v) {
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

async function tapXY() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);

  const d = await getSelectedDeviceSnapshot(deviceId);
  const res = mustHaveResolution(d);

  const x = parseIntStrict($("xInput").value);
  const y = parseIntStrict($("yInput").value);

  if (x === null || y === null) throw new Error("Nhập X/Y hợp lệ (số)");
  if (x < 0 || y < 0 || x >= res.width || y >= res.height) {
    throw new Error(
      `X/Y ngoài màn hình. Resolution=${res.width}x${res.height}`
    );
  }

  await window.forgeAPI.tap(deviceId, x, y);
  log(`Tap X,Y on ${deviceId} at ${x},${y}`);
}

async function back() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);
  await window.forgeAPI.back(deviceId);
  log(`Back on ${deviceId}`);
}

async function home() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);
  await window.forgeAPI.home(deviceId);
  log(`Home on ${deviceId}`);
}

// ====== Core2: stream + canvas interaction ======
const canvas = $("screenCanvas");
const ctx2d = canvas.getContext("2d");

let ws = null;
let streamingDeviceId = null;
let lastFrameBitmap = null;

// để mapping: cần resolution thật của device
let deviceRes = null;

function fitCanvasToAspect(res) {
  // giữ size canvas vừa phải (UI), nhưng aspect theo device
  const maxW = 360;
  const aspect = res.height / res.width;
  canvas.width = maxW;
  canvas.height = Math.floor(maxW * aspect);
}

function drawFrameFromBlob(blob) {
  // decode JPEG frame -> vẽ canvas
  createImageBitmap(blob)
    .then((bmp) => {
      if (lastFrameBitmap) lastFrameBitmap.close?.();
      lastFrameBitmap = bmp;
      ctx2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    })
    .catch(() => {});
}

async function streamStart() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);

  const snap = await getSelectedDeviceSnapshot(deviceId);
  deviceRes = mustHaveResolution(snap);
  fitCanvasToAspect(deviceRes);

  const { url } = await window.forgeAPI.streamStart(deviceId);

  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  streamingDeviceId = deviceId;

  ws.onopen = () => log(`Stream started for ${deviceId}`);
  ws.onerror = () => log(`Stream WS error`, true);
  ws.onclose = () => log(`Stream closed for ${deviceId}`, true);

  ws.onmessage = (ev) => {
    const buf = ev.data; // ArrayBuffer
    const blob = new Blob([buf], { type: "image/jpeg" });
    drawFrameFromBlob(blob);
  };
}

async function streamStop() {
  const deviceId = streamingDeviceId || getSelectedDeviceId();
  try {
    await window.forgeAPI.streamStop(deviceId);
  } catch {}

  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  streamingDeviceId = null;
  log(`Stream stopped`);
}

function canvasToDeviceXY(ev) {
  if (!deviceRes) throw new Error("Chưa có device resolution");
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;

  const rx = x / rect.width;
  const ry = y / rect.height;

  const dx = Math.max(
    0,
    Math.min(deviceRes.width - 1, Math.round(rx * deviceRes.width))
  );
  const dy = Math.max(
    0,
    Math.min(deviceRes.height - 1, Math.round(ry * deviceRes.height))
  );
  return { x: dx, y: dy };
}

// drag -> swipe
let dragging = false;
let dragStart = null;

function wireCanvasInteraction() {
  canvas.addEventListener("mousedown", (ev) => {
    dragging = true;
    dragStart = canvasToDeviceXY(ev);
  });

  window.addEventListener("mouseup", async (ev) => {
    if (!dragging) return;
    dragging = false;

    try {
      const deviceId = getSelectedDeviceId();
      await ensureAgent(deviceId);

      const end = canvasToDeviceXY(ev);

      const dx = Math.abs(end.x - dragStart.x);
      const dy = Math.abs(end.y - dragStart.y);

      // nếu kéo rất ngắn -> coi như tap
      if (dx < 10 && dy < 10) {
        await window.forgeAPI.tap(deviceId, dragStart.x, dragStart.y);
        log(`Canvas tap ${dragStart.x},${dragStart.y}`);
        return;
      }

      await window.forgeAPI.swipe(
        deviceId,
        dragStart.x,
        dragStart.y,
        end.x,
        end.y,
        220
      );
      log(`Canvas swipe ${dragStart.x},${dragStart.y} -> ${end.x},${end.y}`);
    } catch (e) {
      log(e.message, true);
    } finally {
      dragStart = null;
    }
  });

  // click trực tiếp (fallback nếu không drag)
  canvas.addEventListener("dblclick", async (ev) => {
    try {
      const deviceId = getSelectedDeviceId();
      await ensureAgent(deviceId);
      const p = canvasToDeviceXY(ev);
      await window.forgeAPI.tap(deviceId, p.x, p.y);
      log(`Canvas dblclick tap ${p.x},${p.y}`);
    } catch (e) {
      log(e.message, true);
    }
  });
}

function wireUI() {
  $("tapCenterBtn").addEventListener("click", async () => {
    try {
      await tapCenter();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("longPressCenterBtn").addEventListener("click", async () => {
    try {
      await longPressCenter();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("swipeUpBtn").addEventListener("click", async () => {
    try {
      await swipeUp();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("swipeDownBtn").addEventListener("click", async () => {
    try {
      await swipeDown();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("tapXYBtn").addEventListener("click", async () => {
    try {
      await tapXY();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("backBtn").addEventListener("click", async () => {
    try {
      await back();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("homeBtn").addEventListener("click", async () => {
    try {
      await home();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("yInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") $("tapXYBtn").click();
  });

  $("streamStartBtn").addEventListener("click", async () => {
    try {
      await streamStart();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("streamStopBtn").addEventListener("click", async () => {
    try {
      await streamStop();
    } catch (e) {
      log(e.message, true);
    }
  });
}

wireUI();
wireCanvasInteraction();
refreshDevices();
setInterval(refreshDevices, 1500);
