/**
 * dsh-hold-to-talk-plus · 用户词库
 *
 * 文件位置(默认):~/.dsh/hold-to-talk/words.txt
 *
 * 格式(每行一条,# 开头为注释):
 *   DeepSeek                       ← 纯词条:只作为"术语表"发给云端模型,提高这些词的识别率
 *   Qwen3-ASR
 *   可达鸭=可达丫|可达压             ← 纠正规则:本地/云端结果里把右边的错写替换成左边的正确写法
 *   张总=张肿|张种
 *
 * 纯词条用于云端 glossary(百炼的 system message 支持背景文本/实体表);
 * 纠正规则同时用于本地 SenseVoice 的定稿后处理(本地模型不支持热词)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_FILE = "words.txt";

/** 词库文件绝对路径 */
export function wordbankPath(config = {}) {
  const custom = typeof config.wordbankPath === "string" ? config.wordbankPath.trim() : "";
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), ".dsh", "hold-to-talk", DEFAULT_FILE);
}

/**
 * 解析词库文本。
 * @param {string} text
 * @returns {{terms: string[], rules: Array<{correct: string, wrong: string[]}>, errors: string[]}}
 */
export function parseWordbank(text) {
  const terms = [];
  const rules = [];
  const errors = [];
  const seen = new Set();

  const pushTerm = (word) => {
    const w = word.trim();
    if (!w || w.startsWith("#")) return;
    if (w.length > 64) {
      errors.push(`词条过长(>64):${w.slice(0, 20)}…`);
      return;
    }
    if (seen.has(w)) return;
    seen.add(w);
    terms.push(w);
  };

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) {
      pushTerm(line);
      continue;
    }
    const correct = line.slice(0, eq).trim();
    const wrongRaw = line.slice(eq + 1).trim();
    if (!correct || !wrongRaw) {
      errors.push(`规则格式不对:${line.slice(0, 30)}`);
      continue;
    }
    const wrong = wrongRaw
      .split("|")
      .map((w) => w.trim())
      .filter((w) => w && w !== correct);
    if (wrong.length === 0) {
      errors.push(`规则没有错写形式:${line.slice(0, 30)}`);
      continue;
    }
    if (correct.length > 64) {
      errors.push(`规则正确写法过长:${correct.slice(0, 20)}…`);
      continue;
    }
    // 同一正确写法合并
    const existing = rules.find((r) => r.correct === correct);
    if (existing) {
      for (const w of wrong) if (!existing.wrong.includes(w)) existing.wrong.push(w);
    } else {
      rules.push({ correct, wrong });
    }
    // 正确词本身也进术语表(云端能念得更准)
    if (!seen.has(correct)) {
      seen.add(correct);
      terms.push(correct);
    }
  }

  return { terms, rules, errors };
}

/** 词库的 mtime+size 缓存,外部改文件后下次请求自动生效 */
const cache = { file: "", mtimeMs: 0, size: -1, parsed: null };

/**
 * 读取并解析词库(带缓存)。
 * @param {object} config
 * @returns {{path: string, exists: boolean, text: string, terms: string[], rules: Array, errors: string[]}}
 */
export function loadWordbank(config = {}) {
  const file = wordbankPath(config);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }

  let text = "";
  if (stat) {
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      return { path: file, exists: true, text: "", terms: [], rules: [], errors: [`读取失败:${err.message}`] };
    }
  }

  const inline = typeof config.wordbankInline === "string" ? config.wordbankInline : "";
  const combinedText = [text, inline].filter(Boolean).join("\n");
  const mtimeMs = stat ? stat.mtimeMs : 0;
  const size = stat ? stat.size : -1;

  if (cache.file === file && cache.mtimeMs === mtimeMs && cache.size === size && cache.inline === inline && cache.parsed) {
    return { ...cache.parsed, path: file, exists: Boolean(stat), text: combinedText };
  }

  const parsed = parseWordbank(combinedText);
  cache.file = file;
  cache.mtimeMs = mtimeMs;
  cache.size = size;
  cache.inline = inline;
  cache.parsed = parsed;
  return { path: file, exists: Boolean(stat), text: combinedText, ...parsed };
}

/** 写词库文件(建目录) */
export function saveWordbank(config = {}, text = "") {
  const file = wordbankPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text || ""), "utf8");
  cache.mtimeMs = 0;
  cache.size = -1;
  return file;
}

/** 按纠正规则替换(长词优先,避免"张总"被"张"之类短规则拆掉) */
export function applyRules(text, rules) {
  if (!text || !Array.isArray(rules) || rules.length === 0) return text;
  let out = text;
  const pairs = [];
  for (const rule of rules) {
    for (const wrong of rule.wrong) pairs.push([wrong, rule.correct]);
  }
  // 长错写优先
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [wrong, correct] of pairs) {
    if (!wrong) continue;
    out = out.split(wrong).join(correct);
  }
  return out;
}

/** 术语表拼成一行,受字符上限约束 */
export function glossaryText(terms, maxChars = 600) {
  if (!Array.isArray(terms) || terms.length === 0) return "";
  const out = [];
  let used = 0;
  for (const t of terms) {
    const cost = t.length + 1;
    if (used + cost > maxChars) break;
    out.push(t);
    used += cost;
  }
  return out.join("、");
}