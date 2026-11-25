import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { AudioDriver } from "../audio/audio-driver.js";
import { PairingAuthService } from "../auth/pairing-auth.js";
import { parseClientCommand, ServerMessage, AudioState } from "../shared/protocol.js";

export interface AppServerOptions {
  authService: PairingAuthService;
  audioDriver: AudioDriver;
  hostName: string;
  port?: number;
  publicDir?: string;
}

export class AppServer {
  private authService: PairingAuthService;
  private audioDriver: AudioDriver;
  private hostName: string;
  private port: number;
  private publicDir: string;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private connectedSockets: Set<WebSocket> = new Set();
  private unsubscribeDriver?: () => void;

  constructor(options: AppServerOptions) {
    this.authService = options.authService;
    this.audioDriver = options.audioDriver;
    this.hostName = options.hostName;
    this.port = options.port ?? 4818;
    this.publicDir = options.publicDir ?? path.resolve("public");
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

        // Push initial state
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
              case "setVolume":
                await this.audioDriver.setVolume(cmd.volume);
                break;
              case "adjustVolume":
                await this.audioDriver.adjustVolume(cmd.delta);
                break;
              case "setMuted":
                await this.audioDriver.setMuted(cmd.muted);
                break;
              case "toggleMute":
                await this.audioDriver.toggleMute();
                break;
            }
          } catch {
            // ignore malformed ws messages
          }
        });

        ws.on("close", () => {
          this.connectedSockets.delete(ws);
        });
      });

      this.unsubscribeDriver = this.audioDriver.onStateChange((state) => {
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

    // CORS & PWA headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/pair") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const json = JSON.parse(body || "{}");
          let token: string | null = null;

          if (json.pin) {
            token = this.authService.verifyPinAndIssueToken(String(json.pin), clientIp);
          } else if (json.bootstrapToken) {
            token = this.authService.verifyBootstrapAndIssueToken(String(json.bootstrapToken), clientIp);
          }

          if (!token) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid credentials or rate limited" }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token, hostName: this.hostName }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    // Static Assets serving
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
          ".webmanifest": "application/manifest+json"
        };
        res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
        fs.createReadStream(safePath).pipe(res);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
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
