// 两个翻译源。都实现 translateMany(texts, { sourceLang, targetLang }) -> Promise<string[]>，
// 返回与 texts 等长、一一对应的译文；失败时抛出 TranslateError（message 可直接展示给用户）。

import { translateAligned, protectMarkup, assembleMarkup, splitLongText, encodedCost } from "./text.js";

export class TranslateError extends Error {
    constructor(message, code = "error") {
        super(message);
        this.name = "TranslateError";
        this.code = code;
    }
}

// 带超时的请求。计时器一直开到响应体读完，避免「连上了但一直不返回」卡死在「翻译中」。
// hint（可选）会追加在超时 / 断网提示后面，用来说明这条路线常见的原因。
async function request(fetchFn, url, init, timeoutMs, what, hint = "") {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetchFn(url, { ...init, signal: ctrl.signal });
        const text = await resp.text();
        return {
            status: resp.status,
            ok: resp.ok,
            text,
            contentType: resp.headers?.get?.("content-type") || "",
        };
    } catch (err) {
        if (ctrl.signal.aborted) {
            throw new TranslateError(`${what}请求超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）${hint || "，请检查网络后重试"}`, "timeout");
        }
        throw new TranslateError(`${what}网络请求失败：${err?.message || err}${hint}`, "network");
    } finally {
        clearTimeout(timer);
    }
}

/* ===================== DeepSeek（OpenAI 兼容接口） ===================== */

const BASE_PROMPT = (src, dst) =>
    `你是专业翻译。将以下${src}文本翻译成${dst}。要求：\n1. 仅输出译文，不要解释\n2. 严格保留原文的段落结构与换行\n3. 人名和专有名词应保留原文或准确音译\n4. 保持原文语气和风格\n5. 如果文本中混有其他语言，只翻译需要翻译的内容\n6. 原文中的 Markdown 标记（如 *动作描写*、**强调**）和引号原样保留，只翻译其中的文字`;

const BATCH_PROMPT_EXTRA =
    "\n7. 原文被分成若干段，每段以单独一行的 [[编号]] 开头。译文必须保留每个 [[编号]] 标记，编号和顺序不变，每段译文紧跟在对应的标记之后；不要合并、拆分、增删段落，也不要翻译标记本身";

// 解析带 [[n]] 编号的译文。编号不齐全、乱序或某段为空时返回 null（调用方会拆小重发）。
export function parseNumbered(content, n) {
    const blocks = [];
    let cur = null;
    for (const line of String(content).replace(/\r\n?/g, "\n").split("\n")) {
        const m = line.match(/^\s*\[\[(\d+)\]\]\s*(.*)$/);
        if (m) {
            cur = { id: Number(m[1]), lines: m[2] ? [m[2]] : [] };
            blocks.push(cur);
        } else if (cur) {
            cur.lines.push(line);
        }
    }
    if (blocks.length !== n) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
        if (blocks[i].id !== i + 1) return null;
        const t = blocks[i].lines.join("\n").trim();
        if (!t) return null;
        out.push(t);
    }
    return out;
}

function deepseekHttpError(status, data, rawText) {
    let detail = data?.error?.message || data?.message || "";
    if (!detail && rawText && rawText.length < 200 && !rawText.trimStart().startsWith("<")) detail = rawText;
    detail = detail ? `：${String(detail).slice(0, 120)}` : "";
    const map = {
        400: "请求参数有误（模型名是否正确？）",
        401: "API Key 无效或已失效",
        402: "账户余额不足",
        403: "没有权限访问该接口或模型",
        404: "接口地址不对，API 地址应填到 /v1",
        429: "请求过于频繁或额度用尽，请稍后再试",
    };
    const base = map[status] || (status >= 500 ? "翻译服务暂时不可用" : "请求失败");
    return new TranslateError(`翻译失败（HTTP ${status}）${base}${detail}`, "http");
}

export function createDeepSeekProvider({ getConfig, fetchFn = (...a) => fetch(...a), timeoutMs = 60000, maxCost = 3000 } = {}) {
    async function chat(system, user) {
        const s = getConfig();
        if (!s.apiKey) throw new TranslateError("请先在设置里填写 DeepSeek 的 API Key", "no_key");
        let url = String(s.apiUrl || "").trim().replace(/\/+$/, "");
        if (!url) throw new TranslateError("请先在设置里填写 API 地址", "no_url");
        if (!url.endsWith("/chat/completions")) url += "/chat/completions";

        const r = await request(
            fetchFn,
            url,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
                body: JSON.stringify({
                    model: s.model,
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: user },
                    ],
                    temperature: 0.2,
                    max_tokens: 4096,
                }),
            },
            timeoutMs,
            "翻译接口"
        );
        let data = null;
        try { data = JSON.parse(r.text); } catch { /* 不是 JSON */ }
        if (!r.ok) throw deepseekHttpError(r.status, data, r.text);
        const content = data?.choices?.[0]?.message?.content;
        if (!content || !String(content).trim()) throw new TranslateError("翻译接口返回了空内容", "empty");
        return String(content).trim();
    }

    function sendBatchFactory({ sourceLang, targetLang }) {
        return async (items) => {
            if (items.length === 1) return [await chat(BASE_PROMPT(sourceLang, targetLang), items[0])];
            const user = items.map((t, i) => `[[${i + 1}]]\n${t}`).join("\n\n");
            const content = await chat(BASE_PROMPT(sourceLang, targetLang) + BATCH_PROMPT_EXTRA, user);
            return parseNumbered(content, items.length);
        };
    }

    return {
        id: "deepseek",
        // 多个段落合并成一次请求；编号对不上时自动拆小重发
        async translateMany(texts, direction) {
            if (!texts.length) return [];
            return translateAligned(texts, sendBatchFactory(direction), { maxCost, itemOverhead: 12 });
        },
        // 输入框翻译用：整段原样发送，不拆段
        async translateRaw(text, { sourceLang, targetLang }) {
            return chat(BASE_PROMPT(sourceLang, targetLang), text);
        },
    };
}

/* ===================== 谷歌翻译（酒馆后端 /api/translate/google） ===================== */

const GOOGLE_LANGS = {
    简体中文: "zh-CN", 中文: "zh-CN", 汉语: "zh-CN", chinese: "zh-CN", "simplified chinese": "zh-CN",
    繁体中文: "zh-TW", 繁體中文: "zh-TW", "traditional chinese": "zh-TW",
    英语: "en", 英文: "en", english: "en",
    日语: "ja", 日文: "ja", 日本語: "ja", japanese: "ja",
    韩语: "ko", 韩文: "ko", 한국어: "ko", korean: "ko",
    法语: "fr", french: "fr",
    德语: "de", german: "de",
    俄语: "ru", russian: "ru",
    西班牙语: "es", spanish: "es",
    意大利语: "it", italian: "it",
    葡萄牙语: "pt", portuguese: "pt",
    阿拉伯语: "ar", arabic: "ar",
    泰语: "th", thai: "th",
    越南语: "vi", vietnamese: "vi",
    印尼语: "id", indonesian: "id",
};

// 把「简体中文」「English」这类语言名转成谷歌的语言代码；也接受直接填代码（fr、zh-CN）。
export function resolveGoogleLang(name) {
    const raw = String(name || "").trim();
    const hit = GOOGLE_LANGS[raw] || GOOGLE_LANGS[raw.toLowerCase()];
    if (hit) return hit;
    if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw)) return raw;
    throw new TranslateError(`谷歌翻译不认识语言「${raw}」，请在自定义语言里改填语言代码，例如 fr、de、zh-CN`, "lang");
}

const SEP = "\n\n";
const SEP_RE = /\n[ \t]*\n+/;
const isCJK = (lang) => /^(zh|ja|ko)/i.test(lang);

// 两条路线：
//   backend  浏览器 → 酒馆后端 /api/translate/google → 谷歌。后端是 Node 进程，不读系统代理。
//   direct   浏览器 / WebView 直接请求谷歌，走的是浏览器自己的网络（系统代理、VPN 都管用）。
const ROUTE_LABEL = { backend: "谷歌翻译（酒馆后端）", direct: "谷歌翻译（浏览器直连）" };
const BACKEND_URL = "/api/translate/google";
const DIRECT_URL = "https://translate.googleapis.com/translate_a/single";

const BACKEND_HINT = "。通常是运行酒馆的设备访问不了谷歌（请检查梯子 / VPN）；如果浏览器能上谷歌，则是酒馆后端没走代理（后端不读系统代理），可在酒馆 config.yaml 配置 requestProxy 后重启，或在设置里把「谷歌连接方式」改成浏览器直连";
const DIRECT_HINT = "。可能是这台设备访问不了谷歌（请检查梯子 / VPN），也可能是当前环境的跨域限制拦截了请求；可在设置里把「谷歌连接方式」改成酒馆后端";

function googleHttpError(status, route) {
    const label = ROUTE_LABEL[route];
    if (route === "backend" && status === 404) {
        return new TranslateError("当前环境没有谷歌翻译接口（/api/translate/google 返回 404），请改用浏览器直连或 DeepSeek", "not_found");
    }
    if (route === "backend" && (status === 401 || status === 403)) {
        return new TranslateError(`酒馆后端拒绝了请求（HTTP ${status}），请刷新页面后重试`, "auth");
    }
    if (status === 400 || status === 413 || status === 414) {
        return new TranslateError(`${label}拒绝了请求（HTTP ${status}）：文本过长，或语言代码不被支持`, "too_long");
    }
    if (status === 429) {
        return new TranslateError(`${label}请求过于频繁（HTTP 429），请稍后再试`, "http");
    }
    if (status >= 500) {
        return new TranslateError(
            route === "backend"
                ? `酒馆后端无法从谷歌取得译文（HTTP ${status}）${BACKEND_HINT}`
                : `谷歌服务器暂时不可用（HTTP ${status}），请稍后再试`,
            "upstream"
        );
    }
    return new TranslateError(`${label}请求失败（HTTP ${status}）`, "http");
}

function parseGoogleBody(r) {
    let text = r.text;
    if (/json/i.test(r.contentType)) {
        try {
            const data = JSON.parse(text);
            text = typeof data === "string" ? data : data?.translation ?? data?.text ?? data?.result ?? "";
        } catch { /* 当作纯文本 */ }
    }
    if (!String(text).trim()) throw new TranslateError("谷歌翻译返回了空内容", "empty");
    return String(text);
}

// 直连接口返回嵌套数组：[[["译文片段","原文片段",...], ...], ...]，把各片段的译文按顺序拼起来（换行就在片段里）。
function parseDirectBody(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new TranslateError(`${ROUTE_LABEL.direct}返回了看不懂的内容（可能被网络劫持或要求验证），请稍后再试`, "upstream");
    }
    const segs = Array.isArray(data?.[0]) ? data[0] : [];
    const out = segs.map((s) => (typeof s?.[0] === "string" ? s[0] : "")).join("");
    if (!out.trim()) throw new TranslateError("谷歌翻译返回了空内容", "empty");
    return out;
}

// mode：getMode() 返回 "auto"（默认优先直连，不通就改走后端，并记住哪条通）| "direct" | "backend"。
// 不传 getMode 时固定走后端（旧行为）。
export function createGoogleProvider({
    getHeaders,
    getMode = () => "backend",
    fetchFn = (...a) => fetch(...a),
    timeoutMs = 20000,
    directTimeoutMs = 15000,
    maxCost = 3500, // 后端路线每次请求的编码后长度上限
    directMaxCost = 2000, // 直连是 GET，文字在网址里，上限要更保守
} = {}) {
    let learned = null; // auto 模式下最近一次成功的路线
    let lastRoute = null; // 任何模式下最近一次成功的路线（给「测试连接」显示用）

    async function callBackend(text, lang) {
        const headers = { "Content-Type": "application/json", ...(getHeaders?.() || {}) };
        const r = await request(
            fetchFn,
            BACKEND_URL,
            { method: "POST", headers, body: JSON.stringify({ text, lang }) },
            timeoutMs,
            ROUTE_LABEL.backend,
            BACKEND_HINT
        );
        if (!r.ok) throw googleHttpError(r.status, "backend");
        return parseGoogleBody(r);
    }

    async function callDirect(text, lang) {
        let url;
        try {
            url = `${DIRECT_URL}?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
        } catch {
            throw new TranslateError("文本里含有无法编码的字符", "encode");
        }
        // 不加任何自定义请求头：加了就会触发跨域预检，谷歌不会放行。
        const r = await request(
            fetchFn,
            url,
            { method: "GET", credentials: "omit", referrerPolicy: "no-referrer" },
            directTimeoutMs,
            ROUTE_LABEL.direct,
            DIRECT_HINT
        );
        if (!r.ok) throw googleHttpError(r.status, "direct");
        return parseDirectBody(r.text);
    }

    const calls = { backend: callBackend, direct: callDirect };
    const currentMode = () => {
        const m = getMode?.();
        return m === "auto" || m === "direct" ? m : "backend";
    };
    const budget = () => {
        const m = currentMode();
        if (m === "backend") return maxCost;
        if (m === "direct") return directMaxCost;
        return learned === "backend" ? maxCost : directMaxCost;
    };

    // 按模式依次尝试路线。文本太长 / 语言不对这类「换路线也没用」的错误直接抛出。
    async function callOnce(text, lang) {
        const mode = currentMode();
        const routes = mode === "auto" ? (learned === "backend" ? ["backend", "direct"] : ["direct", "backend"]) : [mode];
        const errors = [];
        for (const route of routes) {
            try {
                const out = await calls[route](text, lang);
                lastRoute = route;
                if (mode === "auto") learned = route;
                return out;
            } catch (err) {
                if (!(err instanceof TranslateError) || err.code === "too_long" || err.code === "lang" || routes.length === 1) throw err;
                errors.push(err);
            }
        }
        throw new TranslateError(errors.map((e) => e.message).join(" ｜ "), errors[errors.length - 1].code);
    }

    function sendBatchFactory(lang) {
        return async (items) => {
            if (items.length === 1) return [(await callOnce(items[0], lang)).trim()];
            let out;
            try {
                out = await callOnce(items.join(SEP), lang);
            } catch (err) {
                if (err.code === "too_long") return null; // 太长：交给上层拆小重发
                throw err;
            }
            const parts = out.trim().split(SEP_RE);
            return parts.length === items.length ? parts.map((s) => s.trim()) : null;
        };
    }

    return {
        id: "google",
        // 最近一次成功用的路线："direct" | "backend" | null
        lastRoute: () => lastRoute,
        async translateMany(texts, { targetLang }) {
            if (!texts.length) return [];
            const lang = resolveGoogleLang(targetLang);
            const cost = budget();

            // 1. 每段拆成「保留的标记」和「待翻译的文字」，只翻译文字（相同文字只翻一次）
            const plans = texts.map(protectMarkup);
            const coreIndex = new Map();
            const cores = [];
            for (const parts of plans) {
                for (const p of parts) {
                    if (!p.keep && !coreIndex.has(p.core)) {
                        coreIndex.set(p.core, cores.length);
                        cores.push(p.core);
                    }
                }
            }

            // 2. 超长的文字在句子边界切开，再和其他片段一起分批发送
            const pieceLists = cores.map((c) => splitLongText(c, cost, encodedCost));
            const flat = pieceLists.flat().map((p) => p.text);
            const flatOut = await translateAligned(flat, sendBatchFactory(lang), {
                maxCost: cost,
                cost: encodedCost,
                itemOverhead: encodedCost(SEP),
            });

            // 3. 切开的长文字拼回去，再把标记按原位置还原
            let k = 0;
            const coreOut = pieceLists.map((list) =>
                list.map((p) => flatOut[k++] + (isCJK(lang) ? "" : p.sep)).join("").trim()
            );
            if (coreOut.some((s) => !s)) throw new TranslateError("谷歌翻译返回了空内容", "empty");
            return plans.map((parts) => assembleMarkup(parts, (core) => coreOut[coreIndex.get(core)]).trim());
        },
    };
}
