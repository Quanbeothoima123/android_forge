// controller/adb.js
const { spawn } = require("child_process");

function runAdb(args, timeoutMs = 8000) {
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
  });
}

module.exports = { runAdb };
