/**
 * dsh-hold-to-talk-plus · 真流式 ASR(WebSocket)
 *
 * 走阿里云百炼的实时语音识别协议(Inference 类):
 *   wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *   1. 客户端发 run-task(header.action=run-task, streaming=duplex)
 *   2. 服务端回 task-started 后,客户端持续发**二进制 PCM**(16k/单声道/16bit)
 *   3. 服务端持续回 result-generated(中间结果 sentence_end=false,最终结果 sentence_end=true)
 *   4. 客户端发 finish-task,服务端回 task-finished
 *
 * 本模块只做"一次长按 = 一个会话":推 PCM、维护累计文本、结束时交回最终文本。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let WSCtor = null;
let wsIsPackage = false;

/** 优先用 ws 包(能带 Authorization 头);没有就退回全局 WebSocket */
function getWebSocket() {
  if (WSCtor) return WSCtor;
  try {
    WSCtor = require("ws");
    wsIsPackage = true;
  } catch {
    WSCtor = globalThis.WebSocket;
    wsIsPackage = false;
  }
  return WSCtor;
}

export function realtimeAvailable() {
  try {
    return typeof getWebSocket() === "function";
  } catch {
    return false;
  }
}

/** 是否能带鉴权头(只有 ws 包可以;全局 WebSocket 不行) */
export function realtimeAuthCapable() {
  getWebSocket();
  return wsIsPackage;
}

/** f32 [-1,1] → 16-bit LE PCM Buffer */
export function pcmToInt16(samples) {
  const n = samples ? samples.length : 0;
  const buf = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (typeof s !== "number" || !Number.isFinite(s)) s = 0;
    if (s < -1) s = -1;
    else if (s > 1) s = 1;
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export class RealtimeAsrSession {
  constructor(opts = {}) {
    this.url = String(opts.url || "").trim();
    this.model = String(opts.model || "").trim();
    this.apiKey = String(opts.apiKey || "").trim();
    this.language = opts.language && opts.language !== "auto" ? opts.language : "";
    this.sampleRate = opts.sampleRate || 16000;
    this.heartbeat = opts.heartbeat !== false;
    this.onPartial = typeof opts.onPartial === "function" ? opts.onPartial : () => {};
    this.log = typeof opts.log === "function" ? opts.log : () => {};

    this.taskId = uuid();
    this.ws = null;
    this.started = false;
    this.finished = false;
    this.error = null;
    this.queue = [];
    this.text = "";
    this.sentences = new Map();
    this._startPromise = null;
    this._finishPromise = null;
    this._startTimer = null;
    this._finishTimer = null;
  }

  get partial() {
    return this.text || "";
  }

  _fail(err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!this.error) this.error = e;
    return e;
  }

  /** 建立连接并等 task-started;失败 reject */
  start(timeoutMs = 12000) {
    if (this._startPromise) return this._startPromise;
    this._startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const failStart = (err) => {
        if (settled) return;
        settled = true;
        this._fail(err);
        reject(this.error);
      };
      this._startTimer = setTimeout(() => failStart(new Error("实时识别连接超时")), Math.max(2000, timeoutMs));

      let Ctor;
      try {
        Ctor = getWebSocket();
      } catch (err) {
        failStart(new Error("没有可用的 WebSocket 实现:" + String((err && err.message) || err)));
        return;
      }

      const onOpen = () => {
        settled = true;
        this._sendRunTask();
        // 注意:settled 只用于防重复;task-started 才真正 resolve
      };
      const onStarted = () => {
        if (this._startTimer) clearTimeout(this._startTimer);
        this.started = true;
        resolve();
      };
      this._onStarted = onStarted;
      this._failStart = failStart;

      try {
        this.ws = wsIsPackage
          ? new Ctor(this.url, {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "user-agent": "dsh-hold-to-talk-plus/0.1.4-cloud.6",
              },
              handshakeTimeout: Math.max(3000, timeoutMs),
            })
          : new Ctor(this.url);
      } catch (err) {
        failStart(new Error("WebSocket 连接失败:" + String((err && err.message) || err)));
        return;
      }

      const onError = (err) => {
        const msg = err && (err.message || err.error || err);
        failStart(new Error("WebSocket 错误:" + String(msg || "unknown")));
      };
      const onClose = () => {
        if (!this.started) failStart(new Error("WebSocket 已关闭(API Key 无效 / 域名或模型不对)"));
        else if (!this.finished) this._finalize(new Error("实时识别连接中断"));
      };

      if (wsIsPackage) {
        this.ws.on("open", onOpen);
        this.ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          this._onMessage(data.toString("utf8"));
        });
        this.ws.on("error", onError);
        this.ws.on("close", onClose);
      } else {
        this.ws.addEventListener("open", onOpen);
        this.ws.addEventListener("message", (ev) => {
          const data = ev && ev.data !== undefined ? ev.data : ev;
          if (typeof data !== "string") {
            try {
              this._onMessage(Buffer.from(data).toString("utf8"));
            } catch {
              /* ignore */
            }
            return;
          }
          this._onMessage(data);
        });
        this.ws.addEventListener("error", onError);
        this.ws.addEventListener("close", onClose);
      }
    });
    return this._startPromise;
  }

  _send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.log("warn", "实时识别发送失败:" + String((err && err.message) || err));
    }
  }

  _sendRunTask() {
    const parameters = {
      format: "pcm",
      sample_rate: this.sampleRate,
      heartbeat: Boolean(this.heartbeat),
    };
    if (this.language) parameters.language_hints = [this.language];
    this._send({
      header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: this.model,
        parameters,
        input: {},
      },
    });
  }

  _sendAudio(buf) {
    try {
      this.ws.send(buf);
    } catch (err) {
      this.log("warn", "实时识别音频发送失败:" + String((err && err.message) || err));
    }
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const header = msg.header || {};
    const ev = header.event;

    if (ev === "task-started") {
      if (this._onStarted) this._onStarted();
      const queued = this.queue;
      this.queue = [];
      for (const chunk of queued) this._sendAudio(chunk);
      return;
    }

    if (ev === "result-generated") {
      const output = (msg.payload && msg.payload.output) || {};
      const sentence = output.sentence;
      if (sentence && sentence.heartbeat) return;
      if (typeof output.text === "string" && output.text) {
        this.text = output.text;
      } else if (sentence && typeof sentence.text === "string" && sentence.text) {
        this.sentences.set(sentence.sentence_id || 0, sentence.text);
        this.text = [...this.sentences.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, t]) => t)
          .join("");
      }
      try {
        this.onPartial(this.text);
      } catch {
        /* ignore */
      }
      return;
    }

    if (ev === "task-finished") {
      this._finalize(null);
      return;
    }

    if (ev === "task-failed") {
      const detail = header.error_message || header.error_code || "task-failed";
      this._finalize(new Error("实时识别失败:" + detail));
    }
  }

  /** 推入一段 f32 PCM(未 started 时先排队) */
  push(samples) {
    if (!samples || samples.length === 0 || this.finished) return;
    const buf = pcmToInt16(samples);
    if (!this.started) {
      this.queue.push(buf);
      return;
    }
    this._sendAudio(buf);
  }

  _finalize(err) {
    if (this.finished) return;
    this.finished = true;
    if (this._startTimer) clearTimeout(this._startTimer);
    if (this._finishTimer) clearTimeout(this._finishTimer);
    if (err) this._fail(err);

    if (!this.started && this._failStart && this.error) this._failStart(this.error);
    if (this._finishPromise && this._finishSettle) this._finishSettle(this.error && !this.text ? this.error : null);

    try {
      this.ws && this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * 结束任务并返回最终文本(含最后一个 result-generated)。
   * @param {number} [timeoutMs]
   * @returns {Promise<string>}
   */
  finish(timeoutMs = 20000) {
    if (this._finishPromise) return this._finishPromise;
    this._finishPromise = new Promise((resolve, reject) => {
      this._finishSettle = (err) => {
        if (err) reject(err);
        else resolve(this.text);
      };
      this._finishTimer = setTimeout(() => {
        this._finalize(this.error || new Error("实时识别超时"));
      }, Math.max(3000, timeoutMs));
      this._send({
        header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
        payload: { input: {} },
      });
    });
    return this._finishPromise;
  }

  abort() {
    if (this.finished) return;
    this.finished = true;
    if (this._startTimer) clearTimeout(this._startTimer);
    if (this._finishTimer) clearTimeout(this._finishTimer);
    try {
      this.ws && this.ws.close();
    } catch {
      /* ignore */
    }
  }
}