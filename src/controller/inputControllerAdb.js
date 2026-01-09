// src/controller/inputControllerAdb.js
const { runAdb } = require("./adb");

// (Optional) Agent socket client (để TEXT Unicode).
// Nếu project bạn có src/controller/socketClient.js thì sẽ dùng được.
// Nếu không có hoặc API khác tên, code vẫn chạy bằng fallback ADB.
let socketClient = null;
try {
  // eslint-disable-next-line import/no-unresolved
  socketClient = require("./socketClient");
} catch {
  socketClient = null;
}

// KeyEvent codes: https://developer.android.com/reference/android/view/KeyEvent
const KEY = {
  HOME: 3,
  BACK: 4,
  APP_SWITCH: 187,
  POWER: 26,
  WAKEUP: 224,

  ENTER: 66,
  DPAD_CENTER: 23,
  DEL: 67,
  TAB: 61,
  ESCAPE: 111,
};

function hasNonAscii(str) {
  // unicode (Tiếng Việt, emoji...) -> true
  return /[^\x00-\x7F]/.test(String(str || ""));
}

function escapeAdbInputText(s) {
  // adb shell input text:
  // - khoảng trắng: thay bằng %s
  // - escape vài ký tự dễ gây lỗi trong shell
  // Lưu ý: cái này KHÔNG đảm bảo Unicode.
  return String(s ?? "")
    .replace(/%/g, "%25")
    .replace(/ /g, "%s")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/&/g, "\\&")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\|/g, "\\|")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "%n");
}

async function tap(deviceId, x, y) {
  await runAdb(
    ["-s", deviceId, "shell", "input", "tap", String(x), String(y)],
    8000
  );
  return true;
}

async function swipe(deviceId, x1, y1, x2, y2, durationMs = 220) {
  await runAdb(
    [
      "-s",
      deviceId,
      "shell",
      "input",
      "swipe",
      String(x1),
      String(y1),
      String(x2),
      String(y2),
      String(Math.max(1, Number(durationMs) || 220)),
    ],
    8000
  );
  return true;
}

async function longPress(deviceId, x, y, durationMs = 600) {
  // long press = swipe same point with duration
  return swipe(deviceId, x, y, x, y, durationMs);
}

async function keyevent(deviceId, keyCodeOrName) {
  // adb input keyevent hỗ trợ:
  // - số (66)
  // - tên (KEYCODE_ENTER)
  await runAdb(
    ["-s", deviceId, "shell", "input", "keyevent", String(keyCodeOrName)],
    8000
  );
  return true;
}

async function home(deviceId) {
  return keyevent(deviceId, KEY.HOME);
}

async function back(deviceId) {
  return keyevent(deviceId, KEY.BACK);
}

async function recents(deviceId) {
  return keyevent(deviceId, KEY.APP_SWITCH);
}

async function power(deviceId) {
  return keyevent(deviceId, KEY.POWER);
}

async function wake(deviceId) {
  // Most reliable: try WAKEUP then fallback to POWER toggle
  try {
    await keyevent(deviceId, KEY.WAKEUP);
    return true;
  } catch {
    await power(deviceId);
    return true;
  }
}

/**
 * key(deviceId, keyName)
 * keyName: "ENTER" | "HOME" | "BACK" | "RECENTS" | "DEL" | ...
 */
async function key(deviceId, keyName) {
  const k = String(keyName || "").toUpperCase();

  if (k === "HOME") return home(deviceId);
  if (k === "BACK") return back(deviceId);
  if (k === "RECENTS") return recents(deviceId);
  if (k === "POWER") return power(deviceId);
  if (k === "WAKE" || k === "WAKEUP") return wake(deviceId);

  if (k === "ENTER") return keyevent(deviceId, KEY.ENTER);
  if (k === "DEL" || k === "BACKSPACE") return keyevent(deviceId, KEY.DEL);
  if (k === "TAB") return keyevent(deviceId, KEY.TAB);
  if (k === "ESC" || k === "ESCAPE") return keyevent(deviceId, KEY.ESCAPE);

  // support raw android keycode name
  // e.g. KEYCODE_ENTER
  if (k.startsWith("KEYCODE_")) return keyevent(deviceId, k);

  // support numeric
  const n = Number(k);
  if (Number.isFinite(n)) return keyevent(deviceId, Math.round(n));

  throw new Error("Unknown key: " + keyName);
}

/**
 * text(deviceId, text)
 * Ưu tiên Agent (Unicode), fallback ADB (ASCII).
 *
 * Return:
 *  - true (ok)
 *  - "ERR ..." string (để macroRunner bắt và retry/fail rõ ràng)
 */
async function text(deviceId, textValue) {
  const text = String(textValue ?? "");

  // 1) Try Agent first (Unicode safe)
  // Bạn đã có log "ERR no_focus" từ socketClient => agent có khả năng đang tồn tại.
  // Vì không biết chính xác API export của socketClient, mình thử nhiều kiểu phổ biến.
  if (socketClient) {
    try {
      const payload = { type: "TEXT", text };

      // Pattern A: socketClient.send(deviceId, payload)
      if (typeof socketClient.send === "function") {
        const r = await socketClient.send(deviceId, payload);
        return r ?? true;
      }

      // Pattern B: socketClient.request(deviceId, payload)
      if (typeof socketClient.request === "function") {
        const r = await socketClient.request(deviceId, payload);
        return r ?? true;
      }

      // Pattern C: socketClient.sendToDevice(deviceId, payload)
      if (typeof socketClient.sendToDevice === "function") {
        const r = await socketClient.sendToDevice(deviceId, payload);
        return r ?? true;
      }

      // Pattern D: socketClient.sendCommand({ deviceId, ...payload })
      if (typeof socketClient.sendCommand === "function") {
        const r = await socketClient.sendCommand({ deviceId, ...payload });
        return r ?? true;
      }

      // Pattern E: socketClient.exec(deviceId, "TEXT", {text})
      if (typeof socketClient.exec === "function") {
        const r = await socketClient.exec(deviceId, "TEXT", { text });
        return r ?? true;
      }
    } catch (e) {
      // Nếu agent trả ERR no_focus / not_editable... -> cho macroRunner xử lý
      const msg = String(e?.message || e);
      return "ERR " + msg;
    }
  }

  // 2) Fallback ADB: chỉ đáng tin nếu ASCII
  if (hasNonAscii(text)) {
    return "ERR unicode_not_supported_without_agent";
  }

  try {
    const escaped = escapeAdbInputText(text);
    await runAdb(["-s", deviceId, "shell", "input", "text", escaped], 12000);
    return true;
  } catch (e) {
    return "ERR " + String(e?.message || e);
  }
}

module.exports = {
  tap,
  swipe,
  longPress,
  keyevent,
  key,
  text,
  home,
  back,
  recents,
  power,
  wake,
};
