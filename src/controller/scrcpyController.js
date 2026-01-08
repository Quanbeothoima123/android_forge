// src/controller/scrcpyController.js
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

function toPsEncodedCommand(psScript) {
  // PowerShell -EncodedCommand expects UTF-16LE base64
  return Buffer.from(psScript, "utf16le").toString("base64");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class ScrcpyController extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map(); // deviceId -> { proc, title, port }
    this.pendingStart = new Set(); // deviceId
    this.pendingStop = new Set(); // deviceId
  }

  isRunning(deviceId) {
    const s = this.procs.get(deviceId);
    return !!(s && s.proc && !s.proc.killed);
  }

  async start(deviceId, opts = {}) {
    // prevent duplicate starts (StartAll + AutoStart + manual)
    if (this.isRunning(deviceId)) return true;
    if (this.pendingStart.has(deviceId)) return true;

    this.pendingStart.add(deviceId);

    try {
      const title = `forge:${deviceId}`;

      const maxFps = opts.maxFps ?? 30;
      const bitRate = opts.bitRate ?? "8M";

      const win = opts.window || {};
      // IMPORTANT: borderless=false => allow user resize
      const borderless = win.borderless === true ? true : false;
      const alwaysOnTop = !!win.alwaysOnTop;

      const targetW = Number.isFinite(win.width) ? Number(win.width) : 360;
      const targetH = Number.isFinite(win.height) ? Number(win.height) : 800;

      const corner = win.corner || "top-left";
      const margin = Number.isFinite(win.margin) ? Number(win.margin) : 8;
      const layout = win.layout || null; // { mode:'grid', slotIndex }

      const args = [
        "-s",
        deviceId,
        "--no-audio",
        "--window-title",
        title,
        "--max-fps",
        String(maxFps),
        "--video-bit-rate",
        String(bitRate),
        // DO NOT set --window-width/--window-height => user can resize naturally
      ];

      // ---- FIX: use a single explicit port per device, not a range string
      if (Number.isFinite(opts.port)) args.push("--port", String(opts.port));

      if (borderless) args.push("--window-borderless");
      if (alwaysOnTop) args.push("--always-on-top");

      const proc = spawn("scrcpy", args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: false,
      });

      proc.on("error", (err) => {
        console.error("[scrcpy spawn error]", err);
        this.stop(deviceId).catch(() => {});
      });

      proc.stderr.on("data", (d) => {
        const s = d.toString("utf8").trim();
        if (s) console.log("[scrcpy]", s);
      });

      proc.on("close", (code, signal) => {
        this.procs.delete(deviceId);
        this.emit("closed", { deviceId, code, signal });
      });

      this.procs.set(deviceId, { proc, title, port: opts.port });

      const rules = {
        // used only for grid cell calculation (not forcing actual size)
        width: targetW,
        height: targetH,
        corner,
        margin,
        layoutMode: layout?.mode || "corner",
        slotIndex:
          layout?.mode === "grid" && Number.isFinite(layout?.slotIndex)
            ? Number(layout.slotIndex)
            : 0,
        sendToBottom: !!(opts.zOrder && opts.zOrder.sendToBottom),
        noActivate: !!(opts.zOrder && opts.zOrder.noActivate),
        timeoutMs: Number.isFinite(win.timeoutMs)
          ? Number(win.timeoutMs)
          : 15000,
      };

      // Apply window positioning asynchronously
      this._applyWindowRulesByTitle(title, rules).catch((e) => {
        console.log("[scrcpy window rules] failed:", e.message);
      });

      return true;
    } finally {
      // release quickly; start is fire-and-forget
      this.pendingStart.delete(deviceId);
    }
  }

  async stop(deviceId) {
    if (this.pendingStop.has(deviceId)) return;
    this.pendingStop.add(deviceId);

    try {
      const s = this.procs.get(deviceId);
      if (!s) return;

      this.procs.delete(deviceId);

      // Windows: ensure the whole process tree is killed
      if (process.platform === "win32" && s.proc?.pid) {
        try {
          spawn("taskkill", ["/PID", String(s.proc.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          // give taskkill a moment
          await sleep(80);
        } catch {}
      } else {
        try {
          s.proc.kill("SIGKILL");
        } catch {}
      }
    } finally {
      this.pendingStop.delete(deviceId);
    }
  }

  async stopAll() {
    const ids = Array.from(this.procs.keys());
    for (const id of ids) {
      try {
        await this.stop(id);
      } catch {}
    }
  }

  _applyWindowRulesByTitle(title, rules) {
    const width = Number(rules.width || 360);
    const height = Number(rules.height || 800);
    const margin = Number(rules.margin || 8);
    const corner = String(rules.corner || "top-left");

    const layoutMode = String(rules.layoutMode || "corner"); // 'grid'|'corner'
    const slotIndex = Number.isFinite(rules.slotIndex)
      ? Number(rules.slotIndex)
      : 0;

    const sendToBottom = !!rules.sendToBottom;
    const noActivate = !!rules.noActivate;
    const timeoutMs = Number(rules.timeoutMs || 15000);

    const ps = `
$ProgressPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public static readonly IntPtr HWND_TOP = new IntPtr(0);

  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
}
"@ | Out-Null

function FindWindowContainsTitle($needle) {
  $script:found = [IntPtr]::Zero
  [Win32]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $t = $sb.ToString()
    if ($t -and $t.Contains($needle)) { $script:found = $hWnd; return $false }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  return $script:found
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$needle = ${JSON.stringify(title)}
$w = ${width}
$h = ${height}
$m = ${margin}
$corner = ${JSON.stringify(corner)}
$layoutMode = ${JSON.stringify(layoutMode)}
$slotIndex = ${slotIndex}
$sendToBottom = ${sendToBottom ? "$true" : "$false"}
$noActivate = ${noActivate ? "$true" : "$false"}
$timeoutMs = ${timeoutMs}

$deadline = (Get-Date).AddMilliseconds($timeoutMs)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $hwnd -eq [IntPtr]::Zero) {
  $hwnd = FindWindowContainsTitle $needle
  Start-Sleep -Milliseconds 120
}
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }

# Move only (do not resize) => user can resize freely
$X = $wa.Left + $m
$Y = $wa.Top  + $m

if ($layoutMode -eq "grid") {
  $cols = [Math]::Floor(($wa.Width - $m) / ($w + $m))
  if ($cols -lt 1) { $cols = 1 }

  $col = $slotIndex % $cols
  $row = [Math]::Floor($slotIndex / $cols)

  $X = $wa.Left + $m + ($col * ($w + $m))
  $Y = $wa.Top  + $m + ($row * ($h + $m))

  if ($Y + 220 + $m -gt $wa.Bottom) {
    $Y = [Math]::Max($wa.Top + $m, $wa.Bottom - 240 - $m)
  }
} else {
  if ($corner -eq "top-left") {
    $X = $wa.Left + $m; $Y = $wa.Top + $m
  } elseif ($corner -eq "top-right") {
    $X = $wa.Right - $w - $m; $Y = $wa.Top + $m
  } elseif ($corner -eq "bottom-left") {
    $X = $wa.Left + $m; $Y = $wa.Bottom - $h - $m
  } else {
    $X = $wa.Right - $w - $m; $Y = $wa.Bottom - $h - $m
  }
}

$flagsMoveOnly = [Win32]::SWP_NOSIZE -bor [Win32]::SWP_SHOWWINDOW
if ($noActivate) { $flagsMoveOnly = $flagsMoveOnly -bor [Win32]::SWP_NOACTIVATE }

[void][Win32]::SetWindowPos($hwnd, [Win32]::HWND_TOP, $X, $Y, 0, 0, $flagsMoveOnly)

if ($sendToBottom) {
  $flagsBottom = [Win32]::SWP_NOMOVE -bor [Win32]::SWP_NOSIZE -bor [Win32]::SWP_SHOWWINDOW
  if ($noActivate) { $flagsBottom = $flagsBottom -bor [Win32]::SWP_NOACTIVATE }
  [void][Win32]::SetWindowPos($hwnd, [Win32]::HWND_BOTTOM, 0,0,0,0, $flagsBottom)
}

exit 0
`;

    return new Promise((resolve, reject) => {
      const encoded = toPsEncodedCommand(ps);

      const p = spawn(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encoded,
        ],
        { windowsHide: true }
      );

      p.stderr.on("data", (d) => {
        const s = d.toString("utf8").trim();
        // ignore common CLIXML progress spam
        if (s && !s.includes("CLIXML")) console.log("[ps err]", s);
      });
      p.stdout.on("data", (d) => {
        const s = d.toString("utf8").trim();
        if (s) console.log("[ps out]", s);
      });

      p.on("close", (code) => {
        if (code === 0) return resolve(true);
        reject(new Error(`powershell exited code=${code}`));
      });
      p.on("error", reject);
    });
  }
}

module.exports = { scrcpy: new ScrcpyController() };
