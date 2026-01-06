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

    if (!online.length)
      selEl.innerHTML = `<option value="">(Không có thiết bị ONLINE)</option>`;
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

async function backAction() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);
  await window.forgeAPI.back(deviceId);
  log(`Back on ${deviceId}`);
}

async function homeAction() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);
  await window.forgeAPI.home(deviceId);
  log(`Home on ${deviceId}`);
}

// ===== STREAM (capture scrcpy window) =====
let currentStream = null;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSourceIdByTitleContains(needle, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const id = await window.forgeAPI.getWindowSourceIdByTitleContains(needle);
    if (id) return id;
    await sleep(250);
  }
  throw new Error(`Không tìm thấy window scrcpy với title chứa "${needle}"`);
}

async function attachWindowToVideo(sourceId) {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
      },
    },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = $("liveVideo");
  video.srcObject = stream;
  await video.play();
  return stream;
}

async function startStream() {
  const deviceId = getSelectedDeviceId();

  // start scrcpy GUI (main process)
  await window.forgeAPI.streamStart(deviceId);
  log(`Stream start requested for ${deviceId}`);

  const needle = `forge:${deviceId}`;
  const sourceId = await waitForSourceIdByTitleContains(needle, 12000);

  if (currentStream) {
    try {
      currentStream.getTracks().forEach((t) => t.stop());
    } catch {}
    currentStream = null;
  }

  currentStream = await attachWindowToVideo(sourceId);
  log(`Captured scrcpy window for ${deviceId}`);
}

async function stopStream() {
  const deviceId = getSelectedDeviceId();

  if (currentStream) {
    try {
      currentStream.getTracks().forEach((t) => t.stop());
    } catch {}
    currentStream = null;
  }
  $("liveVideo").srcObject = null;

  await window.forgeAPI.streamStop(deviceId);
  log(`Stream stopped for ${deviceId}`);
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
      await backAction();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("homeBtn").addEventListener("click", async () => {
    try {
      await homeAction();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("yInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") $("tapXYBtn").click();
  });

  $("startStreamBtn").addEventListener("click", async () => {
    try {
      await startStream();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("stopStreamBtn").addEventListener("click", async () => {
    try {
      await stopStream();
    } catch (e) {
      log(e.message, true);
    }
  });
}

wireUI();
refreshDevices();
setInterval(refreshDevices, 1500);
