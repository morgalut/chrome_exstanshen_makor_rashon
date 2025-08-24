// background.js (MV3 service worker)
const VERSION = "0.2.3";

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
 * Handles these cases:
 *  - full URL → returns as-is
 *  - "news/157317" → https://host/news/157317
 *  - "157317" (numeric WP id, no url in payload) → https://host/?p=157317  ← FIX
 */
function buildUrlFromId(id, origin = MR_DEFAULT_ORIGIN) {
  const s = String(id || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;

  const o = (origin || MR_DEFAULT_ORIGIN).replace(/\/+$/, "");
  // If it's a pure numeric WordPress post id, prefer the canonical fallback '?p='
  if (/^\d+$/.test(s)) return `${o}/?p=${s}`;

  // Otherwise treat as path/slugs (ensure single leading slash)
  const path = s.replace(/^\/+/, "");
  return `${o}/${path}`;
}

/** helpers to robustly map server payloads */
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

/** Defensive normalization of backend items → {id,title,url,image,category,subtitle} */
function normalizeItems(items, origin = MR_DEFAULT_ORIGIN) {
  const arr = Array.isArray(items) ? items : [];
  return arr
    .map((it) => {
      const id = slugFromAny(it);
      const title = pickFirst(it?.title, it?.metadata?.title, it?.headline, it?.name, it?.post_title);
      const subtitle = pickFirst(it?.subtitle, it?.dek, it?.subhead, it?.metadata?.subtitle);
      const category = pickFirst(it?.category, it?.section, it?.metadata?.category);

      const url =
        pickFirst(it?.url, it?.link, it?.permalink, it?.metadata?.url) ||
        buildUrlFromId(id, origin); // ← now yields '?p=ID' for numeric ids

      const image = pickFirst(
        it?.image,
        it?.image_url,
        it?.thumbnail,
        it?.thumb,
        it?.cover,
        it?.metadata?.image,
        it?.metadata?.image_url
      );

      // Guarantee a non-empty title by falling back to the id
      const safeTitle = title || id;

      return { id, title: safeTitle, subtitle, category, url, image };
    })
    // only require id + url; title is guaranteed above
    .filter((it) => it.id && it.url);
}

/** Try to read the _ga cookie via chrome.cookies (fallback path) */
async function getGaFromCookies(urlLike) {
  try {
    const origin = (() => {
      try {
        return new URL(urlLike || MR_DEFAULT_ORIGIN).origin;
      } catch {
        return MR_DEFAULT_ORIGIN;
      }
    })();
    const cookie = await chrome.cookies.get({ url: origin, name: "_ga" });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

/** Prepare the request body for /recommend-articles */
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

/** Minimal validation so we don't hit backend with bad payloads */
function validateRecommendBody(body) {
  if (!body?.user_id) return "missing user_id (GA client ID)";
  if (!body?.current_article?.id) return "missing current_article.id (slug)";
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // Get GA cookie value (raw)
    if (msg?.type === "MR_GET_COOKIE") {
      const raw = await getGaFromCookies(msg.pageUrl);
      sendResponse({ ok: true, value: raw || null });
      return;
    }

    // Fetch recommendations by POSTing a "read" to /recommend-articles
    if (msg?.type === "MR_FETCH_RECS") {
      const { gaId, page, limit = 5 } = msg;
      const origin = page?.origin || MR_DEFAULT_ORIGIN;

      // Cache key includes GA ID + slug + limit
      const key = `recs:${gaId}:${page?.slug || ""}:${limit}`;

      // 1) cache
      const cached = await getCached(key);
      if (cached) {
        sendResponse({ ok: true, data: cached, cached: true });
        return;
      }

      // 2) Build POST body for /recommend-articles
      const body = buildRecommendBody(gaId, page);
      const bad = validateRecommendBody(body);
      if (bad) {
        sendResponse({ ok: false, error: `invalid_payload: ${bad}` });
        return;
      }

      // Backend supports ?top_k=3..5 (defaults to 5)
      const topK = Math.min(Math.max(Number(limit) || 5, 3), 5);
      const url = `${RECO_API_BASE}/recommend-articles?top_k=${topK}`;

      // 3) POST with one retry
      let json = null;
      try {
        let res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "x-mr-ext-version": VERSION,
            },
            body: JSON.stringify(body),
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
                "x-mr-ext-version": VERSION,
              },
              body: JSON.stringify(body),
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

      // 4) Normalize response: router returns an array of ArticleResponse
      const items = normalizeItems(Array.isArray(json) ? json : json?.items, origin);

      const payload = { items };
      await setCached(key, payload, 300_000); // 5 min
      sendResponse({ ok: true, data: payload, cached: false });
      return;
    }

    // Fire-and-forget telemetry/events (optional)
    if (msg?.type === "MR_EVENT") {
      try {
        await fetch(`${RECO_API_BASE}/v1/events/${msg.event}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-mr-ext-version": VERSION,
          },
          body: JSON.stringify(msg.payload),
          credentials: "omit",
        });
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true });
      return;
    }

    // Unknown
    sendResponse({ ok: false, error: "unknown_message" });
  })();

  // Keep the channel open for async sendResponse
  return true;
});
