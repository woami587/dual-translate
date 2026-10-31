// 纯文本处理工具：不依赖酒馆，也不碰 DOM，方便单独测试。

export function escapeHtml(t) {
    return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 译文显示用：先转义 HTML，再把保留下来的 ***粗斜体***、**粗体**、*斜体* 渲染出来，换行变 <br>。
export function renderInlineMarkup(text) {
    return escapeHtml(text)
        .replace(/\*\*\*([^\s*](?:[^*]*[^\s*])?)\*\*\*/g, "<strong><em>$1</em></strong>")
        .replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g, "<em>$1</em>")
        .replace(/\n/g, "<br>");
}

// 同步的 53 位字符串哈希（cyrb53），再拼上长度，足够区分聊天里的段落。
// 不用 crypto.subtle：它是异步的，而且要求安全上下文，在 Tauri 里不一定可用。
export function hashString(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `${n.toString(36)}-${str.length.toString(36)}`;
}

/* ===================== 分段 ===================== */

// 按空行把消息切成段落。``` 代码块内部的空行不切；代码块和没有任何文字的段落（---、*** 等）
// 仍然保留在列表里（这样和页面上渲染出的元素下标能对上），只是标记为不需要翻译。
export function splitParagraphs(text) {
    const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
    const raw = [];
    let buf = [];
    let inFence = false;
    const flush = () => {
        const t = buf.join("\n").trim();
        if (t) raw.push(t);
        buf = [];
    };
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            buf.push(line);
        } else if (!inFence && line.trim() === "") {
            flush();
        } else {
            buf.push(line);
        }
    }
    flush();
    return raw.map((t) => ({ text: t, translate: isTranslatable(t) }));
}

function isTranslatable(t) {
    if (/^(```|~~~)/.test(t)) return false;
    return /\p{L}/u.test(t);
}

// 旧版缓存里的整段译文，按空行切开（只用于迁移旧数据）。
export function splitPlainParagraphs(text) {
    return String(text ?? "").split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
}

/* ===================== 分批 + 对位 ===================== */

// 把 items 按 cost 分成若干批，每批合并成一次请求。
// sendBatch(items) 必须返回与 items 等长的译文数组；如果合并后对不上，返回 null。
// 对不上时对半拆开重发，最后退化为一段一段发，保证译文一定能对回原来的段落。
export async function translateAligned(items, sendBatch, { maxCost = 3000, cost = (t) => t.length, itemOverhead = 0 } = {}) {
    const out = new Array(items.length);
    const groups = [];
    let cur = [];
    let curCost = 0;
    items.forEach((t, i) => {
        const c = cost(t) + itemOverhead;
        if (cur.length && curCost + c > maxCost) {
            groups.push(cur);
            cur = [];
            curCost = 0;
        }
        cur.push(i);
        curCost += c;
    });
    if (cur.length) groups.push(cur);

    const solve = async (idxs) => {
        const res = await sendBatch(idxs.map((i) => items[i]));
        if (Array.isArray(res) && res.length === idxs.length) {
            idxs.forEach((i, k) => { out[i] = res[k]; });
            return;
        }
        if (idxs.length === 1) throw new Error("译文无法与原文对应");
        const mid = idxs.length >> 1;
        await solve(idxs.slice(0, mid));
        await solve(idxs.slice(mid));
    };
    for (const g of groups) await solve(g);
    return out;
}

/* ===================== Markdown / 引号保护（谷歌用） ===================== */

// 这些东西原样保留，不送去翻译：行内代码、链接、{{宏}}、HTML 标签、* 和 ~~ 标记、各种引号。
const KEEP_RE = /(`[^`\n]+`|https?:\/\/[^\s)）"”」』]+|\{\{[^{}\n]*\}\}|<\/?[A-Za-z][^<>\n]*>|\*{1,3}|~~|[“”"「」『』«»])/g;

// 把一段文字拆成「保留」和「待翻译」两种片段，翻译后按原顺序拼回。
// 相比占位符，这种做法不依赖谷歌怎么处理占位符，标记不会被改坏。
export function protectMarkup(text) {
    const parts = [];
    String(text).split(KEEP_RE).forEach((s, i) => {
        if (s === "") return;
        if (i % 2 === 1) {
            parts.push({ keep: true, text: s });
            return;
        }
        const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
        const core = m[2];
        if (core && /\p{L}/u.test(core)) {
            parts.push({ keep: false, lead: m[1], core, trail: m[3] });
        } else {
            parts.push({ keep: true, text: s });
        }
    });
    return parts;
}

export function assembleMarkup(parts, translate) {
    return parts.map((p) => (p.keep ? p.text : p.lead + translate(p.core) + p.trail)).join("");
}

/* ===================== 超长文本切分（谷歌用） ===================== */

// encodeURIComponent 对孤立代理字符会抛异常，这里兜底。
export function encodedCost(t) {
    try {
        return encodeURIComponent(t).length;
    } catch {
        return t.length * 9;
    }
}

const SENTENCE_END = /(?:[.!?]+["”’')）」』]*\s+|[。！？…]+["”’')）」』]*\s*|\n+)/g;

// 把超过 maxCost 的长文本在句子边界切开。返回 [{ text, sep }]，sep 是该块后面原有的空白。
export function splitLongText(text, maxCost, cost = encodedCost) {
    if (cost(text) <= maxCost) return [{ text, sep: "" }];

    const units = [];
    let start = 0;
    let m;
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(text))) {
        const end = m.index + m[0].length;
        units.push(text.slice(start, end));
        start = end;
    }
    if (start < text.length) units.push(text.slice(start));

    // 单个句子仍然超长：按字符硬切
    const flat = [];
    for (const u of units) {
        if (cost(u) <= maxCost) {
            flat.push(u);
            continue;
        }
        let acc = "";
        let accCost = 0;
        for (const ch of u) {
            const c = cost(ch);
            if (acc && accCost + c > maxCost) {
                flat.push(acc);
                acc = "";
                accCost = 0;
            }
            acc += ch;
            accCost += c;
        }
        if (acc) flat.push(acc);
    }

    // 贪心合并成不超过 maxCost 的块
    const pieces = [];
    let cur = "";
    let curCost = 0;
    for (const u of flat) {
        const c = cost(u);
        if (cur && curCost + c > maxCost) {
            pieces.push(cur);
            cur = "";
            curCost = 0;
        }
        cur += u;
        curCost += c;
    }
    if (cur) pieces.push(cur);

    return pieces.map((p) => {
        const body = p.replace(/\s+$/, "");
        return { text: body, sep: p.slice(body.length) };
    });
}
