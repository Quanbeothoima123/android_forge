const { spawn } = require("child_process");

function toPsEncodedCommand(psScript) {
  return Buffer.from(psScript, "utf16le").toString("base64");
}

function getWindowRectByTitleContains(titleNeedle, timeoutMs = 1200) {
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
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
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

$needle = ${JSON.stringify(titleNeedle)}
$hwnd = FindWindowContainsTitle $needle
if ($hwnd -eq [IntPtr]::Zero) { Write-Output ""; exit 0 }

$rect = New-Object Win32+RECT
[void][Win32]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("{0},{1},{2},{3}" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
exit 0
`;

  return new Promise((resolve, reject) => {
    const encoded = toPsEncodedCommand(ps);
    const p = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true }
    );

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      reject(new Error("getWindowRect timeout"));
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.stderr.on("data", (d) => (err += d.toString("utf8")));

    p.on("close", (code) => {
      clearTimeout(timer);
      const s = out.trim();
      if (!s) return resolve(null);
      const parts = s.split(",").map((x) => Number(x));
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
        return resolve(null);
      const [L, T, R, B] = parts;
      resolve({ x: L, y: T, w: Math.max(0, R - L), h: Math.max(0, B - T) });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

module.exports = { getWindowRectByTitleContains };
