/**
 * dsh-hold-to-talk · 浏览器半身
 *
 * 微信式长按说话:在输入框(data-lexical-editor)上按住鼠标不动 400ms 进入录音,
 * 浮层里边说边出字(interim 只进浮层,绝不回写输入框),松手把定稿文字追加进草稿,
 * 按住上滑则丢弃。
 *
 * 经典脚本 + window.__ModuleLoader__,无构建步骤,因此不能写 JSX,一律 React.createElement。
 */
window.__ModuleLoader__.load({
	id: "dsh-hold-to-talk",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;
		const { useEffect, useRef, useState } = React;

		const API = "/dsh-hold-to-talk";
		const TAG = "[hold-to-talk]";
		const TARGET_RATE = 16000;
		const MOVE_TOLERANCE_PX = 8;
		// 太短的音频送进非流式模型会吐幻觉词(实测 1.2s 得 "哈。",2s 才稳定),首次预览前先攒够
		const INTERIM_MIN_AUDIO_SEC = 2.0;
		const INTERIM_MIN_STEP_SEC = 0.3;
		const FALLBACK_CONFIG = {
			enabled: true,
			holdThresholdMs: 400,
			cancelSlidePx: 60,
			interimIntervalMs: 1500,
			minHoldMs: 250,
			maxHoldMs: 60000,
			autoSend: false,
			useDraftContext: true,
			draftContextChars: 300,
			cloudInterim: true,
			cloudInterimIntervalMs: 2000,
		};

		/* ------------------------------------------------------------------ 样式 */

		const CSS_TAG_ID = "dsh-hold-to-talk/overlay.css";
		const CSS = [
			".dsh-htt{position:fixed;left:50%;transform:translateX(-50%);bottom:132px;z-index:2147483000;",
			"display:flex;justify-content:center;width:min(600px,calc(100vw - 32px));pointer-events:none;",
			"font-family:inherit}",
			".dsh-htt__card{min-width:210px;max-width:100%;padding:10px 14px;border-radius:14px;",
			"background:rgba(22,24,29,.95);color:#f5f6f8;border:1px solid rgba(255,255,255,.08);",
			"box-shadow:0 12px 32px rgba(0,0,0,.34);font-size:13px;line-height:1.5;",
			"-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:background .15s ease}",
			".dsh-htt__card.is-armed{background:rgba(140,38,40,.96)}",
			".dsh-htt__row{display:flex;align-items:center;gap:8px}",
			".dsh-htt__mic{font-size:13px;line-height:1;flex:none}",
			".dsh-htt__mic.is-live{color:#ff5d5d;animation:dsh-htt-pulse 1s ease-in-out infinite}",
			"@keyframes dsh-htt-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
			".dsh-htt__wave{display:flex;align-items:center;gap:2px;height:18px;flex:1 1 auto;min-width:60px}",
			".dsh-htt__wave i{display:block;width:3px;border-radius:2px;background:#8ab4ff;opacity:.85;",
			"transition:height .09s linear}",
			".dsh-htt__time{flex:none;font-variant-numeric:tabular-nums;font-size:12px;opacity:.7}",
			".dsh-htt__hint{margin-top:6px;font-size:12px;opacity:.72}",
			".dsh-htt__text{margin-top:6px;max-height:9em;overflow:hidden;white-space:pre-wrap;word-break:break-word}",
			".dsh-htt__text--pending{opacity:.75}",
			".dsh-htt__text--warn{color:#ffd08a}",
			".dsh-htt__bar{margin-top:7px;height:3px;border-radius:2px;background:rgba(255,255,255,.16);overflow:hidden}",
			".dsh-htt__bar span{display:block;height:100%;background:#8ab4ff;transition:width .2s ease}",
			"body.dsh-htt-holding [data-lexical-editor=\"true\"],body.dsh-htt-holding .dsh-htt-src",
			"{-webkit-user-select:none!important;user-select:none!important}",
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hold-to-talk";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ------------------------------------------------------- AudioWorklet 源码 */

		// 插件没有独立的静态文件服务,worklet 用 Blob URL 内联加载。
		const WORKLET_SRC = [
			"class DshPcmTap extends AudioWorkletProcessor {",
			"  process(inputs) {",
			"    const ch = inputs[0] && inputs[0][0];",
			"    if (ch && ch.length) {",
			"      const copy = new Float32Array(ch.length);",
			"      copy.set(ch);",
			"      let sum = 0;",
			"      for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];",
			"      this.port.postMessage({ samples: copy, rms: Math.sqrt(sum / copy.length) });",
			"    }",
			"    return true;",
			"  }",
			"}",
			"registerProcessor('dsh-pcm-tap', DshPcmTap);",
		].join("\n");

		/* ------------------------------------------------------------ 音频基础设施 */

		// AudioContext 必须在真实用户手势里创建/解挂,否则自动播放策略会让它一直 suspended。
		// 这里不碰麦克风(没有权限弹窗、没有录音指示灯),只是一台常备的静音引擎。
		let warmCtx = null;
		function warmAudioContext() {
			if (warmCtx) return warmCtx;
			try {
				const Ctor = window.AudioContext || window.webkitAudioContext;
				if (!Ctor) return null;
				let ctx;
				try {
					ctx = new Ctor({ sampleRate: TARGET_RATE });
				} catch (err) {
					ctx = new Ctor();
				}
				if (ctx.state === "suspended") ctx.resume().catch(() => {});
				warmCtx = ctx;
			} catch (err) {
				console.warn(TAG, "创建 AudioContext 失败", err);
				warmCtx = null;
			}
			return warmCtx;
		}

		async function startCapture(onChunk) {
			const ctx = warmAudioContext();
			if (!ctx) throw new Error("当前浏览器不支持音频采集");
			if (ctx.state === "suspended") {
				try {
					await ctx.resume();
				} catch (err) {
					/* ignore */
				}
			}
			if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
				throw new Error("当前页面无法访问麦克风(需要 https 或 127.0.0.1)");
			}
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});

			const source = ctx.createMediaStreamSource(stream);
			// 采集节点必须连到 destination 才会被拉动;串一个 0 增益的 sink 保证不外放(否则啸叫)
			const sink = ctx.createGain();
			sink.gain.value = 0;
			sink.connect(ctx.destination);

			let node = null;
			if (ctx.audioWorklet) {
				try {
					const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
					try {
						await ctx.audioWorklet.addModule(url);
					} finally {
						URL.revokeObjectURL(url);
					}
					node = new AudioWorkletNode(ctx, "dsh-pcm-tap");
					node.port.onmessage = (ev) => onChunk(ev.data);
				} catch (err) {
					console.warn(TAG, "AudioWorklet 不可用,回退 ScriptProcessor", err);
					node = null;
				}
			}
			if (!node) {
				node = ctx.createScriptProcessor(4096, 1, 1);
				node.onaudioprocess = (ev) => {
					const ch = ev.inputBuffer.getChannelData(0);
					const copy = new Float32Array(ch.length);
					copy.set(ch);
					let sum = 0;
					for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
					onChunk({ samples: copy, rms: Math.sqrt(sum / copy.length) });
				};
			}

			source.connect(node);
			node.connect(sink);

			return {
				nativeRate: ctx.sampleRate,
				stop() {
					try {
						source.disconnect();
					} catch (err) {
						/* ignore */
					}
					try {
						node.disconnect();
					} catch (err) {
						/* ignore */
					}
					try {
						if (node.port) node.port.onmessage = null;
						node.onaudioprocess = null;
					} catch (err) {
						/* ignore */
					}
					try {
						sink.disconnect();
					} catch (err) {
						/* ignore */
					}
					for (const track of stream.getTracks()) {
						try {
							track.stop();
						} catch (err) {
							/* ignore */
						}
					}
				},
			};
		}

		/** 可增长的单声道缓冲(避免每个 tick 重新分配整段) */
		function createBuffer() {
			let data = new Float32Array(1 << 16);
			let length = 0;
			return {
				append(chunk) {
					if (length + chunk.length > data.length) {
						let cap = data.length;
						while (cap < length + chunk.length) cap *= 2;
						const next = new Float32Array(cap);
						next.set(data.subarray(0, length));
						data = next;
					}
					data.set(chunk, length);
					length += chunk.length;
				},
				view() {
					return data.subarray(0, length);
				},
				get length() {
					return length;
				},
			};
		}

		/**
		 * 线性重采样到 16k。
		 * 每次都从 0 号样本重算,保证各次增量能严丝合缝地拼接(只重采样尾部会错位)。
		 */
		function resampleTo16k(src, nativeRate) {
			if (!src || src.length === 0) return new Float32Array(0);
			if (nativeRate === TARGET_RATE) return src;
			const ratio = nativeRate / TARGET_RATE;
			const outLen = Math.max(0, Math.floor(src.length / ratio));
			const out = new Float32Array(outLen);
			for (let i = 0; i < outLen; i++) {
				const pos = i * ratio;
				const i0 = Math.floor(pos);
				const i1 = i0 + 1 < src.length ? i0 + 1 : i0;
				const frac = pos - i0;
				out[i] = src[i0] * (1 - frac) + src[i1] * frac;
			}
			return out;
		}

		/* ------------------------------------------------------------------ 网络 */

		async function postPcm(holdId, mode, samples, signal, draft) {
			let res;
			const headers = { "content-type": "application/octet-stream" };
			if (typeof draft === "string" && draft !== "") headers["x-htt-draft"] = toBase64Url(draft);
			try {
				res = await fetch(API + "/asr?mode=" + mode + "&hold=" + encodeURIComponent(holdId), {
					method: "POST",
					headers,
					body: samples,
					signal,
				});
			} catch (err) {
				return { ok: false, status: 0, data: { error: String((err && err.message) || err) } };
			}
			let data = null;
			try {
				data = await res.json();
			} catch (err) {
				data = null;
			}
			return { ok: res.ok, status: res.status, data: data || {} };
		}

		function postDrop(holdId) {
			try {
				fetch(API + "/asr?mode=drop&hold=" + encodeURIComponent(holdId), { method: "POST", keepalive: true }).catch(() => {});
			} catch (err) {
				/* ignore */
			}
		}

		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		function newHoldId() {
			return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		}

		function micErrorMessage(err) {
			const name = err && err.name;
			if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限被拒绝,请在地址栏允许后重试";
			if (name === "NotFoundError") return "没有找到麦克风设备";
			if (name === "NotReadableError") return "麦克风被其他程序占用";
			return String((err && err.message) || err || "无法开始录音");
		}

		/* ------------------------------------------------- 全局手势(单例,跨会话实例) */

		const EDITOR_SELECTOR = '[data-lexical-editor="true"], [contenteditable="true"]';

		// 整包热重载(HMR)后,上一份模块注册的文档级监听器还在。用一枚 token 让它自动
		// 失效,否则同一次 mousedown 会被新旧两份逻辑各接一次(可能开两条录音)。
		const MODULE_TOKEN = "htt-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

		function isStaleModule() {
			return typeof window !== "undefined" && window.__dshHoldToTalkToken !== MODULE_TOKEN;
		}

		const registry = {
			bound: false,
			instances: [],
			owner: null,
		};

		/**
		 * 判断某个浮层实例是否"属于"这次按下的输入框:从输入框往上走,看哪一层祖先
		 * 同时包含浮层节点。
		 *
		 * 这里刻意**不看可见性**:浮层空闲时是隐藏的(甚至 display:none 的祖先),
		 * 用 offsetParent/getClientRects 判可见会让长按在第一次成功之后彻底失效
		 * ——真实的踩坑现场。DOM 包含关系与 CSS 无关,所以永远稳。
		 */
		function nodeOwnsEditor(node, editorEl) {
			if (!node || !editorEl) return false;
			let el = editorEl;
			while (el) {
				if (typeof el.contains === "function" && el.contains(node)) return true;
				el = el.parentElement;
			}
			return false;
		}

		/** 为这次按下挑实例:优先"同卡片"的那个;只有一个实例时兜底用它 */
		function pickInstanceFor(editorEl) {
			for (const inst of registry.instances) {
				try {
					if (inst.ownsEditor(editorEl)) return inst;
				} catch (err) {
					/* ignore */
				}
			}
			// 只有一个实例时(绝大多数情况)即使 DOM 结构出乎意料也别让功能瘫掉;
			// 多实例且都对不上时宁可不响应,避免把文字写进别的会话
			return registry.instances.length === 1 ? registry.instances[0] : null;
		}

		function bindGlobalOnce() {
			if (registry.bound || typeof document === "undefined") return;
			registry.bound = true;
			try {
				window.__dshHoldToTalkToken = MODULE_TOKEN;
			} catch (err) {
				/* ignore */
			}

			document.addEventListener(
				"mousedown",
				(e) => {
					if (isStaleModule()) return;
					const target = e.target;
					const editor = target && typeof target.closest === "function" ? target.closest(EDITOR_SELECTOR) : null;
					if (!editor) return;
					const inst = pickInstanceFor(editor);
					if (inst) inst.onMouseDown(e);
				},
				true,
			);
			document.addEventListener(
				"mousemove",
				(e) => {
					if (isStaleModule()) return;
					const inst = registry.owner;
					if (inst) inst.onMouseMove(e);
				},
				true,
			);
			document.addEventListener(
				"mouseup",
				(e) => {
					if (isStaleModule()) return;
					const inst = registry.owner;
					if (inst) inst.onMouseUp(e);
				},
				true,
			);
			document.addEventListener(
				"keydown",
				(e) => {
					if (isStaleModule()) return;
					const inst = registry.owner;
					if (inst) inst.onKeyDown(e);
				},
				true,
			);
			window.addEventListener("blur", () => {
				if (isStaleModule()) return;
				const inst = registry.owner;
				if (inst) inst.onBlur();
			});
		}

		/* ------------------------------------------------------------ 交互控制器 */

		function createController(ui) {
			const hold = { current: null };
			let epoch = 0;

			function setHoldingClass(on) {
				try {
					document.body.classList.toggle("dsh-htt-holding", !!on);
				} catch (err) {
					/* ignore */
				}
			}

			function clearTimers(item) {
				if (!item) return;
				if (item.judgeTimer) clearTimeout(item.judgeTimer);
				if (item.uiTimer) clearInterval(item.uiTimer);
				if (item.interimTimer) clearInterval(item.interimTimer);
				item.judgeTimer = null;
				item.uiTimer = null;
				item.interimTimer = null;
			}

			function release(item) {
				clearTimers(item);
				if (item.recorder) {
					try {
						item.recorder.stop();
					} catch (err) {
						/* ignore */
					}
					item.recorder = null;
				}
				if (hold.current === item) hold.current = null;
				if (registry.owner === ui.self) registry.owner = null;
				setHoldingClass(false);
			}

			function cancelBeforeStart(item) {
				item.cancelled = true;
				release(item);
			}

			async function begin(item) {
				if (item.cancelled || hold.current !== item) return;
				const cfg = ui.getConfig();
				if (!cfg.enabled) {
					release(item);
					return;
				}
				item.active = true;
				item.startedAt = Date.now();
				ui.setPhase("holding");
				ui.setInterim("");
				ui.setArmed(false);
				ui.setMessage("");
				ui.setMeter({ ms: 0, levels: [] });

				try {
					item.recorder = await startCapture((data) => {
						if (item.cancelled || !data || !data.samples) return;
						item.buffer.append(data.samples);
						item.rms = typeof data.rms === "number" ? data.rms : 0;
					});
				} catch (err) {
					release(item);
					ui.setPhase("error");
					ui.setMessage(micErrorMessage(err));
					console.warn(TAG, "录音启动失败", err);
					setTimeout(() => ui.clearIfIdle(), 4000);
					return;
				}

				if (item.cancelled || hold.current !== item) {
					release(item);
					return;
				}

				item.uiTimer = setInterval(() => {
					const cfgNow = ui.getConfig();
					const ms = Date.now() - item.startedAt;
					item.levels.push(item.rms || 0);
					if (item.levels.length > 18) item.levels.shift();
					ui.setMeter({ ms, levels: item.levels.slice() });
					if (ms >= cfgNow.maxHoldMs) finish(item, false);
				}, 100);

				item.interimTimer = setInterval(() => pumpInterim(item), Math.max(400, cfg.interimIntervalMs));
			}

			async function pumpInterim(item) {
				if (!item.active || item.cancelled || item.uploadBusy) return;
				if (hold.current !== item) return;
				const nativeRate = item.recorder ? item.recorder.nativeRate : TARGET_RATE;
				const pcm = resampleTo16k(item.buffer.view(), nativeRate);
				const needed = item.sent === 0 ? INTERIM_MIN_AUDIO_SEC : INTERIM_MIN_STEP_SEC;
				if (pcm.length - item.sent < TARGET_RATE * needed) return;
				if (pcm.length < TARGET_RATE * INTERIM_MIN_AUDIO_SEC) return;
				const increment = pcm.subarray(item.sent);
				const myEpoch = ++epoch;
				item.uploadBusy = true;
				try {
					const res = await postPcm(item.id, "interim", increment);
					if (item.cancelled || hold.current !== item || epoch !== myEpoch) return;
					if (res.status === 409) {
						ui.onModelPreparing(res.data);
						return;
					}
					if (!res.ok) return; // 预览失败不打扰用户
					item.sent = pcm.length;
					const text = res.data && typeof res.data.text === "string" ? res.data.text.trim() : "";
					if (text) ui.setInterim(text);
				} finally {
					item.uploadBusy = false;
				}
			}

			async function finish(item, cancelled) {
				if (item.finished) return;
				item.finished = true;
				item.cancelled = true; // 让在途的预览结果全部作废
				const cfg = ui.getConfig();
				const raw = item.buffer.view();
				const nativeRate = item.recorder ? item.recorder.nativeRate : TARGET_RATE;
				const durationMs = nativeRate > 0 ? (raw.length / nativeRate) * 1000 : 0;
				release(item);

				if (cancelled || durationMs < cfg.minHoldMs) {
					postDrop(item.id);
					ui.setPhase("idle");
					ui.setInterim("");
					ui.setArmed(false);
					ui.setMessage(cancelled && durationMs >= cfg.minHoldMs ? "已取消" : "");
					ui.clearMessageLater(1400);
					return;
				}

				ui.setPhase("working");
				ui.setMessage("识别中…");
				const pcm = resampleTo16k(raw, nativeRate);
				const from = Math.min(item.sent, pcm.length);
				const increment = pcm.subarray(from);
				// 输入框里已有的内容 → 云端模型的上下文提示词(只发给自己的宿主路由)
				let draftText = "";
				if (cfg.useDraftContext) {
					const limit = Math.max(0, Number(cfg.draftContextChars) || 0);
					const full = readEditorDraft(item.editor);
					draftText = limit > 0 ? full.slice(-limit) : "";
				}

				try {
					let payload = null;
					for (let attempt = 0; attempt < 240; attempt++) {
						const res = await postPcm(item.id, "final", increment, undefined, draftText);
						if (res.status === 409) {
							ui.onModelPreparing(res.data);
							await sleep(1500);
							continue;
						}
						if (!res.ok) throw new Error((res.data && res.data.error) || "HTTP " + res.status);
						payload = res.data || {};
						break;
					}
					if (!payload) throw new Error("等待语音模型超时");
					const text = typeof payload.text === "string" ? payload.text.trim() : "";
					if (!text) {
						ui.setPhase("idle");
						ui.setInterim("");
						ui.setMessage("没听清,再说一次");
						ui.clearMessageLater(2000);
						return;
					}
					const wrote = ui.insertText(text);
					ui.setPhase("idle");
					ui.setInterim("");
					ui.setArmed(false);
					ui.setMessage(wrote ? "" : "无法写入输入框");
					ui.clearMessageLater(1600);
				} catch (err) {
					console.warn(TAG, "识别失败", err);
					ui.setPhase("error");
					ui.setMessage(String((err && err.message) || err));
					ui.clearMessageLater(4500);
				}
			}

			return {
				onMouseDown(e) {
					if (hold.current) return;
					if (e.button !== 0) return;
					const target = e.target;
					const editor = target && typeof target.closest === "function" ? target.closest(EDITOR_SELECTOR) : null;
					if (!editor) return;
					// 真实用户手势里把 AudioContext 建起来/解挂,免得 400ms 后创建时被自动播放策略挂起
					warmAudioContext();

					const item = {
						id: newHoldId(),
						active: false,
						finished: false,
						cancelled: false,
						armed: false,
						uploadBusy: false,
						sent: 0,
						rms: 0,
						levels: [],
						buffer: createBuffer(),
						recorder: null,
						startedAt: 0,
						editor,
						startX: e.clientX,
						startY: e.clientY,
						judgeTimer: null,
						uiTimer: null,
						interimTimer: null,
					};
					hold.current = item;
					registry.owner = ui.self;
					item.judgeTimer = setTimeout(() => begin(item), Math.max(120, ui.getConfig().holdThresholdMs));
				},

				onMouseMove(e) {
					const item = hold.current;
					if (!item) return;
					if (!item.active) {
						const moved = Math.abs(e.clientX - item.startX) + Math.abs(e.clientY - item.startY);
						if (moved > MOVE_TOLERANCE_PX) cancelBeforeStart(item);
						return;
					}
					const dy = item.startY - e.clientY;
					const armed = dy > ui.getConfig().cancelSlidePx;
					if (armed !== item.armed) {
						item.armed = armed;
						ui.setArmed(armed);
					}
				},

				onMouseUp() {
					const item = hold.current;
					if (!item) return;
					if (!item.active) {
						cancelBeforeStart(item); // 普通点击(未到长按阈值):放行,不影响光标与选区
						return;
					}
					finish(item, item.armed);
				},

				onKeyDown(e) {
					const item = hold.current;
					if (!item) return;
					if (e.key === "Escape") {
						if (e.preventDefault) e.preventDefault();
						if (item.active) finish(item, true);
						else cancelBeforeStart(item);
					}
				},

				onBlur() {
					const item = hold.current;
					if (!item) return;
					if (item.active) finish(item, true);
					else cancelBeforeStart(item);
				},

				abort() {
					const item = hold.current;
					if (!item) return;
					release(item);
					if (!item.active) return;
					postDrop(item.id);
				},
			};
		}

		/* ------------------------------------------------- 草稿上下文 / 设置页 */

		/** UTF-8 → base64url(请求头里不能有非 ASCII) */
		function toBase64Url(text) {
			try {
				const bytes = new TextEncoder().encode(String(text || ""));
				let bin = "";
				for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
				return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			} catch {
				return "";
			}
		}

		/** 取输入框当前草稿(松手瞬间的 DOM 文本) */
		function readEditorDraft(editor) {
			if (!editor) return "";
			try {
				const text = typeof editor.innerText === "string" ? editor.innerText : editor.textContent || "";
				return text.replace(/\u200b/g, "").trim();
			} catch {
				return "";
			}
		}

		/** 端点 URL → 协议(避免"chat/completions 配 transcriptions"这种必然 400 的组合) */
		function inferApiFromUrl(url) {
			const u = String(url || "").toLowerCase();
			if (u.includes("/chat/completions")) return "chat-audio";
			if (u.includes("/audio/transcriptions")) return "transcriptions";
			return "";
		}

		const SETTINGS_SLOT = "settings.section";
		const SETTINGS_ID = "hold-to-talk";
		const SETTINGS_ORDER = 35;
		const SETTINGS_CSS_TAG = "dsh-hold-to-talk/settings.css";

		/* ---------------- 服务商预设 + 取 Key 引导 ---------------- */

		const PROVIDERS = [
			{
				id: "bailian",
				name: "阿里云百炼",
				tag: "中文最准",
				preset: {
					asrEngine: "cloud",
					cloudAsrApi: "chat-audio",
					cloudAsrUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
					cloudAsrModel: "qwen3-asr-flash",
					cloudAsrLanguage: "zh",
				},
				price: "约 0.792 元/小时,开通送 10 小时免费额度",
				steps: [
					["打开百炼控制台", "https://bailian.console.aliyun.com/", "用阿里云账号登录,并按提示完成实名认证(个人身份证即可)"],
					["开通模型", "https://bailian.console.aliyun.com/?apiKey=1#/api-key", "模型广场搜索 Qwen3-ASR-Flash 开通;首次调用前如果没有开通会报 403"],
					["创建 API-KEY", "https://bailian.console.aliyun.com/?apiKey=1#/api-key", "左侧「API-KEY 管理」→ 创建 → 复制 sk- 开头的整串(别带空格换行)"],
					["粘贴 → 测试 → 保存", "", "把 Key 粘到下面第 2 步,先点「测试连接」看到成功再点保存"],
				],
			},
			{
				id: "siliconflow",
				name: "硅基流动",
				tag: "免费",
				preset: {
					asrEngine: "cloud",
					cloudAsrApi: "transcriptions",
					cloudAsrUrl: "https://api.siliconflow.cn/v1/audio/transcriptions",
					cloudAsrModel: "TeleAI/TeleSpeechASR",
					cloudAsrLanguage: "zh",
				},
				price: "语音识别模型免费(可能限速)",
				steps: [
					["注册账号", "https://cloud.siliconflow.cn/", "手机号注册并完成实名"],
					["创建 API 密钥", "https://cloud.siliconflow.cn/account/ak", "右上角头像 → API 密钥 → 新建,复制 sk- 开头的整串"],
					["直接可用", "", "TeleSpeechASR / SenseVoiceSmall 免费,不需要充值"],
					["粘贴 → 测试 → 保存", "", "同百炼:先测试连接,成功再保存"],
				],
			},
			{
				id: "selfhost",
				name: "自建 / 本机",
				tag: "不联网",
				preset: {
					asrEngine: "cloud",
					cloudAsrApi: "transcriptions",
					cloudAsrUrl: "http://127.0.0.1:8000/v1/audio/transcriptions",
					cloudAsrModel: "whisper-large-v3",
					cloudAsrLanguage: "zh",
				},
				price: "本地推理,零调用费",
				steps: [
					["起一个 OpenAI 兼容的转写服务", "https://github.com/SYSTRAN/faster-whisper", "例如 faster-whisper-server、whisper.cpp server、FunASR 网关、one-api"],
					["填端点", "", "默认路径一般是 /v1/audio/transcriptions,端口按你的服务改"],
					["Key 可留空", "", "本机端点(127.0.0.1/localhost)不填 Key 也能用"],
					["测试 → 保存", "", ""],
				],
			},
		];

		const SETTINGS_CSS = [
			".dsh-htt-cfg{display:flex;flex-direction:column;gap:16px;max-width:760px;padding-bottom:4px;",
			"color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dsh-htt-cfg__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
			".dsh-htt-cfg__title{margin:0 0 4px;font-size:18px;font-weight:600;line-height:26px}",
			".dsh-htt-cfg__sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-htt-cfg__pill{flex:none;padding:2px 10px;border-radius:999px;font-size:12px;line-height:18px;",
			"border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".dsh-htt-cfg__pill.is-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".dsh-htt-cfg__pill.is-warn{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}",
			".dsh-htt-cfg__section{display:flex;flex-direction:column;gap:8px}",
			".dsh-htt-cfg__sechead{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}",
			".dsh-htt-cfg__num{display:inline-flex;flex:none;width:20px;height:20px;border-radius:50%;",
			"align-items:center;justify-content:center;font-size:12px;font-weight:600;",
			"background:var(--dsw-alias-state-business-primary);color:#fff}",
			".dsh-htt-cfg__hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-left:28px}",
			".dsh-htt-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;",
			"border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}",
			".dsh-htt-cfg__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}",
			".dsh-htt-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dsh-htt-cfg__label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dsh-htt-cfg__inp{box-sizing:border-box;width:100%;min-height:30px;padding:4px 10px;",
			"border:1px solid var(--dsw-alias-border-l2);border-radius:8px;",
			"background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);",
			"font:inherit;font-size:13px;outline:none}",
			".dsh-htt-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-htt-cfg__inp:disabled{opacity:.6}",
			".dsh-htt-cfg__area{min-height:120px;resize:vertical;line-height:19px;",
			"font-family:ui-monospace,Consolas,monospace;font-size:12px}",
			".dsh-htt-cfg__note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-htt-cfg__presets{display:flex;gap:8px;flex-wrap:wrap}",
			".dsh-htt-cfg__preset{padding:4px 12px;border-radius:999px;cursor:pointer;font:inherit;font-size:12px;",
			"line-height:20px;border:1px solid var(--dsw-alias-border-l2);background:transparent;",
			"color:var(--dsw-alias-label-secondary)}",
			".dsh-htt-cfg__preset.is-active{border-color:var(--dsw-alias-state-business-primary);",
			"color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}",
			".dsh-htt-cfg__guide{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 14px;",
			".dsh-htt-cfg__guidehead{display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:600}",
			"background:var(--dsw-alias-bg-layer-1)}",
			".dsh-htt-cfg__guide>summary{cursor:pointer;font-size:13px;font-weight:600;outline:none}",
			".dsh-htt-cfg__steps{margin:10px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:6px}",
			".dsh-htt-cfg__steps li{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}",
			".dsh-htt-cfg__link{color:var(--dsw-alias-state-business-primary);text-decoration:none;margin-left:6px}",
			".dsh-htt-cfg__link:hover{text-decoration:underline}",
			".dsh-htt-cfg__check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:19px;",
			"color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dsh-htt-cfg__check input{margin-top:3px;flex:none}",
			".dsh-htt-cfg__row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}",
			".dsh-htt-cfg__btn{border:1px solid var(--dsw-alias-button-info-fill);",
			"background:var(--dsw-alias-button-info-fill);color:#fff;border-radius:8px;padding:4px 16px;",
			"font:inherit;font-size:12px;line-height:20px;cursor:pointer}",
			".dsh-htt-cfg__btn.ghost{background:transparent;color:var(--dsw-alias-label-primary);",
			"border-color:var(--dsw-alias-border-l2)}",
			".dsh-htt-cfg__btn:disabled{opacity:.5;cursor:default}",
			".dsh-htt-cfg__msg{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}",
			".dsh-htt-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}",
			".dsh-htt-cfg__msg.is-warn{color:var(--dsw-alias-state-warning-primary)}",
			".dsh-htt-cfg__detail{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);",
			"word-break:break-all;margin-top:4px}",
			".dsh-htt-cfg__footer{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;",
			"padding:10px 0 6px;background:var(--dsw-alias-bg-layer-1)}",
			".dsh-htt-cfg__dirty{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
		].join("");

		function ensureSettingsCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(SETTINGS_CSS_TAG) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hold-to-talk";
			tag.dataset.pluginCss = SETTINGS_CSS_TAG;
			tag.textContent = SETTINGS_CSS;
			document.head.appendChild(tag);
		}

		const EMPTY_FORM = {
			asrEngine: "cloud",
			cloudAsrApi: "chat-audio",
			cloudAsrUrl: "",
			cloudAsrModel: "",
			apiKey: "",
			apiKeySet: false,
			cloudAsrLanguage: "zh",
			useDraftContext: true,
			draftContextChars: 300,
			cloudFallbackToLocal: true,
			cloudInterim: true,
			cloudInterimIntervalMs: 2000,
			wordbankApplyToLocal: true,
			wordbank: "",
			wordbankPath: "",
			wordbankTerms: 0,
			wordbankRules: 0,
			engine: "local",
			modelReady: false,
		};

		function field(key, label, control, note) {
			return h(
				"div",
				{ className: "dsh-htt-cfg__field", key },
				h("label", { className: "dsh-htt-cfg__label", htmlFor: "dsh-htt-" + key }, label),
				control,
				note ? h("div", { className: "dsh-htt-cfg__note" }, note) : null,
			);
		}

		function HoldToTalkSettings() {
			const [form, setForm] = useState(EMPTY_FORM);
			const [phase, setPhase] = useState("loading");
			const [message, setMessage] = useState("");
			const [testPhase, setTestPhase] = useState("idle");
			const [testMessage, setTestMessage] = useState("");
			const [testDetail, setTestDetail] = useState("");
			const [provider, setProvider] = useState("bailian");
			const [dirty, setDirty] = useState(false);
			const [guideOpen, setGuideOpen] = useState(false);

			const applyServer = (data) => {
				const cfg = (data && data.config) || {};
				const wb = (data && data.wordbank) || {};
				const rt = (data && data.runtime) || {};
				setForm({
					asrEngine: cfg.asrEngine || "local",
					cloudAsrApi: cfg.cloudAsrApi || "transcriptions",
					cloudAsrUrl: cfg.cloudAsrUrl || "",
					cloudAsrModel: cfg.cloudAsrModel || "",
					apiKey: "",
					apiKeySet: cfg.cloudAsrApiKeySet === true,
					cloudAsrLanguage: cfg.cloudAsrLanguage || "zh",
					useDraftContext: cfg.useDraftContext !== false,
					draftContextChars: typeof cfg.draftContextChars === "number" ? cfg.draftContextChars : 300,
					cloudFallbackToLocal: cfg.cloudFallbackToLocal !== false,
					cloudInterim: cfg.cloudInterim !== false,
					cloudInterimIntervalMs: typeof cfg.cloudInterimIntervalMs === "number" ? cfg.cloudInterimIntervalMs : 2000,
					wordbankApplyToLocal: cfg.wordbankApplyToLocal !== false,
					wordbank: typeof wb.text === "string" ? wb.text : "",
					wordbankPath: wb.path || "",
					wordbankTerms: wb.terms || 0,
					wordbankRules: wb.rules || 0,
					engine: rt.engine || "local",
					modelReady: rt.modelReady === true,
				});
				setDirty(false);
				// 从没配过 Key 的人第一次进来,直接把取 Key 引导展开
				if (!(cfg.cloudAsrApiKeySet === true)) setGuideOpen(true);
			};

			useEffect(() => {
				ensureSettingsCss();
				let alive = true;
				(async () => {
					try {
						const res = await fetch(API + "/settings", { headers: { accept: "application/json" } });
						if (!res.ok) throw new Error("HTTP " + res.status);
						const data = await res.json();
						if (!alive) return;
						applyServer(data);
						setPhase("idle");
					} catch (err) {
						if (!alive) return;
						setPhase("idle");
						setMessage("读取现有配置失败,仍可保存:" + String((err && err.message) || err));
					}
				})();
				return () => {
					alive = false;
				};
			}, []);

			const touch = () => {
				setDirty(true);
				if (testPhase !== "idle") {
					setTestPhase("idle");
					setTestMessage("");
					setTestDetail("");
				}
				if (phase === "ok" || phase === "err") {
					setPhase("idle");
					setMessage("");
				}
			};

			const set = (key) => (event) => {
				const t = event && event.target ? event.target : null;
				const value = t ? (t.type === "checkbox" ? t.checked : t.value) : event;
				if (key === "cloudAsrUrl") {
					// 端点一改,协议跟着变:chat/completions → chat-audio,/audio/transcriptions → transcriptions
					const inferred = inferApiFromUrl(value);
					setForm((prev) =>
						Object.assign({}, prev, { cloudAsrUrl: value }, inferred ? { cloudAsrApi: inferred } : {}),
					);
					touch();
					return;
				}
				setForm((prev) => Object.assign({}, prev, { [key]: value }));
				touch();
			};

			const pickProvider = (p) => {
				setProvider(p.id);
				setGuideOpen(true);
				setForm((prev) => Object.assign({}, prev, p.preset));
				touch();
			};

			const buildPatch = () => {
				const patch = {
					asrEngine: form.asrEngine,
					cloudAsrApi: form.cloudAsrApi,
					cloudAsrUrl: form.cloudAsrUrl,
					cloudAsrModel: form.cloudAsrModel,
					cloudAsrLanguage: form.cloudAsrLanguage,
					useDraftContext: Boolean(form.useDraftContext),
					draftContextChars: Number(form.draftContextChars) || 0,
					cloudFallbackToLocal: Boolean(form.cloudFallbackToLocal),
					cloudInterim: Boolean(form.cloudInterim),
					cloudInterimIntervalMs: Number(form.cloudInterimIntervalMs) || 2000,
					wordbankApplyToLocal: Boolean(form.wordbankApplyToLocal),
				};
				if (form.apiKey) patch.cloudAsrApiKey = form.apiKey;
				return patch;
			};

			const save = async () => {
				setPhase("saving");
				setMessage("");
				try {
					const res = await fetch(API + "/settings", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ config: buildPatch(), wordbank: form.wordbank }),
					});
					let body = null;
					try {
						body = await res.json();
					} catch (err) {
						body = null;
					}
					if (!body) throw new Error("HTTP " + res.status);
					if (!body.ok) throw new Error((body.errors && body.errors.join(";")) || "保存被拒绝");
					applyServer(body);
					setPhase("ok");
					setMessage("已保存,下一次长按立即生效");
				} catch (err) {
					setPhase("err");
					setMessage("保存失败:" + String((err && err.message) || err));
				}
			};

			const test = async () => {
				setTestPhase("testing");
				setTestMessage("");
				setTestDetail("");
				try {
					const res = await fetch(API + "/settings/test", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ config: buildPatch() }),
					});
					const body = await res.json().catch(() => null);
					if (!body) throw new Error("HTTP " + res.status);
					if (body.ok) {
						setTestPhase("ok");
						setTestMessage(body.message || "连接成功");
						setTestDetail("");
					} else {
						setTestPhase("err");
						setTestMessage(body.message || "连接失败");
						setTestDetail(body.detail || "");
					}
				} catch (err) {
					setTestPhase("err");
					setTestMessage("测试请求没发出去:" + String((err && err.message) || err));
				}
			};

			const busy = phase === "saving" || phase === "loading";
			const testing = testPhase === "testing";
			const currentProvider = PROVIDERS.find((p) => p.id === provider) || PROVIDERS[0];
			const cloudReady = Boolean(form.cloudAsrUrl) && (Boolean(form.apiKey) || form.apiKeySet);
			const pillText = form.asrEngine === "cloud" ? (cloudReady ? "云端 · 已配置" : "云端 · 待填 Key") : "本地 SenseVoice";
			const pillClass = "dsh-htt-cfg__pill" + (cloudReady && form.asrEngine === "cloud" ? " is-ok" : form.asrEngine === "cloud" ? " is-warn" : "");

			const opt = (value, label) => h("option", { value, key: value }, label);

			const guide = h(
				"div",
				{ className: "dsh-htt-cfg__guide" },
				h(
					"div",
					{ className: "dsh-htt-cfg__guidehead" },
					h("span", null, "如何获取 API Key —— " + currentProvider.name + "(" + currentProvider.tag + ")"),
					h(
						"button",
						{
							type: "button",
							className: "dsh-htt-cfg__btn ghost",
							onClick: () => setGuideOpen(!guideOpen),
							disabled: busy,
						},
						guideOpen ? "收起" : "展开",
					),
				),
				guideOpen
					? h(
						"ol",
						{ className: "dsh-htt-cfg__steps" },
						currentProvider.steps.map((row, i) =>
							h(
								"li",
								{ key: "s" + i },
								row[0],
								row[1]
									? h(
										"a",
										{ className: "dsh-htt-cfg__link", href: row[1], target: "_blank", rel: "noopener noreferrer" },
										"打开",
									  )
									: null,
								row[2] ? h("div", { className: "dsh-htt-cfg__note" }, row[2]) : null,
							),
						),
					)
					: h("div", { className: "dsh-htt-cfg__note" }, "点「展开」看这一家的取 Key 步骤:注册 → 实名 → 控制台建 Key → 粘到下一步。"),
				h("div", { className: "dsh-htt-cfg__note" }, "计费参考:" + currentProvider.price + "。Key 只存在本机 ~/.dsh/hold-to-talk/settings.json。"),
			);

			return h(
				"section",
				{ className: "dsh-htt-cfg" },
				h(
					"div",
					{ className: "dsh-htt-cfg__head" },
					h(
						"div",
						null,
						h("h2", { className: "dsh-htt-cfg__title" }, "语音输入"),
						h(
							"p",
							{ className: "dsh-htt-cfg__sub" },
							"在输入框按住鼠标说话,松手出字。识别可走本地 SenseVoice,也可走第三方云端;词库和输入框内容会作为提示词一起发过去。",
						),
					),
					h("span", { className: pillClass, title: form.modelReady ? "模型已就绪" : "模型未就绪" }, pillText),
				),

				/* 第 1 步:选服务商 */
				h(
					"div",
					{ className: "dsh-htt-cfg__section" },
					h("div", { className: "dsh-htt-cfg__sechead" },
						h("span", { className: "dsh-htt-cfg__num" }, "1"),
						"选服务商(自动填好端点与模型)"),
					h(
						"div",
						{ className: "dsh-htt-cfg__presets" },
						PROVIDERS.map((p) =>
							h(
								"button",
								{
									key: p.id,
									type: "button",
									className: "dsh-htt-cfg__preset" + (provider === p.id ? " is-active" : ""),
									onClick: () => pickProvider(p),
									disabled: busy,
								},
								p.name + " · " + p.tag,
							),
						),
					),
					h("div", { className: "dsh-htt-cfg__hint" }, "选好后看下面的「如何获取 API Key」,按 1→4 步做。"),
				),

				/* 引导 */
				guide,

				/* 第 2 步:端点与 Key */
				h(
					"div",
					{ className: "dsh-htt-cfg__section" },
					h("div", { className: "dsh-htt-cfg__sechead" }, h("span", { className: "dsh-htt-cfg__num" }, "2"), "填端点与 Key"),
					h(
						"div",
						{ className: "dsh-htt-cfg__card" },
						h(
							"div",
							{ className: "dsh-htt-cfg__grid" },
							field(
								"engine",
								"识别引擎",
								h(
									"select",
									{
										id: "dsh-htt-engine",
										className: "dsh-htt-cfg__inp",
										value: form.asrEngine,
										onChange: set("asrEngine"),
										disabled: busy,
									},
									opt("cloud", "云端(更准,需联网)"),
									opt("local", "本地 SenseVoice(离线)"),
								),
							),
							field(
								"proto",
								"云端协议",
								h(
									"select",
									{
										id: "dsh-htt-proto",
										className: "dsh-htt-cfg__inp",
										value: form.cloudAsrApi,
										onChange: set("cloudAsrApi"),
										disabled: busy,
									},
									opt("chat-audio", "chat-audio(百炼)"),
									opt("transcriptions", "transcriptions(OpenAI 兼容)"),
								),
								"百炼要选 chat-audio;其他家一般选 transcriptions。",
							),
							field(
								"lang",
								"语言",
								h(
									"select",
									{
										id: "dsh-htt-lang",
										className: "dsh-htt-cfg__inp",
										value: form.cloudAsrLanguage,
										onChange: set("cloudAsrLanguage"),
										disabled: busy,
									},
									opt("zh", "中文"),
									opt("auto", "自动(中英混说)"),
									opt("en", "English"),
									opt("yue", "粤语"),
									opt("ja", "日本語"),
									opt("ko", "한국어"),
									),
								"中英夹术语时选「自动」更稳。",
							),
							h(
								"div",
								{ className: "dsh-htt-cfg__field" },
								h("label", { className: "dsh-htt-cfg__label", htmlFor: "dsh-htt-url" }, "云端端点"),
								h("input", {
									id: "dsh-htt-url",
									className: "dsh-htt-cfg__inp",
									type: "text",
									value: form.cloudAsrUrl,
									onChange: set("cloudAsrUrl"),
									placeholder: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
									spellCheck: false,
									disabled: busy,
								}),
							),
							h(
								"div",
								{ className: "dsh-htt-cfg__field" },
								h("label", { className: "dsh-htt-cfg__label", htmlFor: "dsh-htt-model" }, "模型 ID"),
								h("input", {
									id: "dsh-htt-model",
									className: "dsh-htt-cfg__inp",
									type: "text",
									value: form.cloudAsrModel,
									onChange: set("cloudAsrModel"),
									placeholder: "qwen3-asr-flash",
									spellCheck: false,
									disabled: busy,
								}),
							),
						),
						h(
							"div",
							{ className: "dsh-htt-cfg__field" },
							h("label", { className: "dsh-htt-cfg__label", htmlFor: "dsh-htt-key" }, "API Key"),
							h("input", {
								id: "dsh-htt-key",
								className: "dsh-htt-cfg__inp",
								type: "password",
								value: form.apiKey,
								onChange: set("apiKey"),
								placeholder: form.apiKeySet ? "已保存;留空表示不改" : "把控制台复制的 sk-... 粘到这里",
								autoComplete: "off",
								spellCheck: false,
								disabled: busy,
							}),
							h("div", { className: "dsh-htt-cfg__note" },
								form.apiKeySet && !form.apiKey ? "✓ 本机已保存一个 Key(不回显)。" : "粘贴后先点下一步的「测试连接」,成功再保存。"),
						),
					),
				),

				/* 第 3 步:测试连接 */
				h(
					"div",
					{ className: "dsh-htt-cfg__section" },
					h("div", { className: "dsh-htt-cfg__sechead" }, h("span", { className: "dsh-htt-cfg__num" }, "3"), "测试连接(不用先保存)"),
					h(
						"div",
						{ className: "dsh-htt-cfg__card" },
						h(
							"div",
							{ className: "dsh-htt-cfg__row" },
							h(
								"button",
								{
									type: "button",
									className: "dsh-htt-cfg__btn ghost",
									onClick: () => {
										void test();
									},
									disabled: busy || testing || !form.cloudAsrUrl,
								},
								testing ? "测试中…" : "测试连接",
							),
							testMessage
								? h(
										"span",
										{
											className:
												"dsh-htt-cfg__msg" +
												(testPhase === "err" ? " is-err" : testPhase === "testing" ? " is-warn" : ""),
											role: "status",
											"aria-live": "polite",
										},
										testMessage,
									)
								: null,
						),
						testDetail ? h("div", { className: "dsh-htt-cfg__detail" }, "原始返回:" + testDetail) : null,
						h(
							"div",
							{ className: "dsh-htt-cfg__note" },
							"测试会发 1.2 秒静音到你的服务商,只验证网络/鉴权/模型名,不产生真实语音内容。",
						),
					),
				),

				/* 第 4 步:上下文与词库 */
				h(
					"div",
					{ className: "dsh-htt-cfg__section" },
					h("div", { className: "dsh-htt-cfg__sechead" }, h("span", { className: "dsh-htt-cfg__num" }, "4"), "上下文与词库(可选,但很影响准确率)"),
					h(
						"div",
						{ className: "dsh-htt-cfg__card" },
						h(
							"label",
							{ className: "dsh-htt-cfg__check" },
							h("input", {
								type: "checkbox",
								checked: form.useDraftContext,
								onChange: set("useDraftContext"),
								disabled: busy,
							}),
							h("span", null, "把输入框里已有的内容一起当上下文发给云端(推荐)"),
						),
						h(
							"div",
							{ className: "dsh-htt-cfg__grid" },
							field(
								"chars",
								"上下文取末尾多少字符",
								h("input", {
									id: "dsh-htt-chars",
									className: "dsh-htt-cfg__inp",
									type: "number",
									min: 0,
									max: 3000,
									value: form.draftContextChars,
									onChange: set("draftContextChars"),
									disabled: busy || !form.useDraftContext,
								}),
								"0 = 不取;建议 200~500。",
							),
						),
						h(
							"label",
							{ className: "dsh-htt-cfg__check" },
							h("input", { type: "checkbox", checked: form.cloudFallbackToLocal, onChange: set("cloudFallbackToLocal"), disabled: busy }),
							h("span", null, "云端失败时自动回退本地识别(断网也不丢这句话)"),
						),
						h(
							"label",
							{ className: "dsh-htt-cfg__check" },
							h("input", { type: "checkbox", checked: form.cloudInterim, onChange: set("cloudInterim"), disabled: busy }),
							h(
								"span",
								null,
								"云端也做实时预览(边走边出字):每 " +
									Math.round((Number(form.cloudInterimIntervalMs) || 2000) / 100) / 10 +
									" 秒把最近几秒音频重发一次",
							),
						),
						h(
							"div",
							{ className: "dsh-htt-cfg__grid" },
							field(
								"interim",
								"预览间隔(毫秒)",
								h("input", {
									id: "dsh-htt-interim",
									className: "dsh-htt-cfg__inp",
									type: "number",
									min: 800,
									max: 10000,
									step: 200,
									value: form.cloudInterimIntervalMs,
									onChange: set("cloudInterimIntervalMs"),
									disabled: busy || !form.cloudInterim,
								}),
								"建议 1500~3000。每次预览都会按音频秒数计费,长按越久重复计费越多。",
							),
						),
						h(
							"label",
							{ className: "dsh-htt-cfg__check" },
							h("input", { type: "checkbox", checked: form.wordbankApplyToLocal, onChange: set("wordbankApplyToLocal"), disabled: busy }),
							h("span", null, "本地识别结果也套用词库的纠正规则"),
						),
					),
					h(
						"div",
						{ className: "dsh-htt-cfg__card" },
						h(
							"div",
							{ className: "dsh-htt-cfg__row" },
							h("span", { className: "dsh-htt-cfg__label" }, "用户词库"),
							h("span", { className: "dsh-htt-cfg__note" },
								form.wordbankTerms + " 个词条 · " + form.wordbankRules + " 条规则" +
								(form.wordbankPath ? " · " + form.wordbankPath : "")),
						),
						h("textarea", {
							id: "dsh-htt-words",
							className: "dsh-htt-cfg__inp dsh-htt-cfg__area",
							value: form.wordbank,
							onChange: set("wordbank"),
							placeholder: "# 每行一个词,支持纠正规则\nDeepSeek\nQwen3-ASR\n可达鸭=可达丫|可达压",
							spellCheck: false,
							disabled: busy,
						}),
						h(
							"div",
							{ className: "dsh-htt-cfg__note" },
							"纯词条 → 发给云端当术语表;\"正确=错写1|错写2\" → 结果里做替换(本地也生效)。改完保存,下一次长按生效。",
						),
					),
				),

				/* 底部保存 */
				h(
					"div",
					{ className: "dsh-htt-cfg__footer" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-htt-cfg__btn",
							onClick: () => {
								void save();
							},
							disabled: busy,
						},
						phase === "saving" ? "保存中…" : "保存",
					),
					dirty ? h("span", { className: "dsh-htt-cfg__dirty" }, "有未保存的修改") : null,
					h(
						"span",
						{
							className: "dsh-htt-cfg__msg" + (phase === "err" ? " is-err" : ""),
							role: "status",
							"aria-live": "polite",
						},
						message,
					),
				),
			);
		}

		function registerHoldToTalkSettings(ctx) {
			const slots = ctx.get("slots");
			if (!slots || typeof slots.register !== "function") return;
			try {
				slots.inject(SETTINGS_SLOT, () =>
					slots.register(
						{
							name: SETTINGS_SLOT,
							id: SETTINGS_ID,
							order: SETTINGS_ORDER,
							label: () => "语音输入",
						},
						HoldToTalkSettings,
					),
				);
			} catch (err) {
				console.warn(TAG, "设置页注册失败(长按浮层不受影响)", err);
			}
		}

		/* ------------------------------------------------------------ 浮层组件 */

		function formatSeconds(ms) {
			const total = Math.max(0, Math.floor(ms / 1000));
			const m = Math.floor(total / 60);
			const s = total % 60;
			return m > 0 ? m + ":" + (s < 10 ? "0" + s : s) : s + "s";
		}

		// 归属判定锚点:零尺寸、脱离文档流、不接收指针事件——只为"我属于哪个 composer"
		// 提供 DOM 锚点,对布局零影响(package 无关:浮层卡片自己是 position:fixed)
		const MARKER_STYLE = { position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none" };

		/** 把定稿文字追加到原草稿:中英文之间补一个空格,避免"hello世界"这种粘连 */
		function composeDraft(base, text) {
			const head = typeof base === "string" ? base : "";
			const sep = head !== "" && !/\s$/.test(head) ? " " : "";
			return head + sep + text;
		}

		function HoldToTalk(props) {
			const useInput = props.useInput;
			const inputActions = props.inputActions;
			const inputState = typeof useInput === "function" ? useInput((s) => s) : null;

			const rootRef = useRef(null);
			const cfgRef = useRef({ ...FALLBACK_CONFIG });
			const draftRef = useRef("");
			const healthRef = useRef({ status: "unknown", progress: 0 });
			const actionsRef = useRef({ setDraft: null, submit: null });

			const [phase, setPhase] = useState("idle");
			const [interim, setInterim] = useState("");
			const [armed, setArmed] = useState(false);
			const [message, setMessage] = useState("");
			const [meter, setMeter] = useState({ ms: 0, levels: [] });
			const [progress, setProgress] = useState(0);

			if (inputState && typeof inputState.draft === "string") draftRef.current = inputState.draft;
			actionsRef.current.setDraft = inputActions && typeof inputActions.setDraft === "function" ? inputActions.setDraft : null;
			actionsRef.current.submit = inputActions && typeof inputActions.submit === "function" ? inputActions.submit : null;

			useEffect(() => {
				ensureCss();
				bindGlobalOnce();

				let disposed = false;
				let healthTimer = null;
				let messageTimer = null;

				const clearMessageLater = (ms) => {
					if (messageTimer) clearTimeout(messageTimer);
					messageTimer = setTimeout(() => {
						if (!disposed) {
							setMessage("");
							setPhase((p) => (p === "error" ? "idle" : p));
						}
					}, ms);
				};

				const ui = {
					self: null,
					getConfig: () => cfgRef.current,
					setPhase,
					setInterim,
					setArmed,
					setMessage,
					setMeter,
					clearMessageLater,
					clearIfIdle: () => {
						setPhase((p) => (p === "error" ? "idle" : p));
					},
					insertText: (text) => {
						const setDraft = actionsRef.current.setDraft;
						if (!setDraft) return false;
						const base = draftRef.current || "";
						const next = composeDraft(base, text);
						try {
							setDraft(next);
						} catch (err) {
							console.warn(TAG, "写入草稿失败", err);
							return false;
						}
						draftRef.current = next;
						if (cfgRef.current.autoSend && actionsRef.current.submit) {
							setTimeout(() => {
								try {
									actionsRef.current.submit();
								} catch (err) {
									/* ignore */
								}
							}, 80);
						}
						return true;
					},
					onModelPreparing: (data) => {
						const ratio = data && typeof data.progress === "number" ? data.progress : 0;
						healthRef.current = { status: "downloading", progress: ratio };
						if (!disposed) setProgress(ratio);
					},
				};

				const controller = createController(ui);
				ui.self = controller;

				const instance = {
					controller,
					// 归属判定:不管浮层卡片当前是否可见,我的节点和这个输入框在同一个
					// composer 卡片里,就归我处理(见 nodeOwnsEditor 的注释)
					ownsEditor: (editorEl) => nodeOwnsEditor(rootRef.current, editorEl),
					onMouseDown: (e) => controller.onMouseDown(e),
					onMouseMove: (e) => controller.onMouseMove(e),
					onMouseUp: (e) => controller.onMouseUp(e),
					onKeyDown: (e) => controller.onKeyDown(e),
					onBlur: () => controller.onBlur(),
				};
				registry.instances.push(instance);

				// 配置 + 预热模型(后台把 228MB 模型准备好,省得第一次长按干等)
				(async () => {
					try {
						const res = await fetch(API + "/config", { headers: { accept: "application/json" } });
						if (res.ok) {
							const data = await res.json();
							if (!disposed) cfgRef.current = { ...FALLBACK_CONFIG, ...data };
						}
					} catch (err) {
						/* 路由不可用时用默认值 */
					}
					try {
						await fetch(API + "/health?prepare=1", { headers: { accept: "application/json" } });
					} catch (err) {
						/* ignore */
					}
				})();

				healthTimer = setInterval(async () => {
					if (disposed) return;
					try {
						const res = await fetch(API + "/health", { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						const model = (data && data.model) || {};
						healthRef.current = { status: model.status || "unknown", progress: model.progress || 0 };
						if (model.status === "ready") {
							clearInterval(healthTimer);
							healthTimer = null;
						}
					} catch (err) {
						/* ignore */
					}
				}, 3000);

				return () => {
					disposed = true;
					if (healthTimer) clearInterval(healthTimer);
					if (messageTimer) clearTimeout(messageTimer);
					const index = registry.instances.indexOf(instance);
					if (index >= 0) registry.instances.splice(index, 1);
					controller.abort();
				};
			}, []);

			const showCard = phase !== "idle" || interim !== "" || message !== "";

			const levels = meter.levels && meter.levels.length ? meter.levels : [];
			const bars = [];
			for (let i = 0; i < 9; i++) {
				const sample = levels.length ? levels[Math.max(0, levels.length - 9 + i)] : 0;
				const height = Math.max(3, Math.min(18, Math.round(sample * 46)));
				bars.push(h("i", { key: i, style: { height: height + "px" } }));
			}

			let hint;
			if (armed) hint = "松开取消";
			else if (phase === "holding") hint = "松开发送 · 上滑取消";
			else if (phase === "working") hint = message || "识别中…";
			else if (message) hint = message;
			else hint = "";

			const modelHint =
				healthRef.current.status === "downloading"
					? "语音模型准备中 " + Math.round((healthRef.current.progress || 0) * 100) + "%(首次使用需下载 228MB,仅一次)"
					: healthRef.current.status === "error"
						? "语音模型准备失败,请查看宿主日志"
						: "";

			// 外层标记节点**永远渲染**(哪怕卡片隐藏):它是归属判定的锚点,也是
			// 长按在第一次成功之后还能继续工作的前提(见 nodeOwnsEditor 注释)。
			return h(
				"span",
				{ ref: rootRef, className: "dsh-htt-src", style: MARKER_STYLE },
				showCard
					? h(
							"div",
							{ className: "dsh-htt" },
							h(
								"div",
								{ className: "dsh-htt__card" + (armed ? " is-armed" : "") },
								h(
									"div",
									{ className: "dsh-htt__row" },
									h(
										"span",
										{ className: "dsh-htt__mic" + (phase === "holding" && !armed ? " is-live" : "") },
										armed ? "✕" : phase === "holding" ? "●" : phase === "working" ? "⋯" : "🎤",
									),
									h("span", { className: "dsh-htt__wave" }, bars),
									h("span", { className: "dsh-htt__time" }, formatSeconds(meter.ms || 0)),
								),
								hint ? h("div", { className: "dsh-htt__hint" }, hint) : null,
								interim ? h("div", { className: "dsh-htt__text" }, interim) : null,
								!interim && phase === "working" ? h("div", { className: "dsh-htt__text dsh-htt__text--pending" }, "正在识别整段语音…") : null,
								modelHint ? h("div", { className: "dsh-htt__hint dsh-htt__text--warn" }, modelHint) : null,
								healthRef.current.status === "downloading" && progress > 0
									? h("div", { className: "dsh-htt__bar" }, h("span", { style: { width: Math.round(progress * 100) + "%" } }))
									: null,
							),
						)
					: null,
			);
		}

		/* --------------------------------------------------------------- 注册 */

		function apply(ctx) {
			ensureCss();
			const slots = ctx.get("slots");
			if (!slots) {
				console.warn(TAG, "slots 服务不可用,浮层未注册");
				return;
			}
			slots.inject("conversation.input.overlay", () =>
				slots.register(
					{
						name: "conversation.input.overlay",
						id: "hold-to-talk",
						order: 30,
					},
					HoldToTalk,
				),
			);
			// 设置 → 左侧「语音输入」页(用户词库 / 云端端点 / 提示词开关)
			registerHoldToTalkSettings(ctx);
		}

		module.exports = {
			name: "dsh-hold-to-talk",
			inject: ["slots"],
			apply,
			// 仅供 tools/ 下的离线测试驱动核心逻辑;DSH 运行时不会读这个字段
			__test: { createController, composeDraft, resampleTo16k, createBuffer, registry, nodeOwnsEditor, pickInstanceFor, toBase64Url, readEditorDraft },
		};
		return module.exports;
	},
});
