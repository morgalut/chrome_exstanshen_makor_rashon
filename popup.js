const toggleEl = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");

// GA cookie → clientId "XXXXXXXXXX.YYYYYYYYYY"
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

// TITLES-ONLY rendering (with correct links)
function showList(items) {
  listEl.innerHTML = "";
  if (!items || !items.length) {
    listEl.classList.add("hidden");
    return;
  }
  for (const it of items) {
    if (!it?.url) continue;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = it.title || it.id || "(ללא כותרת)";
    a.title = it.title || ""; // tooltip for long titles
    li.appendChild(a);
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

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

// Ask content script for payload (internally), but do NOT display it
async function getPageContextFromTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "MR_GET_PAGE_CONTEXT" });
    if (res?.ok) return res.page;
  } catch {
    // content script may not be present on this tab
  }
  // Optional fallback if content script cached it in storage (still not displayed)
  const { pageContext = null } = await chrome.storage.local.get(["pageContext"]);
  return pageContext;
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
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("לא נמצאה לשונית פעילה", true);
    return;
  }

  // Get page context (not displayed)
  const page = await getPageContextFromTab(tab.id);
  if (!page || !page.slug) {
    setStatus("פתח כתבה באתר makorrishon.co.il כדי לראות המלצות כאן.", true);
    showList([]);
    return;
  }

  // GA client ID
  let gaId = await getGaClientIdForUrl(page.origin || tab.url);
  if (!gaId) {
    if (page.gaClientId) {
      gaId = page.gaClientId;
    } else {
      const a = new Uint8Array(10);
      crypto.getRandomValues(a);
      gaId = "anon_" + [...a].map(x => x.toString(36)).join("");
    }
  }

  // Ask background to fetch and normalize results
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
