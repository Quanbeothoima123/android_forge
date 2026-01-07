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

    const args = [
      "-s",
      deviceId,
      "--no-audio",
      "--window-title",
      title,
      "--max-fps",
      String(opts.maxFps ?? 30),
      "--video-bit-rate",
      String(opts.bitRate ?? "8M"),
    ];

    if (opts.portRange) {
      args.push("--port", String(opts.portRange));
    }

    // Không bật control ở scrcpy (ta control qua agent)
    // nhưng giữ GUI để capture window
    args.push("--no-control");

    const proc = spawn("scrcpy", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: false,
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

    // Move window (small + corner). IMPORTANT: do NOT minimize (minimize -> capture đen)
    if (opts.moveWindow) {
      this._moveWindowByTitle(title, opts.moveWindow).catch((e) => {
        console.log("[scrcpy moveWindow] failed:", e.message);
      });
    }

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

  _moveWindowByTitle(title, move) {
    const width = Number(move.width ?? 260);
    const height = Number(move.height ?? 580);
    const margin = Number(move.margin ?? 10);

    // x/y = -1 => auto bottom-right
    const x = Number(move.x ?? -1);
    const y = Number(move.y ?? -1);

    // PowerShell script: find window by title contains, then MoveWindow/SetWindowPos
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function FindWindowContainsTitle($needle) {
  $found = [IntPtr]::Zero
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

$needle = "${title}"
$w = ${width}
$h = ${height}
$margin = ${margin}

$deadline = (Get-Date).AddSeconds(6)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $hwnd -eq [IntPtr]::Zero) {
  $hwnd = FindWindowContainsTitle $needle
  Start-Sleep -Milliseconds 150
}

if ($hwnd -eq [IntPtr]::Zero) { exit 0 }

# compute bottom-right if x/y == -1
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$X = ${x}
$Y = ${y}
if ($X -lt 0) { $X = $screen.Width - $w - $margin }
if ($Y -lt 0) { $Y = $screen.Height - $h - $margin }

[void][Win32]::MoveWindow($hwnd, $X, $Y, $w, $h, $true)
exit 0
`;

    return new Promise((resolve, reject) => {
      const p = spawn(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { stdio: "ignore", windowsHide: true }
      );
      p.on("close", (code) => (code === 0 ? resolve(true) : resolve(true)));
      p.on("error", reject);
    });
  }
}

module.exports = { scrcpy: new ScrcpyController() };
