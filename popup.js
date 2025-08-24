const toggleEl = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");

// Small helper: GA cookie -> clientId "XXXXXXXXXX.YYYYYYYYYY"
function parseGaClientIdFromCookieValue(gaCookieValue) {
  try {
    const v = decodeURIComponent(gaCookieValue || "");
    const parts = v.split(".");
    return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : null;
  } catch {
    return null;
  }
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
}

function showList(items) {
  listEl.innerHTML = "";
  if (!items || !items.length) {
    listEl.classList.add("hidden");
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "item";

    const aImg = document.createElement("a");
    aImg.href = it.url;
    aImg.target = "_blank";
    aImg.rel = "noopener";

    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = it.image || "";
    img.alt = "";
    aImg.appendChild(img);
    li.appendChild(aImg);

    const meta = document.createElement("div");
    if (it.category) {
      const cat = document.createElement("div");
      cat.className = "cat";
      cat.textContent = it.category;
      meta.appendChild(cat);
    }
    const a = document.createElement("a");
    a.className = "link";
    a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = it.title || it.id || "(ללא כותרת)";
    meta.appendChild(a);

    li.appendChild(meta);
    listEl.appendChild(li);
  }
  listEl.classList.remove("hidden");
}

async function initToggle() {
  const { mrEnabled = true } = await chrome.storage.sync.get({ mrEnabled: true });
  toggleEl.checked = !!mrEnabled;
  toggleEl.addEventListener("change", async () => {
    await chrome.storage.sync.set({ mrEnabled: toggleEl.checked });
    setStatus(toggleEl.checked ? "הזרקה בדף פעילה" : "הזרקה בדף כבויה");
  });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0].id : null;
}

async function getPageContextFromTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "MR_GET_PAGE_CONTEXT" });
    if (res?.ok) return res.page;
  } catch {
    // This fails if the content script is not injected on the tab (non-allowed site)
  }
  return null;
}

async function getGaClientIdForUrl(pageUrl) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "MR_GET_COOKIE", pageUrl });
    const val = res?.value || null;
    if (!val) return null;
    return parseGaClientIdFromCookieValue(val);
  } catch {
    return null;
  }
}

async function fetchRecs(gaId, page, limit = 5) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "MR_FETCH_RECS",
      gaId,
      page,
      limit
    });
    if (response?.ok) return response.data?.items || [];
    return [];
  } catch {
    return [];
  }
}

async function run() {
  await initToggle();

  setStatus("טוען…");
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("לא נמצאה לשונית פעילה", true);
    return;
  }

  // Ask the content script on this tab for the page context
  const page = await getPageContextFromTab(tabId);
  if (!page || !page.slug) {
    setStatus("פתח כתבה באתר makorrishon.co.il כדי לראות המלצות כאן.", true);
    return;
  }

  // GA client ID (fallback to anonymous if needed)
  let gaId = await getGaClientIdForUrl(page.origin);
  if (!gaId) {
    // Anonymous fallback so the popup still shows something
    const a = new Uint8Array(10);
    crypto.getRandomValues(a);
    gaId = "anon_" + [...a].map(x => x.toString(36)).join("");
  }

  // Fetch recs via the background worker
  const items = await fetchRecs(gaId, page, 5);
  if (!items.length) {
    setStatus("אין המלצות זמינות כעת.");
    showList([]);
    return;
  }

  setStatus("תוצאות שהוחזרו מהשרת:");
  showList(items);
}

run();
