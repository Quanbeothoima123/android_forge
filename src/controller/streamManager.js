const { spawn } = require("child_process");
const WebSocket = require("ws");
const ffmpegPath = require("ffmpeg-static");

function findJpegFrames(buffer) {
  // JPEG: start FF D8, end FF D9
  const frames = [];
  let start = -1;

  for (let i = 0; i < buffer.length - 1; i++) {
    const a = buffer[i];
    const b = buffer[i + 1];

    if (start < 0 && a === 0xff && b === 0xd8) {
      start = i;
      i++;
      continue;
    }

    if (start >= 0 && a === 0xff && b === 0xd9) {
      const end = i + 2;
      frames.push(buffer.subarray(start, end));
      start = -1;
      i++;
    }
  }

  const rest = start >= 0 ? buffer.subarray(start) : Buffer.alloc(0);
  return { frames, rest };
}

class StreamManager {
  constructor() {
    this.wss = null;
    this.wsPort = null;

    // deviceId -> session
    this.sessions = new Map();
  }

  startWsServer(port = 0) {
    if (this.wss) return { port: this.wsPort };

    this.wss = new WebSocket.Server({ port });
    this.wsPort = this.wss.address().port;

    this.wss.on("connection", (ws, req) => {
      // URL: ws://127.0.0.1:PORT/?deviceId=xxx
      const url = new URL(req.url, `ws://127.0.0.1:${this.wsPort}`);
      const deviceId = url.searchParams.get("deviceId") || "";

      const sess = this.sessions.get(deviceId);
      if (sess) {
        sess.clients.add(ws);
        ws.on("close", () => sess.clients.delete(ws));
      } else {
        ws.close(1008, "stream not started for this device");
      }
    });

    return { port: this.wsPort };
  }

  getWsUrl(deviceId) {
    if (!this.wss) throw new Error("WS server not started");
    return `ws://127.0.0.1:${this.wsPort}/?deviceId=${encodeURIComponent(
      deviceId
    )}`;
  }

  isRunning(deviceId) {
    return this.sessions.has(deviceId);
  }

  async start(deviceId, opts = {}) {
    if (this.sessions.has(deviceId)) return this.getWsUrl(deviceId);

    this.startWsServer(0);

    const maxFps = opts.maxFps ?? 30;
    const bitRate = opts.bitRate ?? "8M";

    // 1) scrcpy headless H264 -> stdout
    // Lưu ý: một số build scrcpy hỗ trợ --raw-video-stream để in H264 raw ra stdout.
    // Nếu máy bạn không hỗ trợ flag này, mình sẽ đổi sang phương án B (server-only protocol).
    const scrcpyArgs = [
      "-s",
      deviceId,
      "--no-display",
      "--no-audio",
      "--no-control",
      "--video-codec=h264",
      `--max-fps=${maxFps}`,
      `--video-bit-rate=${bitRate}`,
      "--raw-video-stream",
    ];

    const scrcpy = spawn("scrcpy", scrcpyArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 2) ffmpeg: H264 -> MJPEG frames -> stdout
    const ffmpegArgs = [
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-i",
      "pipe:0",
      "-vf",
      `fps=${maxFps}`,
      "-q:v",
      "5",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ];

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Pipe scrcpy stdout (H264) -> ffmpeg stdin
    scrcpy.stdout.pipe(ffmpeg.stdin);

    const session = {
      deviceId,
      scrcpy,
      ffmpeg,
      clients: new Set(),
      jpegBuf: Buffer.alloc(0),
    };

    this.sessions.set(deviceId, session);

    const killSession = (reason) => {
      const s = this.sessions.get(deviceId);
      if (!s) return;
      this.sessions.delete(deviceId);

      try {
        for (const c of s.clients) {
          try {
            c.close(1011, reason || "stream stopped");
          } catch {}
        }
      } catch {}

      try {
        s.scrcpy.kill("SIGKILL");
      } catch {}
      try {
        s.ffmpeg.kill("SIGKILL");
      } catch {}
    };

    scrcpy.on("close", () => killSession("scrcpy closed"));
    ffmpeg.on("close", () => killSession("ffmpeg closed"));

    scrcpy.stderr.on("data", (d) => {
      // Nếu scrcpy flag không hỗ trợ, stderr sẽ báo.
      // Bạn paste log này cho mình, mình đổi sang phương án B ngay.
      // console.error("[scrcpy]", d.toString("utf8"));
    });

    ffmpeg.stderr.on("data", (d) => {
      // console.error("[ffmpeg]", d.toString("utf8"));
    });

    ffmpeg.stdout.on("data", (chunk) => {
      const s = this.sessions.get(deviceId);
      if (!s) return;

      s.jpegBuf = Buffer.concat([s.jpegBuf, chunk]);
      const { frames, rest } = findJpegFrames(s.jpegBuf);
      s.jpegBuf = rest;

      if (!frames.length) return;

      for (const frame of frames) {
        for (const ws of s.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(frame); // binary
          }
        }
      }
    });

    return this.getWsUrl(deviceId);
  }

  stop(deviceId) {
    const s = this.sessions.get(deviceId);
    if (!s) return;

    this.sessions.delete(deviceId);

    try {
      for (const c of s.clients) {
        try {
          c.close(1000, "stopped");
        } catch {}
      }
    } catch {}

    try {
      s.scrcpy.kill("SIGKILL");
    } catch {}
    try {
      s.ffmpeg.kill("SIGKILL");
    } catch {}
  }

  stopAll() {
    for (const deviceId of Array.from(this.sessions.keys())) {
      this.stop(deviceId);
    }
  }
}

module.exports = { StreamManager };
