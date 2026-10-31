import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
// getRequestHeaders 用命名空间导入：万一这个版本没有导出它，也只是拿到 undefined，不会让整个扩展加载失败。
import * as STScript from "../../../../script.js";

import { escapeHtml, renderInlineMarkup, hashString, splitParagraphs, splitPlainParagraphs } from "./lib/text.js";
import { createCache } from "./lib/cache.js";
import { createDeepSeekProvider, createGoogleProvider } from "./lib/providers.js";

const extensionName = "dual-translate";

const languagePairs = {
    "en-zh": {
        label: "英语 ⇄ 简体中文",
        assistant: { sourceLang: "英语", targetLang: "简体中文" },
        user: { sourceLang: "简体中文", targetLang: "英语" },
    },
    "ja-zh": {
        label: "日语 ⇄ 简体中文",
        assistant: { sourceLang: "日语", targetLang: "简体中文" },
        user: { sourceLang: "简体中文", targetLang: "日语" },
    },
};

const defaultSettings = {
    enabled: true,
    translateProvider: "deepseek", // "deepseek" | "google"
    googleMode: "auto", // 谷歌连接方式："auto" 先试浏览器直连、不通再走酒馆后端 | "direct" 只直连 | "backend" 只走酒馆后端
    apiUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    languagePair: "en-zh",
    targetLang: "简体中文",
    userTargetLang: "English",
    autoTranslate: false,
    barColor: "#4a90d9",
    displayMode: "inline", // "inline" | "block"
    legacyImport: true, // 是否把 2.x 版存在聊天记录里的旧译文导入新缓存
};

const TR_SEL = ".dt-block, .dt-inline"; // 译文元素
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = () => extension_settings[extensionName];

/* ===================== 缓存与翻译源 ===================== */
function safeStorage() {
    try {
        const s = window.localStorage;
        s.getItem("dual-translate:probe");
        return s;
    } catch {
        return null; // 读不到 localStorage：缓存只放内存，刷新后丢失
    }
}

const cache = createCache({
    storage: safeStorage(),
    storageKey: "dual-translate:cache:v1",
    maxEntries: 5000,
    maxChars: 1200000,
});

const getHeaders = () =>
    typeof STScript.getRequestHeaders === "function" ? STScript.getRequestHeaders() : { "Content-Type": "application/json" };

const deepseek = createDeepSeekProvider({ getConfig: settings });
const GOOGLE_MODES = ["auto", "direct", "backend"];
const google = createGoogleProvider({ getHeaders, getMode: () => settings().googleMode });
const providers = { deepseek, google };
const currentProvider = () => providers[settings().translateProvider] || deepseek;

/* ===================== 工具 ===================== */
function safeColor(c) {
    return /^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#4a90d9";
}

function getTranslationDirection(isUser) {
    const s = settings();
    const pair = languagePairs[s.languagePair];
    if (pair) return isUser ? pair.user : pair.assistant;

    return {
        sourceLang: "自动识别的语言",
        targetLang: isUser ? s.userTargetLang : s.targetLang,
    };
}

function syncLanguageControls() {
    const s = settings();
    const pair = languagePairs[s.languagePair];
    const isCustom = !pair;

    if (pair) {
        s.targetLang = pair.assistant.targetLang;
        s.userTargetLang = pair.user.targetLang;
    }

    $("#dt_language_pair").val(isCustom ? "custom" : s.languagePair);
    $("#dt_target_lang").val(s.targetLang).prop("disabled", !isCustom);
    $("#dt_user_target_lang").val(s.userTargetLang).prop("disabled", !isCustom);
    $("#dt_custom_languages").toggle(isCustom);
    $("#dt_pair_hint").text(pair
        ? `AI 正文：${pair.assistant.sourceLang} → ${pair.assistant.targetLang}；输入框：${pair.user.sourceLang} → ${pair.user.targetLang}`
        : "AI 将自动识别原文语言，并翻译为下面填写的目标语言。");
}

// 翻译源切换后的界面：选谷歌时不需要 Key，DeepSeek 设置折叠起来（输入框翻译按钮仍然用它）。
function syncProviderControls(provider) {
    const isGoogle = settings().translateProvider === "google";
    $("#dt_provider").val(settings().translateProvider);
    $("#dt_google_settings").toggle(isGoogle);
    $("#dt_google_mode").val(settings().googleMode);
    $("#dt_ds_summary").text(isGoogle ? "输入框翻译所用的 DeepSeek 设置" : "DeepSeek 设置");
    $("#dt_ds_note").toggle(isGoogle);
    if (provider !== false) $("#dt_ds_details").prop("open", !isGoogle);
}

function updateCacheStats() {
    const { count, chars, maxEntries } = cache.stats();
    const kb = Math.max(1, Math.round((chars * 2) / 1024));
    $("#dt_cache_stats").text(`已缓存 ${count} 段译文，约 ${kb} KB（最多保留 ${maxEntries} 段，超出后自动淘汰最久没用到的）`);
}

/* ===================== 设置 ===================== */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];

    // 从 2.0 的两个自由输入框迁移，避免覆盖用户已有的自定义语言。
    if (s.languagePair === undefined) {
        const oldAssistantTarget = (s.targetLang || defaultSettings.targetLang).trim().toLowerCase();
        const oldUserTarget = (s.userTargetLang || defaultSettings.userTargetLang).trim().toLowerCase();
        const isChinese = ["简体中文", "中文", "chinese", "simplified chinese"].includes(oldAssistantTarget);
        if (isChinese && ["english", "英语", "英文"].includes(oldUserTarget)) {
            s.languagePair = "en-zh";
        } else if (isChinese && ["日语", "日文", "日本語", "japanese"].includes(oldUserTarget)) {
            s.languagePair = "ja-zh";
        } else {
            s.languagePair = "custom";
        }
    }

    // 只补缺省项，已有的值（API 地址、Key、模型等）原样保留。
    for (const k in defaultSettings) {
        if (s[k] === undefined) s[k] = defaultSettings[k];
    }
    if (!providers[s.translateProvider]) s.translateProvider = "deepseek";
    if (!GOOGLE_MODES.includes(s.googleMode)) s.googleMode = "auto";

    $("#dt_enabled").prop("checked", s.enabled);
    $("#dt_auto").prop("checked", s.autoTranslate);
    $("#dt_api_url").val(s.apiUrl);
    $("#dt_api_key").val(s.apiKey);
    $("#dt_model").val(s.model);
    syncLanguageControls();
    syncProviderControls();
    $("#dt_bar_color").val(s.barColor);
    $("#dt_display_mode").val(s.displayMode);
    updateCacheStats();
}

/* ===================== 段落缓存 ===================== */
const paraKey = (provider, direction, text) => `${provider.id}|${direction.targetLang}|${hashString(text)}`;

// 2.x 版把整条消息的译文存在 msg.extra 里。能一一对上段落的才导入，对不上就放弃（重新翻译）。
function legacyTranslation(msg, direction) {
    const v = msg.extra?.dt_translations?.[`${direction.sourceLang}->${direction.targetLang}`];
    if (v) return v;
    if (settings().languagePair === "en-zh") return msg.extra?.[msg.is_user ? "dt_user_cache" : "dt_cache"] || null;
    return null;
}

function importLegacy(msg, direction, paras, keys) {
    if (!settings().legacyImport) return false;
    const old = legacyTranslation(msg, direction);
    if (!old) return false;
    const oldParas = splitPlainParagraphs(old);
    const allIdx = paras.map((_, i) => i);
    const trIdx = allIdx.filter((i) => paras[i].translate);
    let target;
    if (oldParas.length === paras.length) target = allIdx;
    else if (oldParas.length === trIdx.length) target = trIdx;
    else return false;
    target.forEach((i, j) => {
        if (paras[i].translate && !cache.has(keys[i])) cache.set(keys[i], oldParas[j]);
    });
    return true;
}

function analyze(msg, direction, provider) {
    const paras = splitParagraphs(msg.mes || "");
    const keys = paras.map((p) => (p.translate ? paraKey(provider, direction, p.text) : null));
    return { paras, keys };
}

function readCached(paras, keys) {
    let complete = true;
    const trans = paras.map((p, i) => {
        if (!p.translate) return null;
        const v = cache.get(keys[i]);
        if (v === undefined) complete = false;
        return v;
    });
    return { trans, complete };
}

// 只读缓存，不发请求。每个需要翻译的段落都有缓存才返回结果，否则返回 null。
function peekTranslations(msg, direction) {
    const provider = currentProvider();
    const { paras, keys } = analyze(msg, direction, provider);
    if (!paras.some((p) => p.translate)) return null;
    let r = readCached(paras, keys);
    if (!r.complete && provider.id === "deepseek" && importLegacy(msg, direction, paras, keys)) {
        r = readCached(paras, keys);
    }
    return r.complete ? { paras, trans: r.trans } : null;
}

const inflight = new Map(); // 缓存键 -> 正在进行的请求，避免同一段落同时发两次

// 只把没有缓存的段落发给翻译源。
async function fillMissing(provider, direction, paras, keys) {
    const need = new Map();
    const waits = [];
    let total = 0;
    let hits = 0;
    paras.forEach((p, i) => {
        if (!p.translate) return;
        total++;
        const k = keys[i];
        if (cache.has(k)) hits++;
        else if (inflight.has(k)) waits.push(inflight.get(k));
        else if (!need.has(k)) need.set(k, p.text);
    });

    if (need.size) {
        const ks = [...need.keys()];
        const texts = [...need.values()];
        const chars = texts.reduce((n, t) => n + t.length, 0);
        console.info(`[dual-translate] 请求 ${provider.id}：本条共 ${total} 段，缓存命中 ${hits} 段，本次发送 ${texts.length} 段（${chars} 字符）`);
        const job = provider.translateMany(texts, direction).then((arr) => {
            ks.forEach((k, j) => cache.set(k, arr[j]));
        });
        ks.forEach((k) => inflight.set(k, job));
        try {
            await job;
        } finally {
            ks.forEach((k) => inflight.delete(k));
        }
    } else {
        console.info(`[dual-translate] 本条共 ${total} 段，全部来自缓存或正在翻译中，不发送请求`);
    }
    await Promise.all(waits);
    updateCacheStats();
}

// 取得整条消息的译文；缺的部分会请求翻译源。失败时抛出带明确提示的错误。
async function ensureTranslations(msg, direction) {
    const provider = currentProvider();
    const { paras, keys } = analyze(msg, direction, provider);
    let r = readCached(paras, keys);
    if (!r.complete && provider.id === "deepseek" && importLegacy(msg, direction, paras, keys)) {
        r = readCached(paras, keys);
    }
    if (!r.complete) {
        await fillMissing(provider, direction, paras, keys);
        r = readCached(paras, keys);
        if (!r.complete) throw new Error("译文数量与原文不一致");
    }
    return { paras, trans: r.trans };
}

/* ===================== 渲染 ===================== */
function blockHtml(color, trans) {
    const items = trans.filter((t) => t != null).map((t) => `<p>${renderInlineMarkup(t)}</p>`).join("");
    return `<div class="dt-block" style="border-left-color:${color}">${items}</div>`;
}

// 整块渲染（原版样式）
function renderBlock(mesEl, trans) {
    mesEl.find(".mes_text").after($(blockHtml(safeColor(settings().barColor), trans)));
}

// 逐段对照渲染：译文按下标贴在对应原文元素后面
function renderInline(mesEl, trans) {
    const color = safeColor(settings().barColor);
    const mesText = mesEl.find(".mes_text");
    const children = mesText.children().not(".dt-inline, .dt-block, .dt-status");

    // 无法匹配段落时退回整块
    if (children.length === 0 || !trans.some((t) => t != null)) {
        renderBlock(mesEl, trans);
        return;
    }

    trans.forEach((t, i) => {
        if (t == null) return;
        const el = $(`<div class="dt-inline" style="border-left-color:${color}">${renderInlineMarkup(t)}</div>`);
        // 译文段数多于原文子元素：追加到末尾
        if (i < children.length) $(children[i]).after(el);
        else mesText.append(el);
    });
}

function renderTranslation(mesEl, trans) {
    mesEl.find(TR_SEL).remove();
    if (settings().displayMode === "inline") renderInline(mesEl, trans);
    else renderBlock(mesEl, trans);
    mesEl.attr("data-dt-shown", "1");
}

function renderMessage(mesId, trans) {
    const mesEl = $(`.mes[mesid="${mesId}"]`);
    if (mesEl.length) renderTranslation(mesEl, trans);
}

// 状态行：翻译中 / 出错（带重试按钮）。放在 .mes_text 外面，酒馆重新渲染消息时不会被冲掉。
function setStatus(mesId, kind, text, onRetry) {
    const mesEl = $(`.mes[mesid="${mesId}"]`);
    mesEl.find(".dt-status").remove();
    if (!kind || !mesEl.length) return;
    const el = $(`<div class="dt-status dt-${kind}"></div>`);
    if (kind === "loading") el.css("border-left-color", safeColor(settings().barColor));
    el.append($("<span class=\"dt-status-text\"></span>").text(text));
    if (kind === "error" && onRetry) {
        el.append(
            $('<button type="button" class="dt-retry menu_button">重试</button>').on("click", (e) => {
                e.stopPropagation();
                onRetry();
            })
        );
    }
    mesEl.find(".mes_text").after(el);
}

/* ===================== 翻译一条消息 ===================== */
const runs = new Map(); // mesId -> 最新一次操作的编号，用来丢弃过期结果
let runCounter = 0;

// 不带界面状态，失败时抛错。「翻译全部」用它。
async function translateQuiet(mesId) {
    const msg = getContext().chat?.[mesId];
    if (!msg) return false;
    const startText = msg.mes;
    const { trans } = await ensureTranslations(msg, getTranslationDirection(msg.is_user));
    if (msg.mes === startText) renderMessage(mesId, trans);
    return true;
}

// 翻译并显示一条消息：先看缓存，再发请求；显示「翻译中」，失败显示错误和重试按钮。从不抛错。
async function translateMessage(mesId) {
    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return false;
    const direction = getTranslationDirection(msg.is_user);
    const startText = msg.mes;
    const runId = ++runCounter;
    runs.set(mesId, runId);

    const peeked = peekTranslations(msg, direction);
    if (peeked) {
        setStatus(mesId, null);
        renderMessage(mesId, peeked.trans);
        return true;
    }
    if (!msg.mes || !splitParagraphs(msg.mes).some((p) => p.translate)) {
        toastr.info("这条消息没有需要翻译的文字");
        return false;
    }

    setStatus(mesId, "loading", "⏳ 翻译中…");
    try {
        const { trans } = await ensureTranslations(msg, direction);
        // 翻译期间消息被编辑/swipe/重新生成：结果已过期，由新的操作负责显示
        if (runs.get(mesId) !== runId || getContext().chat?.[mesId] !== msg || msg.mes !== startText) return false;
        setStatus(mesId, null);
        renderMessage(mesId, trans);
        return true;
    } catch (err) {
        console.error("[dual-translate]", err);
        if (runs.get(mesId) === runId) {
            setStatus(mesId, "error", `翻译失败：${err.message}`, () => translateMessage(mesId));
        }
        toastr.error(err.message, "翻译失败", { timeOut: 8000 });
        return false;
    }
}

/* ===================== 消息按钮 ===================== */
async function toggleTranslation(mesId) {
    const msg = getContext().chat?.[mesId];
    if (!msg) return;
    const mesEl = $(`.mes[mesid="${mesId}"]`);
    if (!mesEl.length) return;

    if (mesEl.find(".dt-loading").length) {
        toastr.info("正在翻译中，请稍候…");
        return;
    }
    // 已有译文 → 切换显隐
    const existing = mesEl.find(TR_SEL);
    if (existing.length) {
        const show = !existing.first().is(":visible");
        existing.toggle(show);
        mesEl.attr("data-dt-shown", show ? "1" : "0");
        return;
    }
    // 没有译文（含上一次失败）→ 翻译
    await translateMessage(mesId);
}

function addButton(mesEl) {
    if (mesEl.find(".dt-btn").length) return;
    const mesId = mesEl.attr("mesid");
    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return;

    const direction = getTranslationDirection(msg.is_user);
    const title = `${direction.sourceLang} → ${direction.targetLang}`;
    const btn = $('<div class="mes_button dt-btn fa-solid fa-language" role="button"></div>')
        .attr({ title, "aria-label": `翻译：${title}` });
    btn.on("click", (e) => { e.stopPropagation(); toggleTranslation(parseInt(mesId)); });

    const container = mesEl.find(".extraMesButtons");
    if (container.length) container.prepend(btn);
    else mesEl.find(".mes_buttons").prepend(btn);
}

/* ===================== 输入框翻译按钮（固定使用 DeepSeek） ===================== */
function addInputButton() {
    if ($("#dt_input_btn").length) return;

    const btn = $(`<div id="dt_input_btn" class="fa-solid fa-language interactable" title="翻译输入文本（固定使用 DeepSeek）" role="button"></div>`);

    btn.on("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (btn.hasClass("dt-pulsing")) return;

        const textarea = $("#send_textarea");
        const text = textarea.val()?.trim();
        if (!text) { toastr.warning("输入框为空"); return; }

        const direction = getTranslationDirection(true);
        btn.addClass("dt-pulsing");
        try {
            const translated = await deepseek.translateRaw(text, direction);
            textarea.val(translated).trigger("input");
            toastr.success(`已翻译为 ${direction.targetLang}`, "", { timeOut: 2000 });
        } catch (err) {
            console.error("[dual-translate]", err);
            const hint = err.code === "no_key" && settings().translateProvider === "google"
                ? "（输入框翻译固定使用 DeepSeek：请在设置里展开「输入框翻译所用的 DeepSeek 设置」填写）"
                : "";
            toastr.error(err.message + hint, "输入框翻译失败", { timeOut: 8000 });
        } finally {
            btn.removeClass("dt-pulsing");
        }
    });

    const leftForm = $("#leftSendForm");
    if (leftForm.length) leftForm.append(btn);
    else $("#send_form").prepend(btn);
}

/* ===================== 批处理 ===================== */
// 进入聊天 / 切换设置后：补上按钮，并把已有缓存的译文直接显示出来（不发请求）。
function processAllMessages() {
    const ctx = getContext();
    $(".mes").each(function () {
        const mesEl = $(this);
        const mesId = parseInt(mesEl.attr("mesid"));
        addButton(mesEl);
        const msg = ctx.chat?.[mesId];
        if (!msg || mesEl.find(TR_SEL).length) return;
        const peeked = peekTranslations(msg, getTranslationDirection(msg.is_user));
        if (peeked) renderTranslation(mesEl, peeked.trans);
    });
}

function clearDisplayedTranslations() {
    runs.clear(); // 还在路上的请求结果作废，不再往页面上画
    $(`${TR_SEL}, .dt-status`).remove();
    $(".mes").removeAttr("data-dt-shown");
}

function refreshDisplayMode() {
    const ctx = getContext();
    $(".mes").each(function () {
        const mesEl = $(this);
        const mesId = parseInt(mesEl.attr("mesid"));
        const msg = ctx.chat?.[mesId];
        if (!msg) return;
        const existing = mesEl.find(TR_SEL);
        if (!existing.length) return;
        const wasVisible = existing.is(":visible");
        const peeked = peekTranslations(msg, getTranslationDirection(msg.is_user));
        if (peeked) {
            renderTranslation(mesEl, peeked.trans);
            if (!wasVisible) {
                mesEl.find(TR_SEL).hide();
                mesEl.attr("data-dt-shown", "0");
            }
        }
    });
}

/* ===================== 事件回调 ===================== */
async function onCharMessage(mesId) {
    const s = settings();
    if (!s.enabled) return;
    await sleep(300);
    const mesEl = $(`.mes[mesid="${mesId}"]`);
    if (!mesEl.length) return;
    addButton(mesEl);
    // 自动翻译：已经有译文（或正在翻译）就不重复处理
    if (s.autoTranslate && !mesEl.find(`${TR_SEL}, .dt-loading`).length) await translateMessage(parseInt(mesId));
}

async function onUserMessage(mesId) {
    if (!settings().enabled) return;
    await sleep(300);
    const mesEl = $(`.mes[mesid="${mesId}"]`);
    if (mesEl.length) addButton(mesEl);
}

// 消息被编辑 / swipe / 更新：原文变了，旧译文作废。
// 之前正在显示译文的消息（或开了自动翻译的 AI 消息）会重新翻译，没变的段落直接用缓存，只请求变了的段落。
const changeTimers = new Map();
function onMessageChanged(mesId) {
    if (!settings().enabled) return;
    mesId = parseInt(mesId);
    if (Number.isNaN(mesId)) return;
    clearTimeout(changeTimers.get(mesId));
    changeTimers.set(mesId, setTimeout(() => {
        changeTimers.delete(mesId);
        refreshMessage(mesId);
    }, 300));
}

async function refreshMessage(mesId) {
    const msg = getContext().chat?.[mesId];
    const mesEl = $(`.mes[mesid="${mesId}"]`);
    if (!msg || !mesEl.length) return;
    const wasShown = mesEl.attr("data-dt-shown") === "1";
    mesEl.find(`${TR_SEL}, .dt-status`).remove();
    runs.set(mesId, ++runCounter); // 让还在路上的旧请求结果作废
    addButton(mesEl);
    const auto = settings().autoTranslate && !msg.is_user;
    if (wasShown || auto) await translateMessage(mesId);
}

/* ===================== 设置面板 ===================== */
const settingsHtml = `
<div id="dt_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🌐 双语对照翻译</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label">
        <input type="checkbox" id="dt_enabled" /> <span>启用插件</span>
      </label>
      <label class="checkbox_label">
        <input type="checkbox" id="dt_auto" /> <span>自动翻译 AI 新消息</span>
      </label>
      <hr>
      <label for="dt_provider">翻译源</label>
      <select id="dt_provider" class="text_pole">
        <option value="deepseek">DeepSeek（或其他 OpenAI 兼容接口）</option>
        <option value="google">谷歌翻译（无需 Key，需能访问谷歌）</option>
      </select>
      <div id="dt_google_settings">
        <small class="dt-setting-hint">谷歌翻译不需要 API Key，但这台设备必须能访问谷歌（通常需要开梯子 / VPN）。</small>
        <label for="dt_google_mode">谷歌连接方式</label>
        <select id="dt_google_mode" class="text_pole">
          <option value="auto">自动（先试浏览器直连，不通再走酒馆后端）</option>
          <option value="direct">只用浏览器直连</option>
          <option value="backend">只用酒馆后端</option>
        </select>
        <small class="dt-setting-hint">浏览器直连用的是浏览器 / App 自己的网络，梯子开着就能用；酒馆后端是酒馆的 Node 进程在请求谷歌，不读系统代理，需要在酒馆 config.yaml 里配置 requestProxy。</small>
        <input type="button" id="dt_google_test" class="menu_button" value="🔌 测试谷歌连接" />
      </div>
      <hr>
      <label for="dt_display_mode">显示模式</label>
      <select id="dt_display_mode" class="text_pole">
        <option value="inline">📄 逐段对照（每段原文后跟译文）</option>
        <option value="block">📦 整块翻译（译文堆在底部）</option>
      </select>
      <hr>
      <details id="dt_ds_details" open>
        <summary id="dt_ds_summary">DeepSeek 设置</summary>
        <small id="dt_ds_note" class="dt-setting-hint">输入框旁的翻译按钮固定使用 DeepSeek，不跟随上面的翻译源。</small>
        <div class="dt-field">
          <label for="dt_api_url">API 地址 <small>(填到 /v1)</small></label>
          <input type="text" id="dt_api_url" class="text_pole" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div class="dt-field">
          <label for="dt_api_key">API Key</label>
          <input type="password" id="dt_api_key" class="text_pole" placeholder="sk-..." />
        </div>
        <div class="dt-field">
          <label for="dt_model">模型</label>
          <input type="text" id="dt_model" class="text_pole" placeholder="deepseek-chat" />
        </div>
      </details>
      <hr>
      <label for="dt_language_pair">翻译语言组合</label>
      <select id="dt_language_pair" class="text_pole">
        <option value="en-zh">英语 ⇄ 简体中文</option>
        <option value="ja-zh">日语 ⇄ 简体中文</option>
        <option value="custom">自定义目标语言</option>
      </select>
      <small id="dt_pair_hint" class="dt-setting-hint"></small>
      <div id="dt_custom_languages">
        <label for="dt_target_lang">AI 消息 → 翻译成</label>
        <input type="text" id="dt_target_lang" class="text_pole" placeholder="简体中文" />
        <label for="dt_user_target_lang">用户消息 / 输入框 → 翻译成</label>
        <input type="text" id="dt_user_target_lang" class="text_pole" placeholder="日语" />
      </div>
      <label for="dt_bar_color">竖杠颜色</label>
      <input type="color" id="dt_bar_color" value="#4a90d9" class="dt-color" />
      <hr>
      <input type="button" id="dt_all_btn" class="menu_button" value="📖 翻译全部 AI 消息" />
      <input type="button" id="dt_clear_btn" class="menu_button" value="🗑️ 清除全部翻译" />
      <small class="dt-setting-hint">「清除全部翻译」只移除当前聊天里已显示的译文和旧版保存在聊天记录里的译文。</small>
      <hr>
      <small id="dt_cache_stats" class="dt-setting-hint"></small>
      <input type="button" id="dt_cache_clear_btn" class="menu_button" value="🧹 清空翻译缓存" />
      <small class="dt-setting-hint">清空后，再次查看译文需要重新请求翻译源。原文被编辑过的段落会自动重新翻译，不需要手动清缓存。</small>
    </div>
  </div>
</div>`;

/* ===================== 初始化 ===================== */
jQuery(async () => {
    $("#extensions_settings2").append(settingsHtml);
    loadSettings();

    const bind = (sel, key, evt = "input") => {
        $(sel).on(evt, function () {
            const v = evt === "change" && $(this).is(":checkbox") ? $(this).prop("checked") : $(this).val();
            settings()[key] = v;
            saveSettingsDebounced();
        });
    };

    bind("#dt_enabled", "enabled", "change");
    bind("#dt_auto", "autoTranslate", "change");
    bind("#dt_api_url", "apiUrl");
    bind("#dt_api_key", "apiKey");
    bind("#dt_model", "model");
    bind("#dt_bar_color", "barColor");

    $("#dt_provider").on("change", function () {
        settings().translateProvider = $(this).val();
        syncProviderControls();
        clearDisplayedTranslations();
        $(".dt-btn").remove();
        processAllMessages();
        saveSettingsDebounced();
    });

    $("#dt_google_mode").on("change", function () {
        settings().googleMode = GOOGLE_MODES.includes($(this).val()) ? $(this).val() : "auto";
        saveSettingsDebounced();
    });

    $("#dt_language_pair").on("change", function () {
        settings().languagePair = $(this).val();
        syncLanguageControls();
        clearDisplayedTranslations();
        $(".dt-btn").remove();
        processAllMessages();
        saveSettingsDebounced();
    });

    bind("#dt_target_lang", "targetLang");
    bind("#dt_user_target_lang", "userTargetLang");

    $("#dt_display_mode").on("change", function () {
        settings().displayMode = $(this).val();
        saveSettingsDebounced();
        refreshDisplayMode();
    });

    // 测试谷歌连接
    $("#dt_google_test").on("click", async function () {
        const btn = $(this).prop("disabled", true).val("⏳ 测试中…");
        try {
            const [r] = await google.translateMany(["Hello, world."], { targetLang: getTranslationDirection(false).targetLang });
            const via = { direct: "浏览器直连", backend: "酒馆后端" }[google.lastRoute()] || "";
            toastr.success(`连接正常${via ? `（${via}）` : ""}：Hello, world. → ${r}`, "谷歌翻译", { timeOut: 5000 });
        } catch (err) {
            console.error("[dual-translate]", err);
            toastr.error(err.message, "谷歌翻译测试失败", { timeOut: 10000 });
        } finally {
            btn.prop("disabled", false).val("🔌 测试谷歌连接");
        }
    });

    // 批量翻译：命中缓存的直接显示，只有缺译文的才发请求；再点一次可以中途停止
    let bulkRunning = false;
    let bulkStop = false;
    $("#dt_all_btn").on("click", async function () {
        const btn = $(this);
        if (bulkRunning) {
            bulkStop = true;
            btn.val("正在停止…");
            return;
        }
        bulkRunning = true;
        bulkStop = false;

        const chatId = getContext().chatId;
        const ids = [];
        getContext().chat.forEach((m, i) => { if (!m.is_user) ids.push(i); });
        let done = 0;
        let requested = 0;
        try {
            for (const i of ids) {
                if (bulkStop || getContext().chatId !== chatId) break;
                btn.val(`⏹ 停止（${done}/${ids.length}）`);
                const msg = getContext().chat[i];
                if (msg) {
                    const peeked = peekTranslations(msg, getTranslationDirection(false));
                    if (peeked) {
                        if (!$(`.mes[mesid="${i}"]`).find(TR_SEL).length) renderMessage(i, peeked.trans);
                    } else if (splitParagraphs(msg.mes || "").some((p) => p.translate)) {
                        await translateQuiet(i);
                        requested++;
                        await sleep(300);
                    }
                }
                done++;
            }
            if (bulkStop || getContext().chatId !== chatId) {
                toastr.info(`已停止：处理了 ${done}/${ids.length} 条，其中 ${requested} 条发了翻译请求`);
            } else {
                toastr.success(`全部翻译完成：共 ${ids.length} 条，其中 ${requested} 条发了翻译请求，其余来自缓存`);
            }
        } catch (err) {
            console.error("[dual-translate]", err);
            toastr.error(`第 ${done + 1}/${ids.length} 条处理失败，已停止：${err.message}`, "批量翻译中断", { timeOut: 10000 });
        } finally {
            bulkRunning = false;
            btn.val("📖 翻译全部 AI 消息");
        }
    });

    // 清除当前聊天里显示的译文和旧版聊天内译文
    $("#dt_clear_btn").on("click", function () {
        clearDisplayedTranslations();
        const ctx = getContext();
        for (const msg of ctx.chat) {
            if (msg.extra?.dt_cache) delete msg.extra.dt_cache;
            if (msg.extra?.dt_user_cache) delete msg.extra.dt_user_cache;
            if (msg.extra?.dt_translations) delete msg.extra.dt_translations;
        }
        ctx.saveChat?.();
        toastr.info("已清除当前聊天的译文显示和旧版聊天内译文");
    });

    // 清空翻译缓存
    $("#dt_cache_clear_btn").on("click", function () {
        cache.clear();
        // 不再从旧版聊天记录里导入译文，否则清空后又会被「复活」
        settings().legacyImport = false;
        saveSettingsDebounced();
        clearDisplayedTranslations();
        updateCacheStats();
        toastr.info("已清空翻译缓存");
    });

    // 事件
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharMessage);
    if (event_types.USER_MESSAGE_RENDERED) {
        eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessage);
    }
    for (const name of ["MESSAGE_EDITED", "MESSAGE_UPDATED", "MESSAGE_SWIPED"]) {
        if (event_types[name]) eventSource.on(event_types[name], onMessageChanged);
    }
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(processAllMessages, 500));

    // 手机上切到后台 / 关闭页面时把缓存落盘
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") cache.flush();
    });
    window.addEventListener("pagehide", () => cache.flush());

    addInputButton();
    setTimeout(processAllMessages, 1000);
});
