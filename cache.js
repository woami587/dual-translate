// 译文缓存：内存 Map（按最近使用排序）+ 防抖写入 localStorage。
// 键由调用方决定（翻译源|目标语言|原文哈希），所以原文变了键就变，不需要手动失效。
// 超过条数或字符数上限时淘汰最久没用到的条目，缓存不会无限变大。

export function createCache({ storage, storageKey, maxEntries = 5000, maxChars = 1200000, flushDelay = 800 } = {}) {
    let map = new Map();
    let chars = 0;
    let timer = null;
    let dirty = false;

    const size = (k, v) => k.length + v.length;

    function evict() {
        while (map.size > maxEntries || chars > maxChars) {
            const oldest = map.keys().next();
            if (oldest.done) break;
            chars -= size(oldest.value, map.get(oldest.value));
            map.delete(oldest.value);
        }
    }

    function load() {
        try {
            const raw = storage?.getItem(storageKey);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data?.v !== 1 || !Array.isArray(data.e)) return;
            for (const [k, v] of data.e) {
                if (typeof k === "string" && typeof v === "string") {
                    map.set(k, v);
                    chars += size(k, v);
                }
            }
            evict();
        } catch (err) {
            console.warn("[dual-translate] 读取翻译缓存失败，已忽略：", err);
            map = new Map();
            chars = 0;
        }
    }

    function persist() {
        dirty = false;
        if (!storage) return false;
        let entries = [...map];
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                storage.setItem(storageKey, JSON.stringify({ v: 1, e: entries }));
                return true;
            } catch {
                // 配额不足：丢掉最旧的 25% 再试
                const drop = Math.ceil(entries.length * 0.25);
                for (const [k, v] of entries.slice(0, drop)) {
                    chars -= size(k, v);
                    map.delete(k);
                }
                entries = entries.slice(drop);
            }
        }
        console.warn("[dual-translate] 翻译缓存无法写入 localStorage，本次只保存在内存里");
        return false;
    }

    function schedule() {
        dirty = true;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            if (dirty) persist();
        }, flushDelay);
    }

    load();

    return {
        has: (key) => map.has(key),
        get(key) {
            const v = map.get(key);
            if (v === undefined) return undefined;
            map.delete(key); // 移到末尾 = 最近使用
            map.set(key, v);
            return v;
        },
        set(key, value) {
            if (typeof value !== "string" || !value) return;
            if (map.has(key)) {
                chars -= size(key, map.get(key));
                map.delete(key);
            }
            map.set(key, value);
            chars += size(key, value);
            evict();
            schedule();
        },
        clear() {
            map.clear();
            chars = 0;
            dirty = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            try {
                storage?.removeItem(storageKey);
            } catch { /* 忽略 */ }
        },
        flush() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (dirty) persist();
        },
        stats: () => ({ count: map.size, chars, maxEntries, maxChars }),
    };
}
