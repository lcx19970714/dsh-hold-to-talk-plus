# DSH 鼠标按住语音输入（+ 第三方 ASR + 用户词库 + 输入框上下文）

这是 `dsh-hold-to-talk@0.1.4` 的本地改写版，安装在本目录，已通过 `mklink /J` 挂进 DSH 的 desktop profile。

手势、浮层、边说边出字、上滑取消、60 秒自动定稿、Esc 取消——全部与上游一致，一行没改。增强的是识别这一层：

| 能力 | 上游 0.1.4 | 本版 |
|---|---|---|
| 本地 SenseVoice | ✅ | ✅ |
| 第三方云端 ASR（OpenAI 兼容 / 百炼 chat-audio） | ❌ | ✅ |
| 用户词库（术语表 + 纠错规则） | ❌ | ✅ |
| 输入框已有草稿作为上下文提示词 | ❌ | ✅ |
| 设置页面（设置 → 语音输入） | ❌ | ✅ |
| 云端失败回退本地 | ❌ | ✅ |
| **云端实时预览（边说边出字，松手再定稿）** | ❌ | ✅ |

---

## 1. 现在的安装状态

| 项目 | 位置 |
|---|---|
| 插件本体 | `H:\DSH-鼠标语音输入\`（本目录） |
| profile 依赖 | `C:\Users\main\.dsh\profiles\desktop\package.json` → `"dsh-hold-to-talk": "link:H:/DSH-鼠标语音输入"` |
| node_modules 入口 | `…\node_modules\dsh-hold-to-talk` → 指向本目录的 junction（原 npm 版已删除，备份在工作区 `backup\dsh-hold-to-talk-0.1.4`） |
| 部署默认配置 | `…\profiles\desktop\cordis.patch.yml` 里的 `- id: dsh-hold-to-talk` 段 |
| **用户设置（设置页写入）** | `C:\Users\main\.dsh\hold-to-talk\settings.json`（优先级高于 YAML） |
| **用户词库** | `C:\Users\main\.dsh\hold-to-talk\words.txt` |
| 本地模型缓存 | `C:\Users\main\.dsh\hold-to-talk\models\`（228MB，仍复用） |

> 改代码或 YAML 后要**完全退出 DSH（托盘右键退出）再打开**；设置页里改的东西是**热生效**的，不用重启。

---

## 2. 设置页面（设置 → 语音输入）

DSH 0.2.x 的设置页支持插件注册自己的页面（`settings.section` 槽位）。本插件注册了一个**「语音输入」**页，在设置弹窗左侧导航里。

页面按「一件事一步」排列，从上到下四步：

| 步骤 | 内容 |
|---|---|
| ① 选服务商 | 一排胶囊按钮：**阿里云百炼（中文最准）** / **硅基流动（免费）** / **自建**。点一下自动填好端点、模型、协议、语言，并展开取 Key 引导 |
| ② 填端点与 Key | 引擎/协议/语言/端点/模型 ID 网格排布；API Key 是密码框，已保存时只显示"已保存，留空不变" |
| ③ 测试连接 | 不用先保存：发 1.2 秒静音验证「网络 + 鉴权 + 模型名」，把 401/403/404/429/超时翻译成中文人话，并显示原始返回 |
| ④ 上下文与词库 | 草稿上下文开关 + 字符数、**云端实时预览开关 + 间隔**、云端回退、本地套用规则、用户词库大文本框（显示词条/规则数、文件路径） |

底部固定一条保存栏：`保存` + 「有未保存的修改」提示 + 行内结果。顶部右上角是一个状态胶囊（`本地 SenseVoice` / `云端 · 已配置` / `云端 · 待填 Key`）。

**取 Key 引导**：默认折叠；第一次进来（本机还没存过 Key）会自动展开。引导按当前选中的服务商给 3~5 步，每步带「打开」外链（控制台 / API-KEY 管理页），并标注计费参考。比如百炼：登录 → 实名 → 开通 Qwen3-ASR-Flash → 控制台「API-KEY 管理」创建 → 粘贴 → 测试。

保存后写入 `~/.dsh/hold-to-talk/settings.json`，**下一次长按立即生效**（本地 worker 只在语言/ITN 变化时重建）。

> 注意：设置页写入的字段会覆盖 `cordis.patch.yml` 里的同名字段（YAML 当作"出厂默认 + 高级项"）。想回到 YAML 的值，在设置页把它改回去，或删掉 `settings.json` 里对应键。
>
> 引导里的外链是各厂商控制台的常用入口，改版了以官网为准；点「打开」会在新标签页打开。

---

## 3. 提示词 / 用户词库 / 输入框上下文

### 3.1 用户词库 `~/.dsh/hold-to-talk/words.txt`

```
# 每行一个词,# 开头是注释

# 纯词条 → 作为"术语表"发给云端模型,提高识别率(本地模型不支持热词)
DeepSeek
DeepSeek Harness
Qwen3-ASR

# 纠正规则 → 结果里把错写替换成正确写法(本地/云端都生效)
可达鸭=可达丫|可达压
张总=张肿|张种
```

- 术语表上限 400 字符左右（自动截断），拼进提示词。
- 纠正规则是**字面替换**，长错写优先匹配（"可达丫"先于"可达"）。
- 文件改了**下一次长按自动生效**（mtime 缓存刷新），不用重启。

### 3.2 输入框草稿作为上下文

松手那一刻，插件会读输入框里已有的文字（最多 `draftContextChars` 个字符，默认 300），随请求发给本机宿主，再拼进提示词：

```
以下是这次语音听写的参考信息,只用于提高识别和用词准确度;不要在输出里复述或解释它们。
术语表(请优先按这些写法输出):DeepSeek、DeepSeek Harness、Qwen3-ASR
用户正在输入框里编辑的内容(只用来理解语境和专有名词,不要复述、不要续写):<你已输入的草稿末尾>
```

草稿通过请求头 `x-htt-draft`（base64url）传给**自己的本机路由**，不出本机；只有最终发往云端的那一次请求才会带上它。关掉「把输入框已有内容当上下文」就完全不读、不发。

### 3.3 云端协议怎么用这段提示词

| 协议 | 提示词落到哪里 | 实测效果 |
|---|---|---|
| `chat-audio`（百炼） | `messages[0] = {role:"system", content:[{type:"text",text:<提示词>}]}` | 数组形式必收；**指令类提示不生效**，术语表作为上下文（静音时会吐出词库词）。别指望它大幅纠错 |
| `transcriptions`（OpenAI 兼容） | 表单字段 `prompt` | whisper 系会吃；硅基流动/Groq 接受；部分网关忽略 |

> 结论：**提示词是锦上添花，词库纠错规则才是可控的准确率抓手**（它不依赖服务商，本地/云端都生效）。词库写法见 3.1。

---

## 4. 第三方 ASR 配置

可以在**设置页**填，也可以直接改 `cordis.patch.yml`。设置页优先。

### 4.1 阿里云百炼 Qwen3-ASR-Flash（当前默认，中文最准一档）

```
cloudAsrUrl: https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
cloudAsrModel: qwen3-asr-flash
cloudAsrApi: chat-audio
cloudAsrExtra: { asr_options: { enable_itn: true } }
cloudAsrLanguage: zh
cloudAsrApiKey: sk-xxx
```

- 请求体已按[官方文档](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference)核过，并用真实 key 实测：
  `{model, messages:[{role:"system",content:[{type:"text",text:...}]},{role:"user",content:[{type:"input_audio",input_audio:{data:"data:audio/wav;base64,...",format:"wav"}}]}], stream:false, asr_options:{language, enable_itn}}`
- **实测三条硬结论**（2026-11-07，真实 key）：
  1. `system.content` 必须是**数组** `[{type:"text",text:"..."}]`；写成字符串会被 asr 任务判为 `does not support this input` → 400。
  2. **协议与端点必须匹配**：`/chat/completions` 走 JSON（chat-audio），`/audio/transcriptions` 走 multipart。配错会得到 `HTTP 400 Required body invalid`。现在已经会按 URL 自动纠正，选错也不会再 400。
  3. system 里的**指令类提示不生效**（"输出繁体"实测无效）；术语表会被当作上下文收下（静音测试时模型甚至会吐出词库里的词）。所以**别指望提示词大幅纠错，真正稳的是下面 3.1 的词库纠错规则**。
- 新控制台若给了业务空间专属域名，把 `dashscope.aliyuncs.com` 换成 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`（官方说旧域名仍可用）。
- 音频上限 10MB（base64 后）；单次最长 60 秒 ≈ 1.9MB，安全。

### 4.2 硅基流动（免费，OpenAI 兼容）

```
cloudAsrUrl: https://api.siliconflow.cn/v1/audio/transcriptions
cloudAsrModel: TeleAI/TeleSpeechASR      # 或 FunAudioLLM/SenseVoiceSmall
cloudAsrApi: transcriptions
cloudAsrApiKey: sk-xxx
```

### 4.3 自建（faster-whisper-server / whisper.cpp / FunASR 网关 / one-api）

```
cloudAsrUrl: http://127.0.0.1:8000/v1/audio/transcriptions
cloudAsrModel: whisper-large-v3
cloudAsrApi: transcriptions
cloudAsrApiKey: ""        # 本机端点可以不要 key
```

### 4.4 不想把 key 写进文件

DSH 的 patch 层支持 `!!js`：

```yaml
cloudAsrApiKey: !!js process.env.DASHSCOPE_API_KEY
```

（设置页保存的 key 存在 `settings.json`，明文，仅本机。）

---

## 5. 全部配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `asrEngine` | `local` | `local` 本地；`cloud` 第三方（端点为空、或公网端点没填 key 时自动按 local 处理） |
| `cloudAsrUrl` / `cloudAsrModel` / `cloudAsrApiKey` | `""` | 端点 / 模型 / 密钥 |
| `cloudAsrApi` | `transcriptions` | `transcriptions` = multipart `/audio/transcriptions`；`chat-audio` = chat + input_audio |
| `cloudAsrExtra` | `{}` | 仅 chat-audio：额外并入请求体的字段（如 `asr_options.enable_itn`） |
| `cloudAsrLanguage` | `zh` | 语言提示；`auto` = 不发该字段 |
| `cloudAsrPrompt` | `""` | 额外提示词（会拼在术语表/草稿之后） |
| `cloudTimeoutMs` | `30000` | 云端超时 |
| `cloudFallbackToLocal` | `true` | 云端失败回退本地 |
| `cloudInterim` | `true` | 云端模式也做实时预览（边说边出字） |
| `cloudInterimIntervalMs` | `2000` | 云端预览轮询间隔（毫秒，800~10000） |
| `useDraftContext` | `true` | 把输入框草稿当上下文 |
| `draftContextChars` | `300` | 草稿取末尾多少字符（0 = 不取） |
| `wordbankPath` | `""` | 词库文件；空 = `~/.dsh/hold-to-talk/words.txt` |
| `wordbankInline` | `""` | 直接写在配置里的词条（换行分隔） |
| `wordbankApplyToLocal` | `true` | 本地结果套用纠错规则 |
| `promptMaxChars` | `800` | 提示词总长度上限 |
| `language` | `auto` | 本地 SenseVoice 语言：auto/zh/en/ja/ko/yue |
| `useItn` | `true` | 逆文本规整（"二零二六"→"2026"） |
| `numThreads` | `2` | 本地推理线程 |
| `holdThresholdMs` / `cancelSlidePx` | `400` / `60` | 按住判定 / 上滑取消 |
| `minHoldMs` / `maxHoldMs` | `250` / `60000` | 过短丢弃 / 到点定稿 |
| `autoSend` | `false` | 定稿后自动发送 |

---

## 6. 行为细节

### 6.1 实时预览（先说结论：两种引擎都能"边说边出字"）

| 引擎 | 预览怎么来的 | 实测延迟 | 费用 |
|---|---|---|---|
| 本地 SenseVoice | 每 1.5 秒对尾部窗口重解码一次 | ~0.9 秒/次 | 0 |
| **云端**（v5 新增） | 每 `cloudInterimIntervalMs`（默认 2000ms）把**最近 ≤6 秒**的音频重发一次，拿回中间结果 | **400~500ms/次** | 每次按音频秒数计费，一次 7 秒口述约多花 0.004 元 |

实测（真实 key，6.9 秒语音）：

```
[预览#1] 501ms  "我们今天下午三点开。"                    (已录 2.0s)
[预览#2] 391ms  "我们今天下午三点开会讨论语音输入。"       (已录 4.0s)
[预览#3] 437ms  "我们今天下午三点开会，讨论语音输入插件的实时预览功能。" (已录 6.0s)
[定稿]   433ms  "我们今天下午三点开会，讨论语音输入插件的实时预览功能。"
```

- 预览只画在浮层里，**绝不回写输入框**；松手后用**完整音频 + 完整提示词**再识别一次，作为定稿写进草稿。
- 预览请求只带术语表，不带草稿（省 token、也避免草稿变化导致预览跳变）。
- 关闭：设置页「云端也做实时预览」取消勾选，或 `cloudInterim: false`（此时云端模式基本不轮询，只在松手时识别一次）。

### 6.2 百炼还有两种"更实时"的接口（未接，按需可选）

1. **`stream: true`**（同一次请求内部 token 流）：能比整段返回更早出字，但音频还是要先发完，**对"边说边出"帮助有限**，实现上要解析 SSE。
2. **`qwen3-asr-flash-realtime`（WebSocket 真流式）**：边录边发 PCM、服务端持续回中间结果，延迟最低；单价约 1.188 元/小时（比非实时贵 ~50%），需要宿主侧接 WS + 客户端双工。**如果你要"字幕级"实时体验，我可以接这条。**

### 6.3 其他行为

- **云端模式不下载/不加载 228MB 模型**，`/health` 直接报就绪。
- **定稿**永远用完整录音。
- **回退**：云端超时/401/断网 → 自动用本地 SenseVoice 出字，结果标 `engine: "local-fallback"`。
- **本地后处理**：定稿文字按词库规则替换（如"可达丫"→"可达鸭"）。
- 设置页改语言/ITN 会重建本地 worker，其他设置即时生效。

---

## 7. 验证与排错

1. 完全退出 DSH → 重新打开。
2. 设置 → 语音输入：应能看到整页配置，顶部显示当前引擎。
3. 输入框按住 400ms 说话 → 浮层 → 松手出字。
4. **先用页面里的「测试连接」**：不必保存就能验证 Key；失败时会告诉你属于哪类问题（Key 错 / 未实名或未开通 / 端点或模型名错 / 限流 / 超时 / DNS）。想手动验证回退，把 key 写错后按住说话，应看到 `云端识别失败:HTTP 401` 且仍由本地出字。
5. 想验证提示词：在输入框先打"我们讨论 DeepSeek Harness 的语音输入"，再说含这些词的句子，看识别是否更贴。

**常见报错对照**

| 现象 | 原因 | 处理 |
|---|---|---|
| `HTTP 400 Required body invalid` | 协议与端点不匹配（`/chat/completions` 配了 `transcriptions`） | 已按 URL 自动纠正；重启 DSH 后重试即可 |
| `HTTP 400 ... does not support this input` | 把提示词写成了字符串形式的 system message | 已改成数组形式；仍有问题就先清空词库重试 |
| `HTTP 401` | Key 错/失效 | 重新复制，注意别带空格换行 |
| `HTTP 403` | 未实名 / 未开通 qwen3-asr-flash | 控制台开通模型 |
| `HTTP 404` | 端点或模型名错 | 检查 URL 路径与模型 ID |

> 实测记录（2026-11-07，真实 key）：协议错配会稳定复现 `Required body invalid`；改成 chat JSON 后，2 秒真实语音转写为「把这段语音识别出来，写到输入框里。」，耗时约 0.5~0.6 秒；静音测试返回词库里的术语属于正常现象。

本目录自带测试（用 DSH 自带 node 跑）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "C:\Users\main\Documents\deepseek-harness\default-workspace\research\test-installed.mjs"
& $node "C:\Users\main\Documents\deepseek-harness\default-workspace\research\test-prompt-wordbank.mjs"
& $node "C:\Users\main\Documents\deepseek-harness\default-workspace\research\test-client-settings.mjs"
```

---

## 8. 回滚 / 卸载

**只停用云端**：设置页把引擎改成「本地」，或把 `cloudAsrUrl` 清空。

**完全回滚到上游 npm 版**：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
cmd /c rmdir "$p\node_modules\dsh-hold-to-talk"
Copy-Item "C:\Users\main\Documents\deepseek-harness\default-workspace\backup\dsh-hold-to-talk-0.1.4" "$p\node_modules\dsh-hold-to-talk" -Recurse
# package.json 里把 link:... 改回 "0.1.4"
# cordis.patch.yml 删掉 - id: dsh-hold-to-talk 段
```

---

## 9. 目录结构

```
H:\DSH-鼠标语音输入\
├─ lib\
│  ├─ index.js           # 宿主:路由 + 引擎管理 + 提示词合成 + 云端分支 + /settings
│  ├─ client.js          # 浏览器:长按手势/浮层 + 设置页(settings.section)
│  ├─ asr-worker.mjs     # 本地 sherpa-onnx 解码(上游原样)
│  ├─ model-cache.js     # 本地模型下载缓存(上游原样)
│  ├─ cloud-asr.mjs      # 第三方 ASR 转发(WAV 编码 + 两种协议 + system 提示词)
│  ├─ wordbank.mjs       # 词库解析(术语表/纠错规则)与本地后处理
│  └─ settings-store.mjs # 设置持久化 + 校验 + 脱敏视图
├─ node_modules\         # 自带 sherpa-onnx,不依赖 profile
├─ cordis.patch.yml      # 部署默认配置模板
├─ package.json          # name 仍是 dsh-hold-to-talk(保证 bundle id 不变)
└─ README.zh.md
```

## 10. 与上游的差异（便于将来合并）

```
lib/cloud-asr.mjs       新增 ~260 行
lib/wordbank.mjs        新增 ~150 行
lib/settings-store.mjs  新增 ~150 行
lib/index.js            +默认配置/提示词合成/云端分支/设置路由/热更新,~200 行
lib/client.js           +草稿采集与 base64url、settings.section 设置页,~330 行
package.json / cordis.patch.yml  版本与配置模板
```

上游若发新版：覆盖 `asr-worker.mjs` / `model-cache.js` 与 `client.js` 的长按逻辑部分后，把本目录的 `lib/index.js`、`lib/client.js` 里带 `cloudAsr` / `wordbank` / `settings.section` 的补丁重新打一遍（各段都有明显注释块）。