// src/controller/inputControllerAdb.js
const { runAdb } = require("./adb");

// KeyEvent codes: https://developer.android.com/reference/android/view/KeyEvent
const KEY = {
  HOME: 3,
  BACK: 4,
  APP_SWITCH: 187,
  POWER: 26,
  WAKEUP: 224, // may work on some devices
};

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

async function keyevent(deviceId, keyCode) {
  await runAdb(
    ["-s", deviceId, "shell", "input", "keyevent", String(keyCode)],
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

module.exports = {
  tap,
  swipe,
  longPress,
  keyevent,
  home,
  back,
  recents,
  power,
  wake,
};
