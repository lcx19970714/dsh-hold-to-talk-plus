/**
 * dsh-hold-to-talk · host 半身
 *
 * 职责:
 *  1. 注册 HTTP 路由(浏览器半身通过它上传 PCM、查询模型状态、取配置)
 *  2. 管理本地 SenseVoice 识别引擎(懒加载 + worker 线程,避免阻塞宿主事件循环)
 *  3. 首次使用按需下载模型(hf-mirror,断点续传,带进度)
 *  4. 维护每个"长按会话"的音频缓冲:实时预览只解码尾部滑动窗口,松手定稿用完整音频
 *
 * 路由:
 *   POST /dsh-hold-to-talk/asr?mode=interim|final|drop&hold=<id>  body = 小端 f32 PCM
 *   GET  /dsh-hold-to-talk/health[?prepare=1]
 *   GET  /dsh-hold-to-talk/config
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DEFAULT_MIRROR, ensureModels, modelsReady, modelPaths } from "./model-cache.js";
import { cloudConfigured, transcribeCloud } from "./cloud-asr.mjs";
import { applyRules, glossaryText, loadWordbank, saveWordbank, wordbankPath } from "./wordbank.mjs";
import { loadSettings, normalizePatch, publicConfig, saveSettings } from "./settings-store.mjs";

export const name = "dsh-hold-to-talk";

const NS = "dsh-hold-to-talk";
const ROUTE = "/dsh-hold-to-talk";
const SAMPLE_RATE = 16000;
/** 单次上传上限:60 秒 @16k f32 ≈ 3.8MB,留足余量 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** 长按会话缓冲的存活时间(客户端异常退出后的兜底清理) */
const MAX_HOLD_AGE_MS = 5 * 60 * 1000;
const MAX_HOLDS = 8;
/** 太短的音频不值得解码 */
const MIN_DECODE_SAMPLES = Math.round(SAMPLE_RATE * 0.2);

export const DEFAULT_CONFIG = {
  enabled: true,
  holdThresholdMs: 400,
  cancelSlidePx: 60,
  // 实测(原生引擎 RTF≈0.15):6 秒窗口解码约 0.9 秒,1.5 秒一轮留足余量。
  // 原定 900ms/12s 在 WASM 单线程下要 4.4 秒一轮,预览会拖到 4 秒以上,已按实测调宽。
  interimIntervalMs: 1500,
  minHoldMs: 250,
  maxHoldMs: 60000,
  maxWindowSec: 6,
  autoSend: false,
  language: "auto",
  useItn: true,
  numThreads: 2,
  mirror: DEFAULT_MIRROR,
  modelDir: "",
  // ── 识别引擎:local = 本地 SenseVoice(原插件行为);cloud = 转发到 OpenAI 兼容端点 ──
  asrEngine: "local",
  /** 云端端点,如 https://api.siliconflow.cn/v1/audio/transcriptions 或自建 faster-whisper */
  cloudAsrUrl: "",
  cloudAsrModel: "",
  cloudAsrApiKey: "",
  /** 云端协议:transcriptions(OpenAI /audio/transcriptions) | chat-audio(chat/completions + input_audio) */
  cloudAsrApi: "transcriptions",
  /** chat-audio 模式额外并入请求体的字段(如给百炼传 asr_options) */
  cloudAsrExtra: {},
  /** 云端语言提示;auto 时不发送该字段 */
  cloudAsrLanguage: "zh",
  /** 云端上下文/热词提示,是否生效取决于服务商 */
  cloudAsrPrompt: "",
  cloudTimeoutMs: 30000,
  /** 云端失败时,若本地引擎已就绪则回退到本地识别 */
  cloudFallbackToLocal: true,
  /** 云端模式也做"边说边出字"的实时预览(每 N 毫秒重发一次尾部窗口) */
  cloudInterim: true,
  /** 云端实时预览的轮询间隔(毫秒) */
  cloudInterimIntervalMs: 2000,
  // ── 提示词 / 用户词库 / 输入框上下文 ──
  /** 把输入框里已有的草稿一起发给云端模型当上下文 */
  useDraftContext: true,
  /** 草稿最多取末尾多少字符 */
  draftContextChars: 300,
  /** 词库文件;留空 = ~/.dsh/hold-to-talk/words.txt */
  wordbankPath: "",
  /** 也可以直接写在配置里的词库(换行分隔),与文件合并 */
  wordbankInline: "",
  /** 本地识别结果是否套用词库里的纠正规则(本地模型不支持热词) */
  wordbankApplyToLocal: true,
  /** 拼出来的提示词总长度上限 */
  promptMaxChars: 800,
};

/** 是否处于云端识别模式(端点已配置) */
function cloudMode(config) {
  return cloudConfigured(config);
}

/** ---------- 小工具 ---------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 廉价防护:自定义路由不在 `/api` 的浏览器信任栅栏后面,这里自己挡一下跨站请求
 * (DNS rebinding / 恶意页面直接 POST)。同源 fetch 的 sec-fetch-site 是 same-origin,
 * 用户直接在地址栏打开是 none;两者都放行。
 */
function crossSite(req) {
  const site = req.headers["sec-fetch-site"];
  return typeof site === "string" && site !== "same-origin" && site !== "none";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 小端 f32 裸字节 → Float32Array(x86/arm 都是小端,直接视图即可) */
function toFloat32(buf) {
  const usable = buf.byteLength - (buf.byteLength % 4);
  if (usable <= 0) return new Float32Array(0);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** ---------- 插件 ---------- */

export function apply(ctx, entryConfig) {
  // 配置来源 = 插件条目 config(即 cordis.patch.yml 里 insert[].config)。
  // DSH 0.1.7 起,Web 设置面板改为 schema 驱动的自动表单,旧的
  // `settings.register(ns, schema, {base})` 命名空间契约已废弃(相关服务被移除),
  // 本插件不再注册设置命名空间;要改参数请直接改 cordis.patch.yml。
  let config = { ...DEFAULT_CONFIG, ...(entryConfig || {}) };
  // 设置页写入的覆盖(~/.dsh/hold-to-talk/settings.json)优先级高于 cordis 配置
  try {
    const saved = loadSettings();
    if (saved && typeof saved === "object") config = { ...config, ...saved };
  } catch {
    /* 设置文件损坏时忽略,继续用 cordis 配置 */
  }

  const state = {
    model: { status: "idle", progress: 0, file: "", error: null, dir: modelsDirSafe() },
    engine: { ready: false, error: null },
    holds: new Map(),
  };

  function modelsDirSafe() {
    try {
      return modelPaths(config).dir;
    } catch {
      return "";
    }
  }

  function log(level, message) {
    try {
      const logger = ctx.logger;
      if (logger && typeof logger[level] === "function") logger[level](message);
    } catch {
      /* ignore */
    }
  }

  /** ---------- 提示词 / 词库 / 草稿上下文 ---------- */

  const DRAFT_HEADER = "x-htt-draft";

  /** 浏览器半身把输入框草稿用 base64url 放进请求头 */
  function readDraft(req) {
    const raw = req.headers[DRAFT_HEADER];
    if (typeof raw !== "string" || raw === "") return "";
    try {
      return Buffer.from(raw, "base64url").toString("utf8").replace(/\u0000/g, "").slice(-4000);
    } catch {
      return "";
    }
  }

  /** 术语表 + 当前草稿 + 自定义提示,合成 system/背景提示 */
  function buildSystemPrompt(draft, cfg) {
    const conf = cfg && typeof cfg === "object" ? cfg : config;
    const parts = [];
    let wb = null;
    try {
      wb = loadWordbank(conf);
    } catch {
      wb = null;
    }
    const glossary = wb ? glossaryText(wb.terms, 400) : "";
    if (glossary) parts.push("术语表(请优先按这些写法输出):" + glossary);
    if (conf.useDraftContext && draft) {
      const limit = Math.max(0, Number(conf.draftContextChars) || 0);
      const tail = limit > 0 ? draft.slice(-limit).trim() : "";
      if (tail) {
        parts.push("用户正在输入框里编辑的内容(只用来理解语境和专有名词,不要复述、不要续写):" + tail);
      }
    }
    const extra = typeof conf.cloudAsrPrompt === "string" ? conf.cloudAsrPrompt.trim() : "";
    if (extra) parts.push(extra);
    if (parts.length === 0) return "";
    const head = "以下是这次语音听写的参考信息,只用于提高识别和用词准确度;不要在输出里复述或解释它们。";
    const max = Math.max(0, Number(conf.promptMaxChars) || 800);
    return (head + "\n" + parts.join("\n")).slice(0, max);
  }

  /** 把 HTTP / 网络错误翻译成用户能看懂的一句话 */
  function explainTestError(message) {
    const m = String(message || "");
    if (/HTTP 401|invalid api key|unauthorized|authentication/i.test(m)) return "Key 不对或已失效。请回控制台重新复制(注意别带空格/换行)。";
    if (/HTTP 403|forbidden|permission|not activated|未开通/i.test(m)) return "没有权限:可能账号未实名、未开通该模型,或 Key 没有该模型的调用权限。";
    if (/HTTP 404|not found|model_not_found/i.test(m)) return "端点或模型名不对。检查 URL 路径(是否少了 /v1 或 /compatible-mode/v1)和模型 ID(要填 ID,不是显示名)。";
    if (/HTTP 429|rate limit|quota|insufficient/i.test(m)) return "被限流或余额/配额不足。稍后再试,或去控制台看免费额度是否用完。";
    if (/HTTP 400.*Required body invalid|Required body invalid/i.test(m)) {
      return "请求体格式不对:多半是「协议」和「端点」不匹配——/chat/completions 要选 chat-audio,/audio/transcriptions 要选 transcriptions。现在已按 URL 自动纠正,若仍报错请检查模型名。";
    }
    if (/HTTP 400.*does not support this input|does not support this input/i.test(m)) {
      return "该模型不支持这种输入(常见于把提示词塞到不支持的位置)。已改成百炼支持的 system 数组格式;若仍报错,先把用户词库清空试试。";
    }
    if (/HTTP 5\d\d/i.test(m)) return "服务端错误,通常是对方服务暂时不可用,稍后重试。";
    if (/超时|timeout|abort/i.test(m)) return "请求超时。国内访问海外服务(如 Groq/OpenAI)需要代理;也可能是网络暂时不通。";
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed/i.test(m)) return "域名解析/连接失败:检查 URL 是否拼错、本机网络或代理是否可用。";
    return "调用失败:" + m.slice(0, 160);
  }

  /** 本地引擎不支持热词,用词库里的"错写=正确"规则做定稿后处理 */
  function polishLocal(text) {
    if (!text || !config.wordbankApplyToLocal) return text;
    try {
      const wb = loadWordbank(config);
      return applyRules(text, wb.rules);
    } catch {
      return text;
    }
  }

  /** ---------- 识别引擎(worker 线程) ---------- */

  let worker = null;
  const pending = new Map();
  let nextId = 1;

  function spawnEngine() {
    if (worker) return worker;
    const { modelPath, tokensPath } = modelPaths(config);
    worker = new Worker(new URL("./asr-worker.mjs", import.meta.url), {
      workerData: {
        modelPath,
        tokensPath,
        language: config.language,
        useItn: config.useItn,
        numThreads: config.numThreads,
      },
    });

    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        state.engine.ready = true;
        state.engine.error = null;
        log("info", `${NS}: 识别引擎就绪 (${path.basename(modelPath)})`);
        return;
      }
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.type === "result") slot.resolve(msg);
      else slot.reject(new Error(msg.message || "worker 报错"));
    });

    worker.on("error", (err) => {
      const message = String((err && err.message) || err);
      state.engine.ready = false;
      state.engine.error = message;
      log("warn", `${NS}: 识别引擎异常:${message}`);
      for (const slot of pending.values()) slot.reject(new Error(message));
      pending.clear();
      worker = null;
    });

    worker.on("exit", () => {
      worker = null;
      state.engine.ready = false;
    });

    worker.postMessage({ type: "warmup", id: 0 });
    return worker;
  }

  function decode(samples) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = spawnEngine();
      } catch (err) {
        reject(err);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const copy = samples.slice();
      target.postMessage({ type: "decode", id, samples: copy }, [copy.buffer]);
    });
  }

  function shutdownEngine() {
    if (!worker) return;
    const dying = worker;
    worker = null;
    state.engine.ready = false;
    dying.removeAllListeners();
    dying.terminate().catch(() => {});
    for (const slot of pending.values()) slot.reject(new Error("引擎已重启"));
    pending.clear();
  }

  /** ---------- 模型准备 ---------- */

  let preparePromise = null;

  function prepareModel() {
    if (preparePromise) return preparePromise;
    if (cloudMode(config)) {
      // 云端模式不需要本地模型:直接标记就绪,避免浏览器半身等 228MB 下载
      state.model.status = "ready";
      state.model.progress = 1;
      state.model.dir = "";
      return Promise.resolve();
    }
    if (cloudMode(config)) {
    state.model.status = "ready";
    state.model.progress = 1;
  } else if (modelsReady(config)) {
      state.model.status = "ready";
      state.model.progress = 1;
      state.model.dir = modelsDirSafe();
      spawnEngine();
      return Promise.resolve();
    }
    state.model.status = "downloading";
    state.model.error = null;
    preparePromise = ensureModels(config, (p) => {
      state.model.status = "downloading";
      state.model.progress = Math.max(0, Math.min(1, p.ratio || 0));
      state.model.file = p.file;
    })
      .then(() => {
        state.model.status = "ready";
        state.model.progress = 1;
        state.model.dir = modelsDirSafe();
        spawnEngine();
      })
      .catch((err) => {
        state.model.status = "error";
        state.model.error = String((err && err.message) || err);
        log("warn", `${NS}: 模型准备失败:${state.model.error}`);
      })
      .finally(() => {
        preparePromise = null;
      });
    return preparePromise;
  }

  /** ---------- 长按会话缓冲 ---------- */

  function getHold(id) {
    const now = Date.now();
    for (const [key, entry] of state.holds) {
      if (now - entry.updatedAt > MAX_HOLD_AGE_MS) state.holds.delete(key);
    }
    let entry = state.holds.get(id);
    if (!entry) {
      if (state.holds.size >= MAX_HOLDS) {
        const oldest = [...state.holds.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (oldest) state.holds.delete(oldest[0]);
      }
      entry = { chunks: [], updatedAt: now, createdAt: now };
      state.holds.set(id, entry);
    }
    entry.updatedAt = now;
    return entry;
  }

  /** ---------- 路由 ---------- */

  async function handleAsr(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "只接受 POST" });
      return;
    }
    if (!config.enabled) {
      sendJson(res, 503, { error: "插件已禁用" });
      return;
    }

    const url = new URL(req.url || ROUTE, "http://127.0.0.1");
    const mode = url.searchParams.get("mode") === "interim" ? "interim" : url.searchParams.get("mode") === "drop" ? "drop" : "final";
    const holdId = (url.searchParams.get("hold") || "default").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "default";

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: String((err && err.message) || err) });
      return;
    }

    if (mode === "drop") {
      state.holds.delete(holdId);
      sendJson(res, 200, { ok: true, dropped: true });
      return;
    }

    const cloud = cloudMode(config);
    if (!cloud && state.model.status !== "ready") {
      prepareModel();
      sendJson(res, 409, {
        code: "model-preparing",
        status: state.model.status,
        progress: state.model.progress,
        error: state.model.error,
      });
      return;
    }

    const samples = toFloat32(body);
    const entry = getHold(holdId);
    if (samples.length > 0) entry.chunks.push(samples);

    const total = entry.chunks.reduce((sum, c) => sum + c.length, 0);
    const all = mode === "final" ? concatChunks(entry.chunks) : null;
    // 实时预览只解码尾部窗口,避免长按越久单次解码越贵;定稿用完整音频
    let window = all;
    if (mode === "interim") {
      const cap = Math.max(1, Math.round(config.maxWindowSec * SAMPLE_RATE));
      if (total <= cap) {
        window = concatChunks(entry.chunks);
      } else {
        const skip = total - cap;
        let seen = 0;
        const tail = [];
        for (const c of entry.chunks) {
          if (seen + c.length <= skip) {
            seen += c.length;
            continue;
          }
          const from = Math.max(0, skip - seen);
          tail.push(c.subarray(from));
          seen += c.length;
        }
        window = concatChunks(tail);
      }
    }

    if (mode === "final") state.holds.delete(holdId);
    const draft = mode === "final" ? readDraft(req) : "";

    if (!window || window.length < MIN_DECODE_SAMPLES) {
      sendJson(res, 200, { text: "", samples: total, skipped: true });
      return;
    }

    if (cloud && mode === "final") {
      try {
        const text = await transcribeCloud({
          api: config.cloudAsrApi,
          url: config.cloudAsrUrl,
          model: config.cloudAsrModel,
          apiKey: config.cloudAsrApiKey,
          language: config.cloudAsrLanguage,
          prompt: config.cloudAsrPrompt,
          system: buildSystemPrompt(draft),
          extra: config.cloudAsrExtra,
          samples: window,
          sampleRate: SAMPLE_RATE,
          timeoutMs: config.cloudTimeoutMs,
        });
        sendJson(res, 200, { text: text || "", samples: total, engine: "cloud" });
      } catch (err) {
        const message = String((err && err.message) || err);
        log("warn", `${NS}: 云端识别失败:${message}`);
        if (config.cloudFallbackToLocal && state.engine.ready) {
          try {
            const result = await decode(window);
            sendJson(res, 200, {
              text: polishLocal(result.text || ""),
              ms: result.ms || 0,
              samples: total,
              engine: "local-fallback",
              warn: message,
            });
            return;
          } catch {
            /* 回退也失败,继续走错误分支 */
          }
        }
        sendJson(res, 502, { error: `云端识别失败:${message}` });
      }
      return;
    }

    // 云端模式的实时预览:只发"尾部窗口"(默认 6 秒),拿回中间结果给浮层显示;
    // 松手后的定稿仍然用完整音频 + 完整提示词,所以预览抖动不会污染草稿。
    if (cloud && mode === "interim") {
      if (!config.cloudInterim) {
        sendJson(res, 200, { text: "", samples: total, skipped: true, engine: "cloud" });
        return;
      }
      try {
        const preview = await transcribeCloud({
          api: config.cloudAsrApi,
          url: config.cloudAsrUrl,
          model: config.cloudAsrModel,
          apiKey: config.cloudAsrApiKey,
          language: config.cloudAsrLanguage,
          system: buildSystemPrompt(""),
          extra: config.cloudAsrExtra,
          samples: window,
          sampleRate: SAMPLE_RATE,
          timeoutMs: Math.min(15000, Math.max(2000, Number(config.cloudTimeoutMs) || 15000)),
        });
        sendJson(res, 200, { text: preview || "", samples: total, engine: "cloud-preview" });
      } catch (err) {
        // 预览失败不打扰用户,下一次轮询再试
        sendJson(res, 200, { text: "", samples: total, skipped: true, engine: "cloud-preview" });
      }
      return;
    }

    try {
      const result = await decode(window);
      sendJson(res, 200, { text: polishLocal(result.text || ""), ms: result.ms || 0, samples: total });
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  }

  function handleHealth(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    const url = new URL(req.url || ROUTE, "http://127.0.0.1");
    // 页面挂载时用 prepare=1 让宿主在后台把模型/引擎准备好(不占关键路径)
    if (url.searchParams.get("prepare") === "1" && config.enabled && !state.engine.ready) {
      prepareModel();
    }
    sendJson(res, 200, {
      ok: true,
      enabled: config.enabled,
      model: {
        status: cloudMode(config) ? "ready" : state.model.status,
        progress: state.model.progress,
        file: state.model.file,
        error: state.model.error,
        dir: state.model.dir,
        ready: cloudMode(config) || modelsReady(config),
      },
      engine: { ready: state.engine.ready, error: state.engine.error },
      activeHolds: state.holds.size,
      wordbank: (() => {
        const view = wordbankView();
        return { path: view.path, terms: view.terms, rules: view.rules };
      })(),
      prompt: {
        useDraftContext: Boolean(config.useDraftContext),
        draftContextChars: Number(config.draftContextChars) || 0,
      },
    });
  }

  function wordbankView() {
    try {
      const wb = loadWordbank(config);
      return {
        path: wb.path || wordbankPath(config),
        exists: Boolean(wb.exists),
        text: wb.text || "",
        terms: Array.isArray(wb.terms) ? wb.terms.length : 0,
        rules: Array.isArray(wb.rules) ? wb.rules.length : 0,
        errors: wb.errors || [],
      };
    } catch (err) {
      return { path: wordbankPath(config), exists: false, text: "", terms: 0, rules: 0, errors: [String((err && err.message) || err)] };
    }
  }

  function handleSettingsGet(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      config: publicConfig(config),
      wordbank: wordbankView(),
      runtime: {
        engine: cloudMode(config) ? "cloud" : "local",
        modelReady: cloudMode(config) || state.model.status === "ready",
        localEngineReady: state.engine.ready,
      },
    });
  }

  async function handleSettingsPost(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    let raw;
    try {
      raw = (await readBody(req)).toString("utf8");
    } catch (err) {
      sendJson(res, 413, { error: String((err && err.message) || err) });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, 400, { error: "请求体不是 JSON" });
      return;
    }
    if (!payload || typeof payload !== "object") {
      sendJson(res, 400, { error: "请求体必须是对象" });
      return;
    }

    const errors = [];
    let patch = {};
    if (payload.config && typeof payload.config === "object") {
      const normalized = normalizePatch(payload.config, config);
      if (!normalized.ok) errors.push(...normalized.errors);
      patch = normalized.patch;
    }

    if (Object.keys(patch).length > 0) {
      try {
        saveSettings(patch);
        config = { ...config, ...patch };
      } catch (err) {
        errors.push("设置写入失败:" + String((err && err.message) || err));
      }
    }

    if (typeof payload.wordbank === "string") {
      try {
        saveWordbank(config, payload.wordbank);
      } catch (err) {
        errors.push("词库写入失败:" + String((err && err.message) || err));
      }
    }

    // 语言 / ITN 变了要重建本地 worker
    if (("language" in patch || "useItn" in patch) && state.model.status === "ready" && !cloudMode(config)) {
      try {
        shutdownEngine();
        spawnEngine();
      } catch {
        /* 引擎重建失败会在下一次请求时重试 */
      }
    }

    sendJson(res, 200, {
      ok: errors.length === 0,
      errors,
      config: publicConfig(config),
      wordbank: wordbankView(),
    });
  }

  async function handleSettingsTest(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    let raw;
    try {
      raw = (await readBody(req)).toString("utf8");
    } catch (err) {
      sendJson(res, 413, { error: String((err && err.message) || err) });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, 200, { ok: false, message: "请求体不是 JSON" });
      return;
    }
    const normalized = normalizePatch((payload && payload.config) || {}, config);
    if (!normalized.ok) {
      sendJson(res, 200, { ok: false, message: "配置不合法:" + normalized.errors.join(";") });
      return;
    }
    // 「测试连接」语义就是测云端:即使当前引擎是 local,也按云端候选去测
    const candidate = { ...config, ...normalized.patch, asrEngine: "cloud" };
    if (!cloudConfigured(candidate)) {
      sendJson(res, 200, {
        ok: false,
        message: "还差东西:云端端点为空,或公网端点没有填 API Key。填好再测。",
      });
      return;
    }

    // 1.2 秒静音足够验证"网络 + 鉴权 + 模型名"三件事,不产生真实转写内容
    const samples = new Float32Array(Math.round(SAMPLE_RATE * 1.2));
    const started = Date.now();
    try {
      const text = await transcribeCloud({
        api: candidate.cloudAsrApi,
        url: candidate.cloudAsrUrl,
        model: candidate.cloudAsrModel,
        apiKey: candidate.cloudAsrApiKey,
        language: candidate.cloudAsrLanguage,
        system: buildSystemPrompt("", candidate),
        extra: candidate.cloudAsrExtra,
        samples,
        sampleRate: SAMPLE_RATE,
        timeoutMs: Math.min(20000, Math.max(3000, Number(candidate.cloudTimeoutMs) || 20000)),
      });
      const ms = Date.now() - started;
      const tail = text ? " · 静音测试返回:" + text.slice(0, 40) : " · 静音测试未返回文字(正常)";
      sendJson(res, 200, { ok: true, ms, message: "连接成功(" + ms + "ms)" + tail });
    } catch (err) {
      const detail = String((err && err.message) || err);
      sendJson(res, 200, {
        ok: false,
        ms: Date.now() - started,
        message: explainTestError(detail),
        detail: detail.slice(0, 300),
      });
    }
  }

  function handleSettings(req, res) {
    if (req.method === "GET") {
      handleSettingsGet(req, res);
      return;
    }
    if (req.method === "POST") {
      return handleSettingsPost(req, res).catch((err) =>
        sendJson(res, 500, { error: String((err && err.message) || err) }),
      );
    }
    sendJson(res, 405, { error: "只接受 GET / POST" });
  }

  function handleConfig(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    // 只暴露浏览器半身需要的字段
    sendJson(res, 200, {
      enabled: config.enabled,
      holdThresholdMs: config.holdThresholdMs,
      cancelSlidePx: config.cancelSlidePx,
      interimIntervalMs: config.interimIntervalMs,
      minHoldMs: config.minHoldMs,
      maxHoldMs: config.maxHoldMs,
      autoSend: config.autoSend,
      asrEngine: cloudMode(config) ? "cloud" : "local",
      // 浏览器半身据此决定松手时要不要读输入框草稿
      useDraftContext: Boolean(config.useDraftContext),
      draftContextChars: Number(config.draftContextChars) || 0,
      // 浏览器半身按这个间隔发 PCM 做实时预览:
      //   本地 → interimIntervalMs;云端开了预览 → cloudInterimIntervalMs;云端关预览 → 基本不轮询
      interimIntervalMs: cloudMode(config)
        ? config.cloudInterim
          ? Math.max(800, Number(config.cloudInterimIntervalMs) || 2000)
          : 3600000
        : config.interimIntervalMs,
      cloudInterim: cloudMode(config) ? Boolean(config.cloudInterim) : false,
    });
  }

  // host 侧路由靠 webServer 服务;它可能晚于本插件就绪,用 ctx.inject 等它就位
  ctx.inject(["webServer"], (serverCtx) => {
    const routes = [
      { kind: "exact", path: `${ROUTE}/asr`, handler: handleAsr },
      { kind: "exact", path: `${ROUTE}/health`, handler: handleHealth },
      { kind: "exact", path: `${ROUTE}/config`, handler: handleConfig },
      { kind: "exact", path: `${ROUTE}/settings`, handler: handleSettings },
      { kind: "exact", path: `${ROUTE}/settings/test`, handler: handleSettingsTest },
    ];
    for (const route of routes) {
      try {
        serverCtx.webServer.register(route);
      } catch (err) {
        log("warn", `${NS}: 路由注册失败 ${route.path}:${String((err && err.message) || err)}`);
      }
    }
    log("info", `${NS}: 路由已注册 (${ROUTE})`);
  });

  if (modelsReady(config)) {
    // 只标记就绪,不在这里预热引擎:启动时加载 228MB 模型要多花 ~3.5 秒并常驻
    // ~250MB 内存。改由页面挂载时的 /health?prepare=1 在后台预热。
    state.model.status = "ready";
    state.model.progress = 1;
  }

  ctx.effect(() => () => {
    shutdownEngine();
    state.holds.clear();
  }, `${NS}.teardown`);
}
