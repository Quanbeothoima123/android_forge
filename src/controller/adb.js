// src/controller/adb.js
const { spawn } = require("child_process");

/**
 * Global ADB concurrency limiter to reduce "adb freeze" when controlling 5-10 devices.
 * - Limits number of simultaneous adb processes.
 * - Keeps per-call timeout.
 */
const MAX_ADB_CONCURRENCY = 4;

let _active = 0;
const _q = [];

function _dequeue() {
  if (_active >= MAX_ADB_CONCURRENCY) return;
  const job = _q.shift();
  if (!job) return;

  _active++;
  job()
    .catch(() => {})
    .finally(() => {
      _active--;
      _dequeue();
    });
}

function _enqueueJob(jobFn) {
  return new Promise((resolve, reject) => {
    _q.push(async () => {
      try {
        const r = await jobFn();
        resolve(r);
      } catch (e) {
        reject(e);
      }
    });
    _dequeue();
  });
}

function runAdb(args, timeoutMs = 8000) {
  return _enqueueJob(() => {
    return new Promise((resolve, reject) => {
      const p = spawn("adb", args, { stdio: ["ignore", "pipe", "pipe"] });

      let out = "";
      let err = "";

      const timer = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {}
        reject(new Error(`adb timeout: adb ${args.join(" ")}`));
      }, timeoutMs);

      p.stdout.on("data", (d) => (out += d.toString("utf8")));
      p.stderr.on("data", (d) => (err += d.toString("utf8")));

      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out.trim());
        reject(new Error(`adb failed (code ${code}): ${err.trim()}`));
      });

      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  });
}

module.exports = { runAdb };
