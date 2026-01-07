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

// ===== Core1 buttons =====
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

async function backBtn() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);
  await window.forgeAPI.back(deviceId);
  log(`Back on ${deviceId}`);
}

async function homeBtn() {
  const deviceId = getSelectedDeviceId();
  await ensureAgent(deviceId);
  await window.forgeAPI.home(deviceId);
  log(`Home on ${deviceId}`);
}

// ===== STREAM via desktop capture =====
let currentCaptureStream = null;
let streamingDeviceId = null;
let deviceRes = null;

function showOverlay(text) {
  $("overlayText").innerText = text;
  $("overlay").style.display = "flex";
}

function hideOverlay() {
  $("overlay").style.display = "none";
}

async function waitForWindowSourceId(deviceId, timeoutMs = 10000) {
  const needle = `forge:${deviceId}`;
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    const id = await window.forgeAPI.getWindowSourceIdByTitleContains(needle);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function attachCaptureToVideo(sourceId) {
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

  // cleanup old
  if (currentCaptureStream) {
    try {
      currentCaptureStream.getTracks().forEach((t) => t.stop());
    } catch {}
    currentCaptureStream = null;
  }

  video.srcObject = stream;
  await video.play();

  // detect end
  const track = stream.getVideoTracks()[0];
  if (track) {
    track.onended = () => {
      log("Capture ended (window closed/minimized)", true);
      showOverlay("Stream ended (cửa sổ scrcpy bị đóng hoặc capture bị dừng).");
    };
  }

  currentCaptureStream = stream;
  return true;
}

async function startStream() {
  const deviceId = getSelectedDeviceId();
  streamingDeviceId = deviceId;

  hideOverlay();

  await ensureAgent(deviceId);

  const snap = await getSelectedDeviceSnapshot(deviceId);
  deviceRes = mustHaveResolution(snap);

  await window.forgeAPI.streamStart(deviceId);
  log(`Stream start requested for ${deviceId}`);

  const sourceId = await waitForWindowSourceId(deviceId, 12000);
  if (!sourceId) {
    showOverlay(
      `Không tìm thấy cửa sổ scrcpy (forge:${deviceId}). Hãy bấm Start Stream lại.`
    );
    throw new Error(
      `Không tìm thấy window scrcpy với title chứa "forge:${deviceId}"`
    );
  }

  await attachCaptureToVideo(sourceId);
  log(`Captured scrcpy window for ${deviceId}`);
}

async function stopStream() {
  const deviceId = streamingDeviceId || getSelectedDeviceId();

  try {
    await window.forgeAPI.streamStop(deviceId);
  } catch {}

  if (currentCaptureStream) {
    try {
      currentCaptureStream.getTracks().forEach((t) => t.stop());
    } catch {}
    currentCaptureStream = null;
  }

  $("liveVideo").srcObject = null;
  streamingDeviceId = null;

  showOverlay("Stream stopped.");
  log(`Stream stopped`);
}

// ===== mapping click/drag trên video (letterbox aware) =====
function getVideoContentRect(videoEl) {
  const rect = videoEl.getBoundingClientRect();

  const vw = videoEl.videoWidth || 0;
  const vh = videoEl.videoHeight || 0;

  if (!vw || !vh) return null;

  const containerW = rect.width;
  const containerH = rect.height;

  const scale = Math.min(containerW / vw, containerH / vh);
  const drawW = vw * scale;
  const drawH = vh * scale;

  const offsetX = (containerW - drawW) / 2;
  const offsetY = (containerH - drawH) / 2;

  return {
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    width: drawW,
    height: drawH,
    vw,
    vh,
  };
}

function clientToDeviceXY(ev) {
  if (!deviceRes) throw new Error("Chưa có device resolution");
  const video = $("liveVideo");
  const r = getVideoContentRect(video);
  if (!r) throw new Error("Chưa có frame video (đợi 1-2s)");

  const cx = ev.clientX;
  const cy = ev.clientY;

  // nếu click vào vùng letterbox (đen) thì ignore
  if (
    cx < r.left ||
    cx > r.left + r.width ||
    cy < r.top ||
    cy > r.top + r.height
  ) {
    return null;
  }

  const rx = (cx - r.left) / r.width;
  const ry = (cy - r.top) / r.height;

  const dx = Math.max(
    0,
    Math.min(deviceRes.width - 1, Math.round(rx * deviceRes.width))
  );
  const dy = Math.max(
    0,
    Math.min(deviceRes.height - 1, Math.round(ry * deviceRes.height))
  );

  return { x: dx, y: dy, rx, ry };
}

let dragging = false;
let dragStart = null;

function wireLiveInteraction() {
  const video = $("liveVideo");

  video.addEventListener("mousedown", (ev) => {
    const p = clientToDeviceXY(ev);
    if (!p) return;
    dragging = true;
    dragStart = p;
  });

  window.addEventListener("mouseup", async (ev) => {
    if (!dragging) return;
    dragging = false;

    try {
      const deviceId = getSelectedDeviceId();
      await ensureAgent(deviceId);

      const end = clientToDeviceXY(ev);
      if (!end) return;

      const dx = Math.abs(end.x - dragStart.x);
      const dy = Math.abs(end.y - dragStart.y);

      if (dx < 10 && dy < 10) {
        await window.forgeAPI.tap(deviceId, dragStart.x, dragStart.y);
        log(
          `Tap from LiveScreen ${Math.round(dragStart.rx * 100)}%,${Math.round(dragStart.ry * 100)}%`
        );
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
      log(
        `Swipe from LiveScreen ${Math.round(dragStart.rx * 100)}%,${Math.round(dragStart.ry * 100)}% -> ${Math.round(end.rx * 100)}%,${Math.round(end.ry * 100)}%`
      );
    } catch (e) {
      log(e.message, true);
    } finally {
      dragStart = null;
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
      await backBtn();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("homeBtn").addEventListener("click", async () => {
    try {
      await homeBtn();
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
      showOverlay(e.message);
    }
  });

  $("stopStreamBtn").addEventListener("click", async () => {
    try {
      await stopStream();
    } catch (e) {
      log(e.message, true);
    }
  });

  $("overlayStartBtn").addEventListener("click", async () => {
    try {
      await startStream();
    } catch (e) {
      log(e.message, true);
      showOverlay(e.message);
    }
  });

  // scrcpy closed -> show overlay
  window.forgeAPI.onStreamEnded(({ deviceId }) => {
    if (streamingDeviceId && deviceId === streamingDeviceId) {
      log(`scrcpy closed for ${deviceId}`, true);
      showOverlay(
        "Stream ended (scrcpy đã bị đóng). Bấm Start Stream để chạy lại."
      );
    }
  });
}

wireUI();
wireLiveInteraction();
refreshDevices();
setInterval(refreshDevices, 1500);

// startup overlay
showOverlay("Chưa stream. Bấm Start Stream.");
