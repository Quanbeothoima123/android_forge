const { spawn } = require("child_process");
const { EventEmitter } = require("events");

class ScrcpyController extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map(); // deviceId -> { proc, title }
  }

  isRunning(deviceId) {
    const s = this.procs.get(deviceId);
    return !!(s && s.proc && !s.proc.killed);
  }

  start(deviceId, opts = {}) {
    if (this.isRunning(deviceId)) return true;

    const title = `forge:${deviceId}`;

    const maxFps = opts.maxFps ?? 30;
    const bitRate = opts.bitRate ?? "8M";

    const win = opts.window || {};
    const borderless = win.borderless !== false;
    const alwaysOnTop = !!win.alwaysOnTop;

    const targetW = Number.isFinite(win.width) ? Number(win.width) : 360;
    const targetH = Number.isFinite(win.height) ? Number(win.height) : 800;

    const corner = win.corner || "top-left"; // NEW default
    const margin = Number.isFinite(win.margin) ? Number(win.margin) : 8;

    const args = [
      "-s",
      deviceId,
      "--no-audio",
      "--no-control",
      "--window-title",
      title,
      "--max-fps",
      String(maxFps),
      "--video-bit-rate",
      String(bitRate),
      "--window-width",
      String(targetW),
      "--window-height",
      String(targetH),
    ];

    if (opts.portRange) {
      args.push("--port", String(opts.portRange));
    }

    if (borderless) args.push("--window-borderless");
    if (alwaysOnTop) args.push("--always-on-top");

    const proc = spawn("scrcpy", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: false, // IMPORTANT: không hide/minimize
    });

    proc.on("error", (err) => {
      console.error("[scrcpy spawn error]", err);
      this.stop(deviceId);
    });

    proc.stderr.on("data", (d) => {
      const s = d.toString("utf8").trim();
      if (s) console.log("[scrcpy]", s);
    });

    proc.on("close", (code, signal) => {
      this.procs.delete(deviceId);
      this.emit("closed", { deviceId, code, signal });
    });

    this.procs.set(deviceId, { proc, title });

    const rules = {
      width: targetW,
      height: targetH,
      corner,
      margin,
      // push scrcpy xuống dưới (Electron che lên) - vẫn "visible" nên không đen
      sendToBottom: !!(opts.zOrder && opts.zOrder.sendToBottom),
      noActivate: !!(opts.zOrder && opts.zOrder.noActivate),
      timeoutMs: Number.isFinite(win.timeoutMs) ? Number(win.timeoutMs) : 12000,
    };

    // IMPORTANT: tuyệt đối không throw ra ngoài
    this._applyWindowRulesByTitle(title, rules).catch((e) => {
      console.log("[scrcpy window rules] failed:", e.message);
    });

    return true;
  }

  stop(deviceId) {
    const s = this.procs.get(deviceId);
    if (!s) return;

    this.procs.delete(deviceId);

    try {
      s.proc.kill("SIGKILL");
    } catch {}
  }

  stopAll() {
    for (const id of Array.from(this.procs.keys())) this.stop(id);
  }

  _escapeForPS(str) {
    // escape double quotes in PS string context
    return String(str).replace(/"/g, '""');
  }

  _applyWindowRulesByTitle(title, rules) {
    const width = Number(rules.width || 360);
    const height = Number(rules.height || 800);
    const margin = Number(rules.margin || 8);
    const corner = String(rules.corner || "top-left");
    const sendToBottom = !!rules.sendToBottom;
    const noActivate = !!rules.noActivate;
    const timeoutMs = Number(rules.timeoutMs || 12000);

    const titlePS = this._escapeForPS(title);
    const cornerPS = this._escapeForPS(corner);

    const sendToBottomPS = sendToBottom ? "true" : "false";
    const noActivatePS = noActivate ? "true" : "false";

    const ps = `
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
  public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
    int X, int Y, int cx, int cy, uint uFlags);

  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOZORDER = 0x0004;
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

$needle = "${titlePS}"
$w = ${width}
$h = ${height}
$m = ${margin}
$corner = "${cornerPS}"
$sendToBottom = ${sendToBottomPS}
$noActivate = ${noActivatePS}
$timeoutMs = ${timeoutMs}

$deadline = (Get-Date).AddMilliseconds($timeoutMs)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $hwnd -eq [IntPtr]::Zero) {
  $hwnd = FindWindowContainsTitle $needle
  Start-Sleep -Milliseconds 120
}

if ($hwnd -eq [IntPtr]::Zero) { exit 0 }

# clamp size to WorkingArea
$maxW = $wa.Width - (2 * $m)
$maxH = $wa.Height - (2 * $m)
if ($w -gt $maxW) { $w = $maxW }
if ($h -gt $maxH) { $h = $maxH }
if ($w -lt 120) { $w = 120 }
if ($h -lt 200) { $h = 200 }

# position (default stack top-left)
$X = $wa.Left + $m
$Y = $wa.Top + $m

if ($corner -eq "bottom-right") {
  $X = $wa.Right - $w - $m
  $Y = $wa.Bottom - $h - $m
} elseif ($corner -eq "bottom-left") {
  $X = $wa.Left + $m
  $Y = $wa.Bottom - $h - $m
} elseif ($corner -eq "top-right") {
  $X = $wa.Right - $w - $m
  $Y = $wa.Top + $m
} else {
  $X = $wa.Left + $m
  $Y = $wa.Top + $m
}

# clamp position
if ($X -lt $wa.Left) { $X = $wa.Left }
if ($Y -lt $wa.Top) { $Y = $wa.Top }
if ($X + $w -gt $wa.Right) { $X = $wa.Right - $w }
if ($Y + $h -gt $wa.Bottom) { $Y = $wa.Bottom - $h }

[void][Win32]::MoveWindow($hwnd, $X, $Y, $w, $h, $true)

if ($sendToBottom) {
  $flags = [Win32]::SWP_NOMOVE -bor [Win32]::SWP_NOSIZE -bor [Win32]::SWP_SHOWWINDOW
  if ($noActivate) { $flags = $flags -bor [Win32]::SWP_NOACTIVATE }
  [void][Win32]::SetWindowPos($hwnd, [Win32]::HWND_BOTTOM, 0,0,0,0, $flags)
}

exit 0
`;

    return new Promise((resolve, reject) => {
      const p = spawn(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { stdio: "ignore", windowsHide: true }
      );
      p.on("close", () => resolve(true));
      p.on("error", reject);
    });
  }
}

module.exports = { scrcpy: new ScrcpyController() };
