// ga.js — parse GA4 _ga cookie -> clientId "XXXXXXXXXX.YYYYYYYYYY"
window.extractGaClientIdFromCookieString = function(cookieString) {
  try {
    const m = /(?:^|;)\s*_ga=([^;]+)/.exec(cookieString || "");
    if (!m) return null;
    const v = decodeURIComponent(m[1]);
    // GA4 format: GA1.1.XXXXXXXXXX.YYYYYYYYYY (4 parts, last two are the client id)
    const parts = v.split(".");
    return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : null;
  } catch {
    return null;
  }
};
