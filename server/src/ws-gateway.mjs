/**
 * ws-gateway.mjs — 设备 WebSocket 网关
 *
 * 只做三件事：鉴权、建会话、转发消息。业务逻辑都在 DeviceSession 里。
 */

import { WebSocketServer } from "ws";
import { DeviceSession } from "./device.mjs";

const log = (...a) => console.log("[ws]", ...a);

export class WsGateway {
  /**
   * @param {import("node:http").Server} httpServer
   * @param {{config:object, weather:object, devices:Set}} ctx
   */
  constructor(httpServer, ctx) {
    this.ctx = ctx;
    this.sessions = new Set();

    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/device",
      maxPayload: 512 * 1024,
    });

    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    log(`设备网关已挂载 ws://<host>/device`);
  }

  /** 从 query 或 Authorization 头取 token */
  static tokenOf(req) {
    try {
      const q = new URL(req.url, "http://x").searchParams.get("token");
      if (q) return q;
    } catch { /* ignore */ }
    const h = req.headers["authorization"];
    const m = h && /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : null;
  }

  onConnection(ws, req) {
    const cfg = this.ctx.config;
    const ip = req.socket.remoteAddress;

    /* 1) token 鉴权 */
    if (cfg.server.authToken) {
      const got = WsGateway.tokenOf(req);
      if (got !== cfg.server.authToken) {
        log(`鉴权失败 ${ip}`);
        ws.close(4401, "unauthorized");
        return;
      }
    }

    const session = new DeviceSession(ws, this.ctx);
    this.sessions.add(session);
    this.ctx.devices.add(session);
    session.start();

    ws.on("message", (data, isBinary) => {
      try {
        session.onMessage(data, isBinary);
      } catch (e) {
        log(`[${session.sid}] 处理消息异常: ${e.message}`);
      }
    });

    ws.on("close", () => {
      session.close();
      this.sessions.delete(session);
      this.ctx.devices.delete(session);
    });

    ws.on("error", (e) => {
      log(`[${session.sid}] socket 错误: ${e.message}`);
    });

    log(`设备接入 ${ip} → ${session.sid}`);
  }

  /** 给所有在线设备广播 */
  broadcast(obj) {
    for (const s of this.sessions) s.send(obj);
  }
}
