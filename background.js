// background.js (MV3 service worker)
const VERSION = "0.2.5";

// IMPORTANT: 0.0.0.0 is a listen address only. Use 127.0.0.1/localhost or your prod host.
const RECO_API_BASE = "http://127.0.0.1:8000";

const MR_DEFAULT_ORIGIN = "https://www.makorrishon.co.il";
const SESSION = chrome.storage.session;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, credentials: "omit" });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function getCached(key) {
  const data = await SESSION.get(key);
  const entry = data[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    await SESSION.remove(key);
    return null;
  }
  return entry.value;
}

async function setCached(key, value, ttlMs) {
  await SESSION.set({ [key]: { value, expiresAt: Date.now() + ttlMs } });
}

/**
 * Build a navigable URL from an id/slug and a site origin.
 *  - full URL → returns as-is
 *  - "news/157317" → https://host/news/157317
 *  - "157317" (numeric WP id) → https://host/?p=157317
 */
function buildUrlFromId(id, origin = MR_DEFAULT_ORIGIN) {
  const s = String(id || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;

  const o = (origin || MR_DEFAULT_ORIGIN).replace(/\/+$/, "");
  if (/^\d+$/.test(s)) return `${o}/?p=${s}`;

  const path = s.replace(/^\/+/, "");
  return `${o}/${path}`;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}
function slugFromAny(it) {
  const direct = pickFirst(it?.id, it?.slug, it?.metadata?.slug);
  if (direct) return direct;
  const u = pickFirst(it?.url, it?.link, it?.metadata?.url);
  if (!u) return "";
  try {
    const p = new URL(u);
    return p.pathname.replace(/^\/+/, "");
  } catch {
    return u.replace(/^\/+/, "");
  }
}

/** Normalize raw server results → items with {id,title,url} (image kept for on-page use) */
function normalizeItems(items, origin = MR_DEFAULT_ORIGIN) {
  const arr = Array.isArray(items) ? items : [];
  return arr
    .map((it) => {
      const id = slugFromAny(it);
      const title = pickFirst(it?.title, it?.metadata?.title, it?.headline, it?.name, it?.post_title);
      const url =
        pickFirst(it?.url, it?.link, it?.permalink, it?.metadata?.url) ||
        buildUrlFromId(id, origin);

      // Keep image for on-page sidebar (popup won’t use it)
      const image = pickFirst(
        it?.image,
        it?.image_url,
        it?.thumbnail,
        it?.thumb,
        it?.cover,
        it?.metadata?.image,
        it?.metadata?.image_url
      );
      const category = pickFirst(it?.category, it?.section, it?.metadata?.category);

      return { id, title: title || id, url, image, category };
    })
    .filter((it) => it.id && it.url);
}

async function getGaFromCookies(urlLike) {
  try {
    const origin = (() => {
      try { return new URL(urlLike || MR_DEFAULT_ORIGIN).origin; } catch { return MR_DEFAULT_ORIGIN; }
    })();
    const cookie = await chrome.cookies.get({ url: origin, name: "_ga" });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

function buildRecommendBody(gaId, page = {}) {
  const current_article = {
    id: String(page.slug || "").trim(),
    title: String(page.title || "").trim(),
    subtitle: String(page.subtitle || "").trim(),
    first_paragraph: String(page.firstParagraph || "").trim(),
    category: page.category == null ? null : String(page.category).trim(),
  };
  return { user_id: String(gaId || "").trim(), current_article };
}

function validateRecommendBody(body) {
  if (!body?.user_id) return "missing user_id (GA client ID)";
  if (!body?.current_article?.id) return "missing current_article.id (slug)";
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "MR_GET_COOKIE") {
      const raw = await getGaFromCookies(msg.pageUrl);
      sendResponse({ ok: true, value: raw || null });
      return;
    }

    if (msg?.type === "MR_FETCH_RECS") {
      const { gaId, page, limit = 5 } = msg;
      const origin = page?.origin || MR_DEFAULT_ORIGIN;

      const key = `recs:${gaId}:${page?.slug || ""}:${limit}`;

      const cached = await getCached(key);
      if (cached) {
        sendResponse({ ok: true, data: cached, cached: true });
        return;
      }

      const body = buildRecommendBody(gaId, page);
      const bad = validateRecommendBody(body);
      if (bad) {
        sendResponse({ ok: false, error: `invalid_payload: ${bad}` });
        return;
      }

      const topK = Math.min(Math.max(Number(limit) || 5, 3), 5);
      const url = `${RECO_API_BASE}/recommend-articles?top_k=${topK}`;

      let json = null;
      try {
        let res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "x-mr-ext-version": VERSION
            },
            body: JSON.stringify(body)
          },
          5000
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
      } catch (_e) {
        await delay(250 + Math.floor(Math.random() * 250));
        try {
          const res2 = await fetchWithTimeout(
            url,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "x-mr-ext-version": VERSION
              },
              body: JSON.stringify(body)
            },
            6000
          );
          if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
          json = await res2.json();
        } catch (e2) {
          sendResponse({ ok: false, error: String(e2) });
          return;
        }
      }

      const items = normalizeItems(Array.isArray(json) ? json : json?.items, origin);
      const payload = { items };
      await setCached(key, payload, 300_000); // 5 min
      sendResponse({ ok: true, data: payload, cached: false });
      return;
    }

    if (msg?.type === "MR_EVENT") {
      try {
        await fetch(`${RECO_API_BASE}/v1/events/${msg.event}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-mr-ext-version": VERSION
          },
          body: JSON.stringify(msg.payload),
          credentials: "omit"
        });
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown_message" });
  })();

  return true;
});
