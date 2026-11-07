# dsh-hold-to-talk-plus

**Hold-to-talk voice input for the DeepSeek Harness (DSH) Web composer — now with third-party ASR, a user wordbank, draft-as-context prompting, a settings page and live preview.**

Hold the mouse on the composer, speak, release: the transcript drops into your draft. The gesture, the floating overlay, the "slide up to cancel" interaction and the 60 s auto-finalize are unchanged from upstream; everything below is what this fork adds.

> 中文详细文档见 [README.zh.md](README.zh.md)。

## Features

| Feature | Upstream `dsh-hold-to-talk@0.1.4` | This fork |
|---|---|---|
| Local offline ASR (SenseVoice via sherpa-onnx) | ✅ | ✅ |
| Third-party cloud ASR (OpenAI-compatible `/v1/audio/transcriptions`, or Alibaba BaiLian `chat/completions` + `input_audio`) | ❌ | ✅ |
| Auto-detect protocol from endpoint URL (no more 400 on mismatch) | ❌ | ✅ |
| User wordbank (glossary + `correct=wrong1\|wrong2` correction rules) | ❌ | ✅ |
| Composer draft sent as context prompt | ❌ | ✅ |
| Settings page (`Settings → Voice input`) with provider presets and guided API-key acquisition | ❌ | ✅ |
| Connection test without saving (401/403/404/429/timeout translated to plain language) | ❌ | ✅ |
| Live preview while speaking on cloud ASR (re-decode of the tail window every 2 s) | ❌ | ✅ |
| Automatic fallback to local ASR when the cloud call fails | ❌ | ✅ |

## Install (as a DSH profile plugin)

This repo is a drop-in replacement for `dsh-hold-to-talk`, so it keeps the same package name and bundle id.

```powershell
# 1) clone somewhere stable
git clone https://github.com/lcx19970714/dsh-hold-to-talk-plus.git "H:\DSH-鼠标语音输入"
cd "H:\DSH-鼠标语音输入"

# 2) dependencies (sherpa-onnx native runtime)
pnpm install

# 3) point your DSH desktop profile at the local copy
#    edit  %USERPROFILE%\.dsh\profiles\desktop\package.json
#    "dsh-hold-to-talk": "link:H:/DSH-鼠标语音输入"
#    then:
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\desktop"

# 4) add plugin config to  %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
#    - id: dsh-hold-to-talk
#      name: dsh-hold-to-talk
#      config: { ... }   # see README.zh.md

# 5) fully quit DSH (tray → Quit) and reopen
```

Then open **Settings → Voice input**, pick a provider, paste an API key, hit **Test connection**, save.

## Providers

| Provider | Endpoint | Model | Protocol |
|---|---|---|---|
| Alibaba Cloud Model Studio (BaiLian) | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3-asr-flash` | `chat-audio` |
| SiliconFlow (free tier) | `https://api.siliconflow.cn/v1/audio/transcriptions` | `TeleAI/TeleSpeechASR` | `transcriptions` |
| Self-hosted (faster-whisper / whisper.cpp / FunASR gateway) | `http://127.0.0.1:8000/v1/audio/transcriptions` | `whisper-large-v3` | `transcriptions` |
| Local offline (no key) | — | SenseVoiceSmall int8 | `local` |

> Note: on BaiLian's compatible endpoint the ASR task **ignores instruction-style prompts**; the glossary is accepted but has limited effect. Reliable term correction comes from the wordbank's `correct=wrong` rules, which apply to both local and cloud results.

## Layout

```
lib/
├─ index.js           # host: routes, engine management, prompt assembly, cloud branch, /settings
├─ client.js          # browser: hold gesture, overlay, settings page
├─ asr-worker.mjs     # local sherpa-onnx decoder (upstream)
├─ model-cache.js     # local model download cache (upstream)
├─ cloud-asr.mjs      # WAV encoding + two third-party protocols + system prompt
├─ wordbank.mjs       # glossary / correction rules parsing + local post-processing
└─ settings-store.mjs # settings persistence (~/.dsh/hold-to-talk/settings.json)
```

## Credits & license

Fork of [wangzhanchao883/dsh-hold-to-talk](https://github.com/wangzhanchao883/dsh-hold-to-talk) (MIT). Original copyright © 2026 wangzhanchao883; modifications © 2026 lcx19970714. Licensed under the MIT License — see [LICENSE](LICENSE).
