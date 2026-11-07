/**
 * dsh-hold-to-talk-plus · 设置存储
 *
 * 两层配置:
 *   1) cordis 配置(插件条目 config / profile 的 cordis.patch.yml)—— 部署默认值
 *   2) 本文件(~/.dsh/hold-to-talk/settings.json)—— 设置页写入的用户覆盖,优先级更高
 *
 * 这样 UI 改完立即生效、不用重启 DSH;YAML 仍然是"出厂默认 + 高级项"的家。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 设置页可写的字段(其余字段只在 YAML 里配) */
export const UI_FIELDS = [
  "asrEngine",
  "cloudAsrApi",
  "cloudAsrUrl",
  "cloudAsrModel",
  "cloudAsrApiKey",
  "cloudAsrLanguage",
  "cloudAsrPrompt",
  "cloudFallbackToLocal",
  "cloudInterim",
  "cloudInterimIntervalMs",
  "useDraftContext",
  "draftContextChars",
  "wordbankApplyToLocal",
  "language",
  "useItn",
  "autoSend",
];

const ENUMS = {
  asrEngine: ["local", "cloud"],
  cloudAsrApi: ["transcriptions", "chat-audio"],
  language: ["auto", "zh", "en", "ja", "ko", "yue"],
};

const NUMBERS = {
  draftContextChars: [0, 3000],
  promptMaxChars: [0, 4000],
  cloudInterimIntervalMs: [800, 10000],
};

const BOOLEANS = [
  "cloudFallbackToLocal",
  "cloudInterim",
  "useDraftContext",
  "wordbankApplyToLocal",
  "useItn",
  "autoSend",
];

export function settingsFilePath() {
  // 允许用环境变量指到别处(测试/多实例)
  const custom = typeof process.env.HOLD_TO_TALK_SETTINGS_FILE === "string" ? process.env.HOLD_TO_TALK_SETTINGS_FILE.trim() : "";
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), ".dsh", "hold-to-talk", "settings.json");
}

/**
 * 读取用户覆盖(损坏时返回空对象,不阻塞插件)。
 * @returns {object}
 */
export function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 校验 + 归一化一个补丁。
 * @param {object} patch 来自设置页的字段
 * @param {object} current 当前生效配置(用于保持未提交字段)
 * @returns {{ok: boolean, patch: object, errors: string[]}}
 */
export function normalizePatch(patch, current = {}) {
  const out = {};
  const errors = [];
  if (!patch || typeof patch !== "object") return { ok: false, patch: out, errors: ["补丁不是对象"] };

  for (const key of UI_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];

    if (key === "cloudAsrApiKey") {
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") {
        errors.push("cloudAsrApiKey 必须是字符串");
        continue;
      }
      if (value.trim() === "") {
        out[key] = "";
      } else if (value.length > 4096) {
        errors.push("cloudAsrApiKey 过长");
      } else {
        out[key] = value.trim();
      }
      continue;
    }

    if (ENUMS[key]) {
      if (!ENUMS[key].includes(value)) {
        errors.push(`${key} 只能是 ${ENUMS[key].join(" / ")}`);
        continue;
      }
      out[key] = value;
      continue;
    }

    if (NUMBERS[key]) {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push(`${key} 必须是数字`);
        continue;
      }
      const [min, max] = NUMBERS[key];
      out[key] = Math.max(min, Math.min(max, Math.round(n)));
      continue;
    }

    if (BOOLEANS.includes(key)) {
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(v)) out[key] = true;
        else if (["false", "0", "no", "off", ""].includes(v)) out[key] = false;
        else errors.push(key + " 必须是布尔值");
      } else {
        out[key] = Boolean(value);
      }
      continue;
    }

    if (typeof value !== "string") {
      errors.push(`${key} 必须是字符串`);
      continue;
    }
    const trimmed = value.trim();
    if (key === "cloudAsrUrl" && trimmed !== "") {
      let u = null;
      try {
        u = new URL(trimmed);
      } catch {
        errors.push("cloudAsrUrl 不是合法 URL");
        continue;
      }
      if (!/^https?:$/.test(u.protocol)) {
        errors.push("cloudAsrUrl 必须是 http(s)");
        continue;
      }
    }
    out[key] = trimmed;
  }

  if (out.cloudAsrLanguage !== undefined && out.cloudAsrLanguage !== "auto" && !/^[a-z]{2}(-[A-Za-z]{2,})?$/.test(out.cloudAsrLanguage)) {
    errors.push("cloudAsrLanguage 看起来不是语言代码");
  }
  if (out.cloudAsrModel !== undefined && out.cloudAsrModel.length > 200) errors.push("cloudAsrModel 过长");
  if (out.cloudAsrPrompt !== undefined && out.cloudAsrPrompt.length > 4000) errors.push("cloudAsrPrompt 过长");

  return { ok: errors.length === 0, patch: out, errors };
}

/** 原子写设置文件 */
export function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  const file = settingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return merged;
}

/** 给设置页看的脱敏视图 */
export function publicConfig(config) {
  return {
    asrEngine: config.asrEngine,
    cloudAsrApi: config.cloudAsrApi,
    cloudAsrUrl: config.cloudAsrUrl,
    cloudAsrModel: config.cloudAsrModel,
    cloudAsrApiKeySet: Boolean(typeof config.cloudAsrApiKey === "string" && config.cloudAsrApiKey.trim()),
    cloudAsrLanguage: config.cloudAsrLanguage,
    cloudAsrPrompt: config.cloudAsrPrompt || "",
    cloudFallbackToLocal: Boolean(config.cloudFallbackToLocal),
    cloudInterim: config.cloudInterim !== false,
    cloudInterimIntervalMs: Number(config.cloudInterimIntervalMs) || 2000,
    useDraftContext: Boolean(config.useDraftContext),
    draftContextChars: Number(config.draftContextChars || 0),
    wordbankApplyToLocal: Boolean(config.wordbankApplyToLocal),
    language: config.language,
    useItn: Boolean(config.useItn),
    autoSend: Boolean(config.autoSend),
    settingsFile: settingsFilePath(),
  };
}