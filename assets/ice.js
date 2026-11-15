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
  const RETRY_BASE_MS = 30000;     // refresh retry backoff: 30 s, 60 s, 120 s ... capped
  const RETRY_MAX_MS = 300000;

  const isStr = (s) => typeof s === "string" && s.length > 0 && s.length < 512;
  const urlList = (u) => (Array.isArray(u) ? u : [u]).filter(isStr);
  // port 53 is blocked by browsers; a URL on it only times out
  const port53 = (u) => /:53(\?|$)/.test(u);

  function stunOnly() {
    return { iceServers: STUN_ONLY.map((s) => ({ ...s })), relay: false, debug: false, cacheMs: FALLBACK_CACHE_MS };
  }

  // Validate the server's {iceServers, ttl, relay, debug} answer. Keeps STUN entries
  // first, drops anything that is not a stun:/turn:/turns: URL (and port 53), and only
  // counts TURN entries that carry a username and credential.
  function normalize(resp) {
    if (!resp || !Array.isArray(resp.iceServers)) return stunOnly();
    const stun = [], turn = [];
    for (const s of resp.iceServers) {
      if (!s || typeof s !== "object") continue;
      const urls = urlList(s.urls).filter((u) => !port53(u));
      const st = urls.filter((u) => /^stun:/i.test(u));
      const tu = urls.filter((u) => /^turns?:/i.test(u));
      if (st.length) stun.push({ urls: st.length === 1 ? st[0] : st });
      if (tu.length && isStr(s.username) && isStr(s.credential)) {
        turn.push({ urls: tu, username: s.username, credential: s.credential });
      }
    }
    const out = {
      iceServers: (stun.length ? stun : stunOnly().iceServers).concat(turn),
      relay: turn.length > 0,
      debug: resp.debug === true,
    };
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

  // RTCPeerConnection config. ?relay=1 (forceRelay) applies only when the server both
  // offered a relay and allows debugging (BEAM_TURN_DEBUG=1); otherwise it is ignored.
  function rtcConfig(result, forceRelay) {
    const cfg = { iceServers: result.iceServers };
    if (forceRelay && result.relay && result.debug) cfg.iceTransportPolicy = "relay";
    return cfg;
  }

  // ---- credential refresh (long chat rooms outlive the credentials) ----

  // Delay before the next refresh: the credentials' cache time after a success,
  // else an exponential backoff that keeps retrying (it never silently stops).
  function refreshDelay(result, attempt) {
    if (result && result.relay) return result.cacheMs;
    return Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt)), RETRY_MAX_MS);
  }

  // The selected candidate pair's types, from getStats() values (plain objects).
  // Returns { local, remote } (e.g. "host", "srflx", "relay"), or null if not yet known.
  function selectedPath(stats) {
    const list = Array.isArray(stats) ? stats : [];
    const byId = new Map(list.map((s) => [s.id, s]));
    let pair = null;
    for (const s of list) {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    }
    if (!pair) {
      pair = list.find((s) => s.type === "candidate-pair" && s.state === "succeeded" && (s.selected || s.nominated));
    }
    if (!pair) return null;
    const l = byId.get(pair.localCandidateId), r = byId.get(pair.remoteCandidateId);
    return { local: (l && l.candidateType) || null, remote: (r && r.candidateType) || null };
  }
  const isRelayed = (path) => !!path && (path.local === "relay" || path.remote === "relay");

  // What to do with each connection after fresh credentials arrive. A connection
  // whose *local* side is relayed holds an allocation made with the old credentials:
  // it needs an ICE restart. Guests make the offers, so a guest restarts itself and
  // the host asks that guest to restart. The rest just take the new config.
  function refreshPlan(isHost, peers) {
    return peers.map((p) => ({
      id: p.id,
      action: p.path && p.path.local === "relay" ? (isHost ? "ask" : "restart") : "config",
    }));
  }

  root.BeamIce = {
    STUN_ONLY, FALLBACK_CACHE_MS, RETRY_MAX_MS, stunOnly, normalize, load, rtcConfig,
    refreshDelay, selectedPath, isRelayed, refreshPlan,
  };
})(typeof window !== "undefined" ? window : globalThis);
