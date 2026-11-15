/* beam™ — ICE server selection: STUN always, plus a TURN relay when the server
   offers one. Pure functions only (no DOM), so tests can load this file on its own. */
(function (root) {
  "use strict";

  // Used whenever the server's answer is missing, slow or malformed.
  const STUN_ONLY = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  const FALLBACK_CACHE_MS = 30000; // matches the server's 1-mint-per-peer-per-30 s limit
  const REFRESH_MARGIN_S = 300;    // refresh relay credentials 5 min before they expire

  const isStr = (s) => typeof s === "string" && s.length > 0 && s.length < 512;
  const urlList = (u) => (Array.isArray(u) ? u : [u]).filter(isStr);

  function stunOnly() {
    return { iceServers: STUN_ONLY.map((s) => ({ ...s })), relay: false, cacheMs: FALLBACK_CACHE_MS };
  }

  // Validate the server's {iceServers, ttl, relay} answer. Keeps STUN entries first,
  // drops anything that is not a stun:/turn:/turns: URL, and only counts TURN entries
  // that carry a username and credential.
  function normalize(resp) {
    if (!resp || !Array.isArray(resp.iceServers)) return stunOnly();
    const stun = [], turn = [];
    for (const s of resp.iceServers) {
      if (!s || typeof s !== "object") continue;
      const urls = urlList(s.urls);
      const st = urls.filter((u) => /^stun:/i.test(u));
      const tu = urls.filter((u) => /^turns?:/i.test(u));
      if (st.length) stun.push({ urls: st.length === 1 ? st[0] : st });
      if (tu.length && isStr(s.username) && isStr(s.credential)) {
        turn.push({ urls: tu, username: s.username, credential: s.credential });
      }
    }
    const out = { iceServers: (stun.length ? stun : stunOnly().iceServers).concat(turn), relay: turn.length > 0 };
    const ttl = Number(resp.ttl);
    out.cacheMs = out.relay && ttl > 0
      ? Math.max(60, ttl - REFRESH_MARGIN_S) * 1000
      : FALLBACK_CACHE_MS;
    return out;
  }

  // Run fetcher() (a promise of the server's answer) with a deadline. Never rejects:
  // a failure or a slow answer yields STUN only, so pairing is never held up for long.
  function load(fetcher, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(stunOnly()), timeoutMs);
      Promise.resolve()
        .then(fetcher)
        .then((r) => normalize(r), () => stunOnly())
        .then((r) => { clearTimeout(timer); resolve(r); });
    });
  }

  // RTCPeerConnection config. forceRelay (the ?relay=1 debug flag) only applies when a
  // relay was actually offered; otherwise a stray flag would make connections impossible.
  function rtcConfig(result, forceRelay) {
    const cfg = { iceServers: result.iceServers };
    if (forceRelay && result.relay) cfg.iceTransportPolicy = "relay";
    return cfg;
  }

  root.BeamIce = { STUN_ONLY, FALLBACK_CACHE_MS, stunOnly, normalize, load, rtcConfig };
})(typeof window !== "undefined" ? window : globalThis);
