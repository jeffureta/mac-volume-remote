import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { AudioDriver } from "../audio/audio-driver.js";
import { PairingAuthService, AuthResult } from "../auth/pairing-auth.js";
import { parseClientCommand, ServerMessage, AudioState } from "../shared/protocol.js";
import { resolvePackagePath } from "../shared/paths.js";
import { VolumeMemoryStore } from "../state/volume-memory-store.js";

export interface AppServerOptions {
  authService: PairingAuthService;
  audioDriver: AudioDriver;
  volumeMemoryStore?: VolumeMemoryStore;
  hostName: string;
  port?: number;
  publicDir?: string;
}

export class AppServer {
  private authService: PairingAuthService;
  private audioDriver: AudioDriver;
  private volumeMemoryStore?: VolumeMemoryStore;
  private hostName: string;
  private port: number;
  private publicDir: string;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private connectedSockets: Set<WebSocket> = new Set();
  private unsubscribeDriver?: () => void;
  private startTime: number = Date.now();
  private lastKnownUpdatedAt: string = new Date().toISOString();

  constructor(options: AppServerOptions) {
    this.authService = options.authService;
    this.audioDriver = options.audioDriver;
    this.volumeMemoryStore = options.volumeMemoryStore;
    this.hostName = options.hostName;
    this.port = options.port ?? 4818;
    this.publicDir = options.publicDir ?? resolvePackagePath("public");
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
      this.wss = new WebSocketServer({ noServer: true });

      this.httpServer.on("upgrade", (req, socket, head) => {
        const parsedUrl = new URL(req.url || "", `http://${req.headers.host}`);
        const token = parsedUrl.searchParams.get("token") || "";

        if (parsedUrl.pathname !== "/ws" || !this.authService.validateSessionToken(token)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.wss?.emit("connection", ws, req);
        });
      });

      this.wss.on("connection", (ws: WebSocket) => {
        this.connectedSockets.add(ws);

        this.audioDriver.getState().then((state) => {
          this.sendToSocket(ws, { type: "state", state, hostName: this.hostName });
        });

        ws.on("message", async (data) => {
          try {
            const raw = JSON.parse(data.toString());
            const cmd = parseClientCommand(raw);
            if (!cmd) return;

            switch (cmd.type) {
              case "getState": {
                const state = await this.audioDriver.getState();
                this.sendToSocket(ws, { type: "state", state, hostName: this.hostName });
                break;
              }
              case "setVolume": {
                const state = await this.audioDriver.setVolume(cmd.volume);
                this.persistState(state);
                break;
              }
              case "adjustVolume": {
                const state = await this.audioDriver.adjustVolume(cmd.delta);
                this.persistState(state);
                break;
              }
              case "setMuted": {
                const state = await this.audioDriver.setMuted(cmd.muted);
                this.persistState(state);
                break;
              }
              case "toggleMute": {
                const state = await this.audioDriver.toggleMute();
                this.persistState(state);
                break;
              }
            }
          } catch {
            // ignore
          }
        });

        ws.on("close", () => {
          this.connectedSockets.delete(ws);
        });
      });

      this.unsubscribeDriver = this.audioDriver.onStateChange((state) => {
        this.persistState(state);
        this.broadcastState(state);
      });

      this.httpServer.listen(this.port, "0.0.0.0", () => {
        const addr = this.httpServer?.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
          resolve(addr.port);
        } else {
          resolve(this.port);
        }
      });

      this.httpServer.on("error", reject);
    });
  }

  public async stop(): Promise<void> {
    this.unsubscribeDriver?.();
    for (const ws of this.connectedSockets) {
      ws.close();
    }
    this.connectedSockets.clear();

    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });

    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const clientIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint (unauthenticated)
    if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
      const indexHtmlPath = path.join(this.publicDir, "index.html");
      const appJsPath = path.join(this.publicDir, "app.js");
      const assetsReady = fs.existsSync(indexHtmlPath) && fs.existsSync(appJsPath);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        hostName: this.hostName,
        uptimeSec: Math.floor((Date.now() - this.startTime) / 1000),
        assetsReady
      }));
      return;
    }

    // Auth verify endpoint
    if (req.method === "GET" && parsedUrl.pathname === "/api/auth/verify") {
      const token = this.extractToken(req, parsedUrl);

      if (token && this.authService.validateSessionToken(token)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: true, hostName: this.hostName }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          valid: false,
          code: "E_AUTH_EXPIRED",
          error: "Session token expired or revoked. Please re-enter the 4-digit PIN."
        }));
      }
      return;
    }

    // Current audio state sync endpoint (for instant cross-iPhone & wake resync)
    if (req.method === "GET" && parsedUrl.pathname === "/api/state") {
      const token = this.extractToken(req, parsedUrl);

      if (!token || !this.authService.validateSessionToken(token)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({
          code: "E_AUTH_EXPIRED",
          error: "Session token expired or revoked. Please re-enter the 4-digit PIN."
        }));
        return;
      }

      this.audioDriver.getState().then((state) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({
          state,
          hostName: this.hostName,
          updatedAt: this.lastKnownUpdatedAt
        }));
      }).catch(() => {
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({
          code: "E_RUNTIME_ERROR",
          error: "Failed to read audio state."
        }));
      });
      return;
    }

    // Pairing endpoint
    if (req.method === "POST" && parsedUrl.pathname === "/api/pair") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const json = JSON.parse(body || "{}");
          let authResult: AuthResult | null = null;

          if (json.pin) {
            authResult = this.authService.authenticatePin(String(json.pin), clientIp);
          } else if (json.bootstrapToken) {
            authResult = this.authService.authenticateBootstrap(String(json.bootstrapToken), clientIp);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: "E_BAD_REQUEST", error: "Missing pin or bootstrapToken." }));
            return;
          }

          if (authResult.ok) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ token: authResult.token, hostName: this.hostName }));
          } else {
            const statusCode = authResult.code === "E_PAIR_RATE_LIMITED" ? 429 : 401;
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              code: authResult.code,
              error: authResult.error,
              retryAfterSec: authResult.retryAfterSec
            }));
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "E_BAD_JSON", error: "Invalid JSON payload." }));
        }
      });
      return;
    }

    // Static assets
    if (req.method === "GET") {
      let filePath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
      const safePath = path.normalize(path.join(this.publicDir, filePath));

      if (safePath.startsWith(this.publicDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        const ext = path.extname(safePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
          ".webmanifest": "application/manifest+json"
        };
        const headers: Record<string, string> = {
          "Content-Type": mimeTypes[ext] || "application/octet-stream"
        };
        if (ext === ".html" || ext === ".js" || ext === ".css" || ext === ".webmanifest") {
          headers["Cache-Control"] = "no-cache";
        }
        res.writeHead(200, headers);
        fs.createReadStream(safePath).pipe(res);
        return;
      }

      if (parsedUrl.pathname === "/") {
        // Missing index.html fallback
        res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Mac Volume Remote - Assets Missing</title></head>
<body style="font-family: -apple-system, sans-serif; background: #000; color: #fff; padding: 32px; text-align: center;">
  <h2>Web Assets Missing</h2>
  <p>The client build assets were not found in <code>${this.publicDir}</code>.</p>
  <p>Please run <code>npm run build</code> on your Mac and reload.</p>
</body>
</html>`);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  private extractToken(req: http.IncomingMessage, parsedUrl: URL): string {
    let token = parsedUrl.searchParams.get("token") || "";
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7).trim();
    }
    return token;
  }

  private persistState(state: AudioState) {
    if (this.volumeMemoryStore) {
      const saved = this.volumeMemoryStore.save(state);
      this.lastKnownUpdatedAt = saved.updatedAt;
    } else {
      this.lastKnownUpdatedAt = new Date().toISOString();
    }
  }

  private broadcastState(state: AudioState) {
    const msg: ServerMessage = { type: "state", state, hostName: this.hostName };
    for (const ws of this.connectedSockets) {
      this.sendToSocket(ws, msg);
    }
  }

  private sendToSocket(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
