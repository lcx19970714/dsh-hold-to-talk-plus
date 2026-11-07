/**
 * dsh-hold-to-talk-plus · 第三方 ASR 转发
 *
 * 把宿主收到的 16k 单声道 f32 PCM 编码成 WAV,再按两种协议之一发给第三方:
 *
 *  1. api = "transcriptions"(默认)
 *     OpenAI 兼容 `POST /v1/audio/transcriptions`,multipart 上传 audio.wav。
 *     适用于:硅基流动、Groq、whisper.cpp server、faster-whisper-server、
 *             qwen3-asr-service 的 OpenAI 兼容层、各种 one-api/new-api 网关。
 *
 *  2. api = "chat-audio"
 *     OpenAI 兼容 `POST .../chat/completions`,把音频以 base64 data URI 放进
 *     messages[].content[].input_audio,由模型直接输出转写文本。
 *     适用于:阿里云百炼 qwen3-asr-flash / fun-asr(compatible-mode)、
 *             OpenRouter 等只提供 chat 接口的音频大模型。
 *
 * 只做编码 + 转发:不重试、不落盘、不写日志里的原文。
 */

const SAMPLE_RATE = 16000;

/**
 * f32 [-1,1] PCM → 16-bit 单声道 WAV。
 * @param {Float32Array|ArrayLike<number>} samples
 * @param {number} [sampleRate]
 * @returns {Buffer}
 */
export function pcmToWav(samples, sampleRate = SAMPLE_RATE) {
  const n = samples ? samples.length : 0;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (typeof s !== "number" || !Number.isFinite(s)) s = 0;
    if (s < -1) s = -1;
    else if (s > 1) s = 1;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** 从各种 OpenAI 兼容响应里抠出文本 */
export function extractText(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload !== "object") return "";

  // chat/completions
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (choice) {
    const content = choice.message ? choice.message.content : choice.text;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => {
          if (!part) return "";
          if (typeof part === "string") return part;
          if (typeof part.text === "string") return part.text;
          if (part.type === "output_text" && typeof part.output_text === "string") return part.output_text;
          return "";
        })
        .join("");
      if (joined.trim()) return joined.trim();
    }
  }

  // transcriptions / 各家变体
  for (const key of ["text", "transcription", "result", "sentence"]) {
    if (typeof payload[key] === "string") return payload[key].trim();
  }
  if (Array.isArray(payload.segments)) {
    return payload.segments
      .map((seg) => (seg && typeof seg.text === "string" ? seg.text : ""))
      .join("")
      .trim();
  }
  const data = payload.data;
  if (data && typeof data.text === "string") return data.text.trim();
  if (data && typeof data.transcription === "string") return data.transcription.trim();
  if (Array.isArray(data)) {
    return data
      .map((seg) => (seg && typeof seg.text === "string" ? seg.text : ""))
      .join("")
      .trim();
  }
  if (payload.output && typeof payload.output.text === "string") return payload.output.text.trim();
  return "";
}

async function post(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const raw = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
    if (!res.ok) {
      const detail = typeof payload === "string" ? payload.slice(0, 300) : JSON.stringify(payload).slice(0, 300);
      throw new Error(`HTTP ${res.status} ${detail}`.trim());
    }
    return { payload, raw };
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error(`云端识别超时(${timeoutMs}ms)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 协议一:OpenAI 兼容 /audio/transcriptions(multipart) */
async function viaTranscriptions({ url, model, apiKey, language, prompt, system, wav, timeoutMs }) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  if (model) form.append("model", model);
  if (language && language !== "auto") form.append("language", language);
  // OpenAI 兼容端点的 prompt 字段:术语表 + 草稿上下文都塞这里(各家上限不同,已在上层截断)
  const promptText = [system, prompt].filter((x) => x && String(x).trim()).join("\n");
  if (promptText) form.append("prompt", promptText);
  form.append("response_format", "json");
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const { payload, raw } = await post(url, { method: "POST", headers, body: form }, timeoutMs);
  const text = extractText(payload);
  return text || (typeof payload === "string" ? raw.trim() : "");
}

/** 协议二:OpenAI 兼容 chat/completions + input_audio(base64 data URI) */
async function viaChatAudio({ url, model, apiKey, language, prompt, system, extra, wav, timeoutMs }) {
  const dataUri = `data:audio/wav;base64,${wav.toString("base64")}`;
  const content = [{ type: "input_audio", input_audio: { data: dataUri, format: "wav" } }];
  const messages = [];
  // 百炼:system message 必须是 messages[0],且 content 必须是数组;字符串形式会被 asr 任务判为
  // "does not support this input"(实测 400),数组形式才放行(实测 200)。
  if (system && String(system).trim()) {
    messages.push({ role: "system", content: [{ type: "text", text: String(system).trim() }] });
  }
  messages.push({ role: "user", content });
  const body = {
    model,
    messages,
    stream: false,
    ...(extra && typeof extra === "object" ? extra : {}),
  };

  if (language && language !== "auto") {
    // 百炼方言/语种提示放在 asr_options;其他网关会忽略未知字段
    body.asr_options = { ...(body.asr_options || {}), language };
  }
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const { payload } = await post(url, { method: "POST", headers, body: JSON.stringify(body) }, timeoutMs);
  return extractText(payload);
}

/**
 * 把一段 PCM 送到第三方识别。
 * @param {object} opts
 * @param {"transcriptions"|"chat-audio"} [opts.api]
 * @param {string} opts.url 完整端点
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey] Bearer token
 * @param {string} [opts.language] 语言提示;auto 时不发送
 * @param {string} [opts.prompt] 上下文/热词提示(并入 transcriptions 的 prompt 字段)
 * @param {string} [opts.system] 背景/术语表;chat-audio 下作为 system message,transcriptions 下并入 prompt
 * @param {object} [opts.extra] chat-audio 模式下额外并入 body 的字段
 * @param {Float32Array} opts.samples 16k mono f32
 * @param {number} [opts.sampleRate]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}
 */
export async function transcribeCloud({
  api = "transcriptions",
  url,
  model,
  apiKey,
  language,
  prompt,
  system,
  extra,
  samples,
  sampleRate = SAMPLE_RATE,
  timeoutMs = 30000,
} = {}) {
  const endpoint = typeof url === "string" ? url.trim() : "";
  if (!endpoint) throw new Error("未配置 cloudAsrUrl");

  const wav = pcmToWav(samples, sampleRate);
  const args = { url: endpoint, model, apiKey, language, prompt, system, extra, wav, timeoutMs };
  return inferApi(endpoint, api) === "chat-audio" ? viaChatAudio(args) : viaTranscriptions(args);
}

/**
 * 按端点 URL 纠正协议,避免"URL 填的是 chat/completions、协议却选了 transcriptions"这种
 * 必然 400 的组合(百炼会回 Required body invalid)。
 * @param {string} url
 * @param {string} api
 * @returns {"chat-audio"|"transcriptions"}
 */
export function inferApi(url, api) {
  const u = String(url || "").toLowerCase();
  if (u.includes("/chat/completions")) return "chat-audio";
  if (u.includes("/audio/transcriptions")) return "transcriptions";
  return api === "chat-audio" ? "chat-audio" : "transcriptions";
}

/** 云端模式是否已配置可用 */
export function cloudConfigured(config) {
  if (!config || config.asrEngine !== "cloud") return false;
  const url = typeof config.cloudAsrUrl === "string" ? config.cloudAsrUrl.trim() : "";
  if (!url) return false;
  const key = typeof config.cloudAsrApiKey === "string" ? config.cloudAsrApiKey.trim() : "";
  if (key) return true;
  // 没填 key:只放行本机端点(自建 faster-whisper / FunASR),其余视为未配置 -> 继续用本地
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}