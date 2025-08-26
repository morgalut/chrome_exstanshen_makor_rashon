// content.js
const extractGaClientIdFromCookieString = window.extractGaClientIdFromCookieString;

const CONFIG = Object.freeze({
  maxItems: 5,
  blockTitle: "מומלץ בשבילך",
  sidebarSelector: ".jegStickyHolder",
  latestHeaderRegex: /כתבות\s+אחרונות\s+באתר/,
  idempotenceAttr: "data-mr-recs",
  impressionWidget: "reco_sidebar",
  minParaLen: 60,
  debounceMs: 200,
  skeletonRows: 3
});

function debug(...args) {
  if (localStorage.getItem("mr-debug") === "1") console.log("[MR-EXT]", ...args);
}
const safeText = (s) => (s || "").replace(/\s+/g, " ").trim();

function normalizeSlugFromUrl(u) {
  try {
    const url = new URL(u, location.origin);
    return url.pathname.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  } catch { return ""; }
}

function deriveSlug() {
  const link = document.querySelector('link[rel="canonical"]')?.href;
  if (link) {
    const s = normalizeSlugFromUrl(link);
    if (s) return s;
  }
  return normalizeSlugFromUrl(location.href);
}

function extractTitle() {
  const h1 = document.querySelector("article h1, .jeg_post_title, h1.entry-title, h1");
  if (h1?.textContent) return safeText(h1.textContent);
  const og = document.querySelector('meta[property="og:title"]')?.content;
  if (og) return safeText(og);
  const docTitle = document.title || "";
  return safeText(docTitle.replace(/\|\s*מקור ראשון.*$/,""));
}
function extractSubtitle() {
  const sub = document.querySelector(".subtitle, h2.subtitle, .jeg_post_subtitle, article h2, .post-subtitle");
  if (sub?.textContent) return safeText(sub.textContent);
  const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
  if (ogDesc) return safeText(ogDesc);
  return "";
}
function extractFirstParagraph() {
  const candidates = [
    ...document.querySelectorAll('article p, .entry-content p, [itemprop="articleBody"] p, .jeg_post_content p')
  ];
  for (const p of candidates) {
    const t = safeText(p.textContent);
    if (t.length >= CONFIG.minParaLen) return t;
  }
  const meta1 = document.querySelector('meta[name="description"]')?.content;
  if (meta1) return safeText(meta1);
  const og = document.querySelector('meta[property="og:description"]')?.content;
  if (og) return safeText(og);
  return "";
}
function extractCategoryFromDom() {
  const metaSec = document.querySelector('meta[property="article:section"]')?.content;
  if (metaSec) return safeText(metaSec);
  const crumbs = [...document.querySelectorAll(".jeg_breadcrumbs a, .breadcrumbs a")].map(a => safeText(a.textContent));
  if (crumbs.length >= 2) return crumbs[crumbs.length - 2] || crumbs[0];
  return "";
}
function extractCategoryFromPath() {
  const slug = deriveSlug();
  if (!slug) return "";
  const parts = slug.split("/");
  if (parts.length >= 2 && !/^\d+$/.test(parts[1])) return parts[1];
  if (parts.length >= 1 && !/^\d+$/.test(parts[0])) return parts[0];
  return "";
}
function deriveCategory() { return extractCategoryFromDom() || extractCategoryFromPath() || ""; }

function getCanonicalUrl() {
  const link = document.querySelector('link[rel="canonical"]')?.href;
  if (link) return link;
  try { return new URL(location.href).href; } catch { return location.href; }
}

function deriveGaClientId() {
  try {
    if (typeof extractGaClientIdFromCookieString === "function") {
      return extractGaClientIdFromCookieString(document.cookie) || null;
    }
  } catch {}
  return null;
}

function getPageContext() {
  return {
    origin: location.origin,
    url: getCanonicalUrl(),              // ✅ include concrete URL
    slug: deriveSlug(),
    title: extractTitle(),
    subtitle: extractSubtitle(),
    firstParagraph: extractFirstParagraph(),
    category: deriveCategory(),
    gaClientId: deriveGaClientId(),      // ✅ include GA clientId if derivable on page
    capturedAt: Date.now(),              // ✅ useful for debugging in popup
  };
}

function waitForSidebar(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const direct = document.querySelector(CONFIG.sidebarSelector);
    if (direct) return resolve(direct);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(CONFIG.sidebarSelector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error("sidebar_timeout")); }, timeoutMs);
  });
}

function collectExistingSlugs(container) {
  const set = new Set();
  container.querySelectorAll("a[href]").forEach(a => {
    const slug = normalizeSlugFromUrl(a.href);
    if (slug) set.add(slug);
  });
  return set;
}

function removePriorBlock(container) {
  const old = container.querySelector(`[${CONFIG.idempotenceAttr}]`);
  if (old && old.parentElement) old.parentElement.removeChild(old);
}

function createStyles() {
  const style = document.createElement("style");
  style.textContent = `
    [${CONFIG.idempotenceAttr}] { font-family: inherit; margin: 16px 0; }
    [${CONFIG.idempotenceAttr}] .mr-title { font-weight: 800; margin: 0 0 8px; font-size: 16px; }
    [${CONFIG.idempotenceAttr}] .mr-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    [${CONFIG.idempotenceAttr}] .mr-item { display: grid; grid-template-columns: 96px 1fr; gap: 10px; align-items: start; }
    [${CONFIG.idempotenceAttr}] .mr-thumb { width: 96px; height: 60px; object-fit: cover; border-radius: 6px; background:#f3f3f3; }
    [${CONFIG.idempotenceAttr}] .mr-cat { font-size: 12px; opacity: .7; margin: 0 0 4px; color: currentColor; }
    [${CONFIG.idempotenceAttr}] .mr-link { display:block; text-decoration: none; line-height: 1.35; font-size: 14px; font-weight: 700; color: currentColor; word-break: break-word; }
    /* Skeletons */
    [${CONFIG.idempotenceAttr}] .mr-skel { display:grid; grid-template-columns:96px 1fr; gap:10px; align-items:start; }
    [${CONFIG.idempotenceAttr}] .mr-skel .ph-thumb { width:96px; height:60px; border-radius:6px; background:linear-gradient(90deg,#eee,#f5f5f5,#eee); animation:mr-sh 1.2s infinite; }
    [${CONFIG.idempotenceAttr}] .mr-skel .ph-line { height:12px; border-radius:6px; background:linear-gradient(90deg,#eee,#f5f5f5,#eee); animation:mr-sh 1.2s infinite; margin:4px 0; }
    [${CONFIG.idempotenceAttr}] .mr-skel .ph-line.w40 { width:40%; } .w60 { width:60%; } .w80 { width:80%; }
    @keyframes mr-sh { 0%{background-position:0 0} 100%{background-position:200% 0} }
  `;
  return style;
}

function buildSkeletonBlock() {
  const wrap = document.createElement("section");
  wrap.setAttribute(CONFIG.idempotenceAttr, "1");
  wrap.setAttribute("dir", "rtl");
  wrap.setAttribute("aria-label", "המלצות (טוען)");
  wrap.appendChild(createStyles());

  const h = document.createElement("h3");
  h.className = "mr-title";
  h.textContent = CONFIG.blockTitle;
  wrap.appendChild(h);

  const ul = document.createElement("ul");
  ul.className = "mr-list";
  wrap.appendChild(ul);

  for (let i=0;i<CONFIG.skeletonRows;i++){
    const li = document.createElement("li");
    li.className = "mr-skel";
    const t = document.createElement("div");
    t.className = "ph-thumb";
    const meta = document.createElement("div");
    const l1 = document.createElement("div"); l1.className = "ph-line w80";
    const l2 = document.createElement("div"); l2.className = "ph-line w60";
    const l3 = document.createElement("div"); l3.className = "ph-line w40";
    meta.append(l1,l2,l3);
    li.append(t,meta);
    ul.appendChild(li);
  }
  return wrap;
}

function safeHttpUrl(u) {
  try {
    const p = new URL(u, location.origin);
    if (p.protocol === "http:" || p.protocol === "https:") return p.href;
  } catch {}
  return "";
}

function buildBlock(items, gaId) {
  const wrapper = document.createElement("section");
  wrapper.setAttribute(CONFIG.idempotenceAttr, "1");
  wrapper.setAttribute("dir", "rtl");
  wrapper.setAttribute("aria-label", "המלצות מותאמות אישית");
  wrapper.appendChild(createStyles());

  const h = document.createElement("h3");
  h.className = "mr-title";
  h.textContent = CONFIG.blockTitle;
  wrapper.appendChild(h);

  const ul = document.createElement("ul");
  ul.className = "mr-list";
  wrapper.appendChild(ul);

  items.forEach((raw, idx) => {
    const href = safeHttpUrl(raw.url);
    if (!href) return;

    const li = document.createElement("li");
    li.className = "mr-item";

    const aImg = document.createElement("a");
    aImg.href = href;
    aImg.target = "_self";
    aImg.rel = "noopener";

    const imgUrl = safeHttpUrl(raw.image);
    if (imgUrl) {
      const img = document.createElement("img");
      img.className = "mr-thumb";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = imgUrl;
      img.alt = "";
      aImg.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "mr-thumb";
      aImg.appendChild(ph);
    }
    li.appendChild(aImg);

    const meta = document.createElement("div");
    if (raw.category) {
      const cat = document.createElement("div");
      cat.className = "mr-cat";
      cat.textContent = raw.category;
      meta.appendChild(cat);
    }
    const a = document.createElement("a");
    a.className = "mr-link";
    a.href = href;
    a.target = "_self";
    a.rel = "noopener";
    a.textContent = raw.title || ""; // safe fallback
    meta.appendChild(a);

    // Click tracking
    li.addEventListener("click", (ev) => {
      const targetLink = ev.target.closest("a");
      const outHref = targetLink ? targetLink.href : href;
      chrome.runtime.sendMessage({
        type: "MR_EVENT",
        event: "click",
        payload: {
          gaid: gaId,
          site: "makorrishon",
          widget: CONFIG.impressionWidget,
          id: raw.id,
          rank: idx + 1,
          href: outHref,
          ts: Date.now()
        }
      });
    }, { passive: true });

    li.appendChild(meta);
    ul.appendChild(li);
  });

  return wrapper;
}

function insertAfterLatestBlock(container, block) {
  const header = [...container.querySelectorAll("h2,h3,h4,h5")]
    .find(h => CONFIG.latestHeaderRegex.test((h.textContent || "").trim()));
  if (header) {
    const section = header.closest("section") || header.parentElement;
    if (section && section.parentElement) {
      section.parentElement.insertBefore(block, section.nextSibling);
      return true;
    }
  }
  container.appendChild(block);
  return false;
}

function getOrMakeAnonId() {
  const k = "mr_anon_id";
  let v = sessionStorage.getItem(k);
  if (!v) {
    const a = new Uint8Array(10);
    crypto.getRandomValues(a);
    v = [...a].map(x => x.toString(36)).join("");
    sessionStorage.setItem(k, v);
  }
  return `anon_${v}`;
}

async function ensureGaId() {
  if (typeof extractGaClientIdFromCookieString === "function") {
    const gaId = extractGaClientIdFromCookieString(document.cookie);
    if (gaId) return gaId;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "MR_GET_COOKIE", pageUrl: location.href });
    if (res?.ok && res.value) {
      const clientId = extractGaClientIdFromCookieString(`_ga=${res.value}`);
      if (clientId) return clientId;
    }
  } catch {}
  return getOrMakeAnonId();
}

function scrapeLatestSidebar(container, max = 5) {
  const out = [];
  const anchors = container.querySelectorAll('a[href]');
  for (const a of anchors) {
    if (out.length >= max) break;
    const href = safeHttpUrl(a.href || "");
    const title = safeText(a.textContent || "");
    if (!href || !title) continue;
    const img = a.querySelector('img')?.src || "";
    out.push({ id: href, title, url: href, image: img, category: "" });
  }
  return out;
}

let lastKey = "";
let debTimer = null;
let isRendering = false;

async function renderRecommendations() {
  if (isRendering) return;
  isRendering = true;
  try {
    const enabled = (await chrome.storage.sync.get({ mrEnabled: true })).mrEnabled;
    if (!enabled) return;

    const gaId = await ensureGaId();
    if (!gaId) { debug("No GA client ID; skipping."); return; }

    const page = getPageContext();
    const key = `${gaId}|${page.slug}`;
    if (key === lastKey) { debug("Same page key; skip duplicate render."); return; }
    lastKey = key;

    // Kick off backend request immediately
    const fetchPromise = chrome.runtime.sendMessage({
      type: "MR_FETCH_RECS",
      gaId,
      page,
      limit: CONFIG.maxItems
    }).catch(() => null);

    // Wait for sidebar and show skeleton
    const container = await waitForSidebar().catch(() => null);
    if (container) {
      removePriorBlock(container);
      const skeleton = buildSkeletonBlock();
      insertAfterLatestBlock(container, skeleton);
    }

    const response = await fetchPromise;
    if (!container) { debug("No sidebar container; skipping render (request was still sent)."); return; }

    let items = (response?.ok && response.data?.items) ? response.data.items : null;

    // De-duplicate vs existing sidebar links
    if (items && items.length) {
      const existing = collectExistingSlugs(container);
      items = items
        .filter(it => !existing.has(normalizeSlugFromUrl(it.url)))
        .slice(0, CONFIG.maxItems);
    }

    // Backend failed or all items duped → fallback scrape
    if (!items || !items.length) {
      const fallback = scrapeLatestSidebar(container, CONFIG.maxItems);
      removePriorBlock(container);
      if (fallback.length) {
        const block = buildBlock(fallback, gaId);
        insertAfterLatestBlock(container, block);
        debug("Rendered FALLBACK recommendations:", fallback);
      }
      return;
    }

    // Replace skeleton with final block
    removePriorBlock(container);
    const block = buildBlock(items, gaId);
    insertAfterLatestBlock(container, block);

    // Impression
    chrome.runtime.sendMessage({
      type: "MR_EVENT",
      event: "impression",
      payload: {
        gaid: gaId,
        site: "makorrishon",
        widget: CONFIG.impressionWidget,
        ids: items.map(i => i.id),
        ts: Date.now()
      }
    });

    debug("Rendered recommendations:", items);
  } catch (e) {
    debug("Unhandled error:", e);
  } finally {
    isRendering = false;
  }
}

/* ===========================
   Popup bridge: allow popup to request the current page context.
   Also persist to chrome.storage.local for debugging/inspection.
   =========================== */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "MR_GET_PAGE_CONTEXT") {
    try {
      const page = getPageContext();

      // Persist latest captured payload for DevTools/Application → Storage
      chrome.storage.local.set({ pageContext: page, pageContextTimestamp: Date.now() }).catch(() => {});

      // Also stash in sessionStorage for quick manual checks
      try { sessionStorage.setItem('lastPageContext', JSON.stringify(page)); } catch {}

      // Log for easy debugging
      console.log("[MR-EXT] Sending page context to popup:", page);

      sendResponse({ ok: true, page });
    } catch (e) {
      const err = { ok: false, error: String(e) };
      console.error("[MR-EXT] Error getting page context:", err);
      sendResponse(err);
    }
    return true;
  }
  return false;
});

function main() {
  renderRecommendations();

  const wrap = (fnName) => {
    const orig = history[fnName];
    return function(...args) {
      const ret = orig.apply(this, args);
      if (debTimer) clearTimeout(debTimer);
      debTimer = setTimeout(renderRecommendations, CONFIG.debounceMs);
      return ret;
    };
  };
  history.pushState = wrap("pushState");
  history.replaceState = wrap("replaceState");
  window.addEventListener("popstate", () => {
    if (debTimer) clearTimeout(debTimer);
    debTimer = setTimeout(renderRecommendations, CONFIG.debounceMs);
  });

  (async () => {
    const container = await waitForSidebar().catch(() => null);
    if (!container) return;
    const target = container.parentElement || container;
    const mo = new MutationObserver(() => {
      if (debTimer) clearTimeout(debTimer);
      debTimer = setTimeout(renderRecommendations, CONFIG.debounceMs);
    });
    mo.observe(target, { childList: true, subtree: true });
  })();
}

main();
