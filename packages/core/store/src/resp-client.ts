/**
 * 最小 RESP2 客户端（S3）：net socket + 数组协议，够用即止。
 *
 * 不用 ioredis：实测其连接握手与 Garnet（RESP 兼容服务）不兼容（连接被 reset），
 * 而限流与广播只需要 INCR/EXPIRE/PUBLISH/SUBSCRIBE 四条命令 —— 自写百行内
 * 客户端比绑死一个驱动库更可控，Redis 真机与 Garnet 都能连。
 */

import net from "node:net";

type Reply = string | number | null | Reply[];

export interface RespUrl {
  host: string;
  port: number;
}

/** redis://host:port 解析（无 scheme 时按 host:port）。 */
export function parseRedisUrl(url: string): RespUrl {
  const stripped = url.replace(/^redis:\/\//, "");
  const [host, port] = stripped.split(":");
  return { host: host || "127.0.0.1", port: Number(port || 6379) };
}

function encodeCommand(args: (string | number)[]): Buffer {
  const parts: string[] = [`*${args.length}\r\n`];
  for (const a of args) {
    const s = String(a);
    parts.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}

interface Waiter {
  resolve: (v: Reply) => void;
  reject: (e: Error) => void;
}

export class RespClient {
  readonly #url: RespUrl;
  #sock: net.Socket | null = null;
  #buf = Buffer.alloc(0);
  #waiters: Waiter[] = [];
  #pushHandler: ((msg: Reply[]) => void) | null = null;
  #connecting: Promise<void> | null = null;

  constructor(url: RespUrl) {
    this.#url = url;
  }

  /** 惰性连接；断开后下一次调用自动重连。 */
  async ensure(): Promise<void> {
    if (this.#sock !== null && !this.#sock.destroyed) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: this.#url.host, port: this.#url.port });
      sock.setTimeout(1500);
      sock.on("connect", () => {
        sock.setTimeout(0);
        this.#sock = sock;
        this.#connecting = null;
        resolve();
      });
      const fail = (err: Error) => {
        sock.destroy();
        this.#sock = null;
        this.#connecting = null;
        for (const w of this.#waiters) w.reject(err);
        this.#waiters = [];
        reject(err);
      };
      sock.on("error", fail);
      sock.on("timeout", () => fail(new Error(`redis connect timeout: ${this.#url.host}:${this.#url.port}`)));
      sock.on("data", (chunk) => this.#onData(chunk));
    });
    return this.#connecting;
  }

  async command(...args: (string | number)[]): Promise<Reply> {
    await this.ensure();
    const sock = this.#sock;
    if (sock === null) throw new Error("redis socket unavailable");
    return new Promise<Reply>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
      sock.write(encodeCommand(args));
    });
  }

  /** 订阅推送消息（无等待命令时到达的数组回复）。 */
  onPush(handler: (msg: Reply[]) => void): void {
    this.#pushHandler = handler;
  }

  close(): void {
    if (this.#sock) this.#sock.destroy();
    this.#sock = null;
    for (const w of this.#waiters) w.reject(new Error("client closed"));
    this.#waiters = [];
  }

  #onData(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const parsed = this.#parseReply(this.#buf, 0);
      if (parsed === null) return; // 不完整，等下一包
      this.#buf = this.#buf.subarray(parsed.next);
      if (this.#waiters.length > 0) {
        const w = this.#waiters.shift()!;
        if (parsed.value instanceof Error) w.reject(parsed.value);
        else w.resolve(parsed.value as Reply);
      } else if (this.#pushHandler !== null && Array.isArray(parsed.value)) {
        this.#pushHandler(parsed.value);
      }
    }
  }

  /** 增量解析一条 RESP 回复；返回 null = 缓冲不足。 */
  #parseReply(buf: Buffer, offset: number): { value: Reply | Error; next: number } | null {
    if (offset >= buf.length) return null;
    const type = String.fromCharCode(buf[offset]!);
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const line = buf.subarray(offset + 1, lineEnd).toString("utf8");
    const after = lineEnd + 2;
    switch (type) {
      case "+":
        return { value: line, next: after };
      case ":":
        return { value: Number(line), next: after };
      case "-":
        return { value: new Error(line), next: after };
      case "$": {
        const len = Number(line);
        if (len === -1) return { value: null, next: after };
        if (buf.length < after + len + 2) return null;
        return { value: buf.subarray(after, after + len).toString("utf8"), next: after + len + 2 };
      }
      case "*": {
        const n = Number(line);
        if (n === -1) return { value: null, next: after };
        const items: Reply[] = [];
        let cursor = after;
        for (let i = 0; i < n; i += 1) {
          const inner = this.#parseReply(buf, cursor);
          if (inner === null) return null;
          items.push(inner.value instanceof Error ? inner.value.message : inner.value);
          cursor = inner.next;
        }
        return { value: items, next: cursor };
      }
      default:
        return { value: new Error(`bad RESP type byte: ${type}`), next: buf.length };
    }
  }
}
