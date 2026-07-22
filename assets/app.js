/* beam™ — pairing, direct multi-device transfer, secrets */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const views = ["home", "host", "link", "chat", "secret", "reveal"];
  const CHUNK = 16384;
  const HIGH_WATER = 1048576;
  const RELAY_MAX = 7 * 1048576;
  const CHAT_MEDIA_MAX = 10 * 1048576;

  const state = {
    code: null,
    mode: "beam",        // 'beam' | 'chat'
    nick: "",
    roster: [],          // [[peerId, nick], ...] — host-authored, P2P only
    peer: null,          // my id: 'h' or 'gXXXX'
    peers: new Map(),    // remoteId -> { pc, dc, open, pendingIce: [] }
    relayMode: false,
    lastMsgId: 0,
    pollTimer: null,
    fallbackTimer: null,
    sending: false,
    sendQueue: [],
    incomingBy: new Map(), // remoteId -> { id, name, size, type, chunks, received, el }
    objectUrls: [],
    counter: 0,
  };

  const isHost = () => state.peer === "h";
  const openPeers = () =>
    [...state.peers.entries()].filter(([, p]) => p.open && p.dc.readyState === "open");
  const anyOpen = () => openPeers().length > 0;

  // ---------- tiny helpers ----------

  function show(name) {
    views.forEach((v) => { $("view-" + v).hidden = (v !== name); });
    document.body.classList.toggle("chatting", name === "chat");
    window.scrollTo(0, 0);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  async function api(endpoint, payload) {
    const res = await fetch("/api/" + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "Something went wrong — try again.");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      ta.remove();
      return ok;
    }
  }

  const b64u = {
    enc(bytes) {
      let s = "";
      bytes.forEach((b) => { s += String.fromCharCode(b); });
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec(str) {
      const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    },
  };

  // ---------- identity colors (derived, never on the server) ----------

  const COLOR_NAMES = ["coral", "amber", "gold", "lime", "mint", "jade",
    "cyan", "azure", "indigo", "violet", "orchid", "rose"];

  function hueFor(id) {
    let h = 0;
    const s = (state.code || "") + id;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function colorFor(id) { return "hsl(" + hueFor(id) + " 70% 55%)"; }

  function baseColorName(id) {
    return COLOR_NAMES[Math.floor(hueFor(id) / 30) % 12];
  }

  function nameFor(id, nick) {
    if (nick) return nick;
    const base = baseColorName(id);
    // collision-proof: identical color names get a peer-id suffix, and the
    // roster order decides who keeps the plain name — same result on every device
    const twins = state.roster
      .filter(([rid, rnick]) => !rnick && baseColorName(rid) === base)
      .map(([rid]) => rid);
    if (twins.length > 1 && twins.sort()[0] !== id) {
      return base + "·" + id.slice(-2).toLowerCase();
    }
    return base;
  }

  // ---------- signaling ----------

  async function sendSignal(to, obj) {
    await api("beam.php", {
      action: "signal", code: state.code, from: state.peer, to,
      body: JSON.stringify(obj),
    });
  }

  function broadcastSignal(obj) {
    for (const id of state.peers.keys()) {
      sendSignal(id, obj).catch(() => {});
    }
  }

  function startPolling() {
    stopPolling();
    const tick = async () => {
      if (!state.code) return;
      try {
        const d = await api("beam.php", {
          action: "poll", code: state.code, peer: state.peer, after: state.lastMsgId,
        });
        if (isHost() && d.guests > 0 && !anyOpen() && !state.relayMode
            && !$("view-host").hidden) {
          $("host-status").textContent = "Device found — connecting…";
        }
        for (const m of d.msgs) {
          state.lastMsgId = Math.max(state.lastMsgId, m.id);
          let body;
          try { body = JSON.parse(m.body); } catch { continue; }
          await handleSignal(m.sender, body);
        }
        if (d.ended && state.code) {
          endBeam(isHost() ? undefined
            : (state.mode === "chat" ? "The host closed the room." : "The host ended this beam."));
          return;
        }
      } catch (e) {
        if (String(e.message).includes("expired") || String(e.message).includes("No beam")) {
          endBeam("This beam expired. Start a new one when you're ready.");
          return;
        }
      }
      state.pollTimer = setTimeout(tick, anyOpen() ? 4000 : 1200);
    };
    tick();
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  async function handleSignal(from, msg) {
    try {
      if (msg.type === "offer" && isHost()) {
        const p = createPeerFor(from, false);
        await p.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        await flushIce(from);
        const ans = await p.pc.createAnswer();
        await p.pc.setLocalDescription(ans);
        await sendSignal(from, { type: "answer", sdp: ans.sdp });
        armFallback();
      } else if (msg.type === "answer") {
        const p = state.peers.get(from);
        if (p) {
          await p.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          await flushIce(from);
        }
      } else if (msg.type === "ice" && msg.c) {
        const p = state.peers.get(from);
        if (p && p.pc.remoteDescription) {
          await p.pc.addIceCandidate(msg.c).catch(() => {});
        } else if (p) {
          p.pendingIce.push(msg.c);
        }
      } else if (msg.type === "text") {
        addTextTx("in", msg.body);
        if (!anyOpen()) toast("Text received via relay.");
      } else if (msg.type === "relay-file") {
        receiveRelayFile(msg);
      } else if (msg.type === "bye") {
        byeFrom(from);
      }
    } catch (e) {
      console.warn("signal handling", e);
    }
  }

  // ---------- WebRTC ----------

  async function flushIce(remoteId) {
    const p = state.peers.get(remoteId);
    if (!p) return;
    const pend = p.pendingIce.splice(0);
    for (const c of pend) {
      await p.pc.addIceCandidate(c).catch(() => {});
    }
  }

  function createPeerFor(remoteId, initiator) {
    let p = state.peers.get(remoteId);
    if (p) return p;
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    p = { pc, dc: null, open: false, pendingIce: [], lossTimer: null };
    state.peers.set(remoteId, p);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal(remoteId, { type: "ice", c: ev.candidate.toJSON() }).catch(() => {});
    };
    // active liveness: unclean disconnects (wifi drop, phone lock) must not
    // leave a ghost in the device count
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed") {
        peerGone(remoteId);
      } else if (st === "disconnected") {
        clearTimeout(p.lossTimer);
        p.lossTimer = setTimeout(() => {
          if (pc.connectionState === "disconnected") peerGone(remoteId);
        }, 8000);
      } else if (st === "connected") {
        clearTimeout(p.lossTimer);
      }
    };
    if (initiator) {
      attachChannel(remoteId, pc.createDataChannel("beam", { ordered: true }));
    } else {
      pc.ondatachannel = (ev) => attachChannel(remoteId, ev.channel);
    }
    return p;
  }

  function attachChannel(remoteId, dc) {
    const p = state.peers.get(remoteId);
    if (!p) return;
    p.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = 262144;
    dc.onopen = () => {
      p.open = true;
      state.relayMode = false;
      clearTimeout(state.fallbackTimer);
      document.body.classList.add("beaming");
      if (state.mode === "chat") {
        if (!isHost()) {
          try { dc.send(JSON.stringify({ t: "hello", nick: state.nick })); } catch {}
        } else {
          broadcastRoster();
        }
        updateChatUI();
        return;
      }
      updateLinkStatus();
      show("link");
      toast(isHost() && openPeers().length > 1 ? "Another device connected." : "Devices connected.");
    };
    dc.onclose = () => peerGone(remoteId);
    dc.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "text") addTextTx("in", m.body);
        else if (m.t === "file") beginIncoming(remoteId, m);
        else if (m.t === "end") finishIncoming(remoteId);
        else if (m.t === "bye") byeFrom(remoteId);
        else if (m.t === "chat") onChatMsg(remoteId, m);
        else if (m.t === "hello") onHello(remoteId, m);
        else if (m.t === "roster") onRoster(m);
        else if (m.t === "typing") onTyping(remoteId, m);
      } else {
        appendIncoming(remoteId, ev.data);
      }
    };
  }

  function peerGone(remoteId) {
    const p = state.peers.get(remoteId);
    if (!p || !state.code) return;
    clearTimeout(p.lossTimer);
    state.peers.delete(remoteId);
    state.incomingBy.delete(remoteId);
    try { p.dc && p.dc.close(); } catch {}
    try { p.pc.close(); } catch {}
    if (state.mode === "chat") {
      if (isHost()) {
        addChatSys(nameFor(remoteId, p.nick) + " left");
        broadcastRoster();
        updateChatUI();
      } else {
        endBeam("Lost the connection to the room.");
      }
      return;
    }
    if (isHost()) {
      if (anyOpen()) {
        updateLinkStatus();
        toast("A device left the beam.");
      } else {
        hostIdleState();
      }
    } else {
      document.body.classList.remove("beaming");
      enterRelayMode("The direct connection dropped — falling back to relay.");
    }
  }

  function byeFrom(remoteId) {
    if (!isHost() && remoteId === "h") {
      endBeam(state.mode === "chat" ? "The host closed the room." : "The host ended this beam.");
      return;
    }
    peerGone(remoteId);
  }

  function hostIdleState() {
    if (state.mode === "chat") {
      document.body.classList.remove("beaming");
      updateChatUI();
      return;
    }
    state.relayMode = false;
    document.body.classList.remove("beaming");
    setInviteVisible(!!state.code);
    $("link-title").textContent = "Waiting for devices…";
    const st = $("link-status");
    st.classList.remove("live");
    st.textContent = "No devices connected right now — code " + state.code +
      " and the QR still work.";
    $("drop-hint").textContent = "waiting for a device to join";
    show("link");
  }

  function setInviteVisible(visible) {
    $("invite-box").hidden = !visible;
    $("link-grid").classList.toggle("solo", !visible);
  }

  function updateLinkStatus() {
    setInviteVisible(isHost() && !!state.code);
    const n = openPeers().length;
    if (n > 0) {
      $("link-title").textContent = "Beamed in.";
      const st = $("link-status");
      st.classList.add("live");
      if (isHost()) {
        st.textContent = "Connected to " + n + (n === 1 ? " device" : " devices") +
          " · code " + state.code + " — more devices can join with it.";
      } else {
        st.textContent = "Connected directly — transfers are device-to-device.";
      }
      $("drop-hint").textContent = "any size · straight to the other device" + (n > 1 ? "s" : "");
    }
  }

  async function startBeamAsHost() {
    try {
      const d = await api("beam.php", { action: "create" });
      state.code = d.code;
      state.peer = "h";
      state.lastMsgId = 0;
      $("code-text").textContent = d.code;
      const joinUrl = location.origin + "/#j=" + d.code;
      renderQR(joinUrl, "qr-box");
      renderQR(joinUrl, "qr-mini");
      $("code-mini").textContent = d.code;
      $("host-status").textContent = "Waiting for your other device…";
      show("host");
      history.replaceState(null, "", "/");
      startPolling();
    } catch (e) {
      toast(e.message);
    }
  }

  async function joinBeam(codeRaw) {
    const code = (codeRaw || "").toUpperCase().trim();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      toast("Codes are 6 letters and numbers, like KX4M2P.");
      return;
    }
    if (state.code) endBeam(); // leave any current beam before joining another
    try {
      const d = await api("beam.php", { action: "join", code });
      state.code = code;
      state.peer = d.peer;
      state.mode = d.kind === "c" ? "chat" : "beam";
      state.lastMsgId = 0;
      history.replaceState(null, "", "/");
      const p = createPeerFor("h", true);
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      await sendSignal("h", { type: "offer", sdp: offer.sdp });
      if (state.mode === "chat") {
        $("chat-invite").hidden = true;
        const st = $("chat-status");
        st.classList.remove("live");
        st.textContent = "Joining room " + code + "…";
        show("chat");
      } else {
        $("link-title").textContent = "Connecting…";
        $("link-status").textContent = "Joining beam " + code + "…";
        show("link");
      }
      startPolling();
      armFallback();
    } catch (e) {
      toast(e.message);
    }
  }

  function armFallback() {
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = setTimeout(() => {
      if (!anyOpen() && state.code) {
        if (state.mode === "chat") {
          // no server fallback for chat, by design — messages must never transit the server
          if (!isHost()) {
            endBeam("Couldn't connect directly — private chat needs a direct connection between devices.");
          }
          return;
        }
        enterRelayMode("Couldn't connect directly (strict network) — using relay instead.");
      }
    }, 15000);
  }

  function enterRelayMode(reason) {
    state.relayMode = true;
    setInviteVisible(isHost() && !!state.code);
    $("link-title").textContent = "Beaming via relay";
    $("link-status").textContent = reason + " Files up to 7 MB.";
    $("link-status").classList.remove("live");
    $("drop-hint").textContent = "up to 7 MB via relay";
    show("link");
  }

  function endBeam(msg) {
    stopPolling();
    clearTimeout(state.fallbackTimer);
    const wasHost = isHost();
    const code = state.code;
    for (const [, p] of state.peers) {
      clearTimeout(p.lossTimer);
      p.pc.onconnectionstatechange = null;
      if (p.dc) p.dc.onclose = null;
      try { if (p.open && p.dc.readyState === "open") p.dc.send(JSON.stringify({ t: "bye" })); } catch {}
      try { p.dc && p.dc.close(); } catch {}
      try { p.pc.close(); } catch {}
    }
    if (wasHost && code) {
      api("beam.php", { action: "end", code }).catch(() => {});
    }
    state.peers = new Map();
    state.incomingBy = new Map();
    Object.assign(state, {
      code: null, peer: null, relayMode: false, lastMsgId: 0,
      sending: false, sendQueue: [],
    });
    document.body.classList.remove("beaming");
    closePreview();
    $("transfers").innerHTML = "";
    for (const u of state.objectUrls.splice(0)) URL.revokeObjectURL(u);
    setInviteVisible(false);
    $("qr-mini").innerHTML = "";
    $("link-status").classList.add("live");
    state.roster = [];
    state.mode = "beam";
    typingSeen.clear();
    $("chat-typing").textContent = "";
    $("chat-log").innerHTML = "";
    $("chat-members").innerHTML = "";
    $("qr-chat").innerHTML = "";
    $("chat-input").value = "";
    if (msg) toast(msg);
    show("home");
  }

  // ---------- private chat ----------

  async function startChatAsHost() {
    try {
      const d = await api("beam.php", { action: "create", kind: "c" });
      state.code = d.code;
      state.mode = "chat";
      state.peer = "h";
      state.lastMsgId = 0;
      const joinUrl = location.origin + "/#c=" + d.code;
      renderQR(joinUrl, "qr-chat");
      $("code-chat").textContent = d.code;
      history.replaceState(null, "", "/");
      addChatSys("Room open — messages exist only on connected devices");
      broadcastRoster();
      updateChatUI();
      startPolling();
    } catch (e) {
      toast(e.message);
    }
  }

  function updateChatUI() {
    $("chat-invite").hidden = !isHost();
    const st = $("chat-status");
    const n = openPeers().length;
    if (isHost()) {
      if (n > 0) {
        st.classList.add("live");
        st.textContent = (n + 1) + " in the room · code " + state.code +
          " — more can join with it.";
      } else {
        st.classList.remove("live");
        st.textContent = "Waiting for people — share the QR, the link, or code " +
          state.code + ".";
      }
    } else {
      st.classList.add("live");
      st.textContent = "Connected — messages go device-to-device and are never stored.";
    }
    show("chat");
  }

  function sendChat() {
    const v = $("chat-input").value.trim();
    if (!v) return;
    if (!anyOpen()) {
      toast("No one else is connected yet.");
      return;
    }
    const payload = JSON.stringify({ t: "chat", from: state.peer, body: v, nick: state.nick });
    for (const [, p] of openPeers()) p.dc.send(payload);
    addChatMsg(state.peer, v, state.nick, true);
    $("chat-input").value = "";
  }

  function onChatMsg(remoteId, m) {
    const from = m.from || remoteId;
    if (from === state.peer) return;
    if (typeof m.body !== "string" || !m.body) return;
    const nick = typeof m.nick === "string" ? m.nick.slice(0, 24) : "";
    addChatMsg(from, m.body.slice(0, 2000), nick, false);
    if (isHost()) {
      const p = state.peers.get(remoteId);
      if (p && nick && p.nick !== nick) { p.nick = nick; broadcastRoster(); }
      const fwd = JSON.stringify({ t: "chat", from, body: m.body, nick });
      for (const [id, peer] of openPeers()) {
        if (id !== remoteId) peer.dc.send(fwd);
      }
    }
  }

  function onHello(remoteId, m) {
    if (!isHost()) return;
    const p = state.peers.get(remoteId);
    if (p) p.nick = typeof m.nick === "string" ? m.nick.slice(0, 24) : "";
    addChatSys(nameFor(remoteId, p && p.nick) + " joined");
    broadcastRoster();
    updateChatUI();
  }

  function onRoster(m) {
    if (isHost() || !Array.isArray(m.m)) return;
    state.roster = m.m.filter((e) => Array.isArray(e) && typeof e[0] === "string");
    renderMembers();
  }

  function broadcastRoster() {
    if (!isHost()) return;
    const members = [["h", state.nick]];
    for (const [id, p] of state.peers) {
      if (p.open) members.push([id, p.nick || ""]);
    }
    state.roster = members;
    renderMembers();
    const payload = JSON.stringify({ t: "roster", m: members });
    for (const [, p] of openPeers()) {
      try { p.dc.send(payload); } catch {}
    }
  }

  function renderMembers() {
    const box = $("chat-members");
    box.innerHTML = "";
    for (const [id, nick] of state.roster) {
      const chip = document.createElement("span");
      chip.className = "member";
      const dot = document.createElement("i");
      dot.style.background = colorFor(id);
      chip.append(dot, nameFor(id, nick) + (id === state.peer ? " (you)" : ""));
      box.append(chip);
    }
  }

  function rosterNick(id) {
    const e = state.roster.find((r) => r[0] === id);
    return e ? e[1] : "";
  }

  function chatMsgShell(from, mine, nick) {
    const log = $("chat-log");
    const el = document.createElement("div");
    el.className = "msg" + (mine ? " mine" : "");
    const who = document.createElement("div");
    who.className = "who";
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (mine) {
      who.innerHTML = '<span class="ts"></span>';
      who.querySelector(".ts").textContent = time;
    } else {
      who.textContent = nameFor(from, nick || rosterNick(from));
      who.style.color = colorFor(from);
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = " · " + time;
      who.append(ts);
    }
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    el.append(who, bubble);
    log.append(el);
    while (log.children.length > 500) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function addChatMsg(from, body, nick, mine) {
    const el = chatMsgShell(from, mine, nick);
    el.querySelector(".bubble").textContent = body;
    $("chat-log").scrollTop = $("chat-log").scrollHeight;
  }

  function fillMediaBubble(el, blob, name) {
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    const bubble = el.querySelector(".bubble");
    bubble.innerHTML = "";
    if ((blob.type || "").startsWith("image/")) {
      bubble.classList.add("media");
      const img = new Image();
      img.src = url;
      img.alt = name;
      img.className = "chat-img";
      img.onclick = () => openPreview(blob, name, url);
      bubble.append(img);
    } else {
      bubble.append(name + " (" + fmtSize(blob.size) + ") — ");
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.textContent = "Save";
      bubble.append(a);
      if (previewKind(blob.type, name)) {
        const pv = document.createElement("a");
        pv.href = "#";
        pv.textContent = " Preview";
        pv.onclick = (e) => { e.preventDefault(); openPreview(blob, name, url); };
        bubble.append(" ", pv);
      }
    }
  }

  function sendBlobToPeer(p, meta, blob) {
    p.sendChain = (p.sendChain || Promise.resolve()).then(async () => {
      const dc = p.dc;
      if (!dc || dc.readyState !== "open") return;
      dc.send(JSON.stringify(meta));
      for (let off = 0; off < blob.size; off += CHUNK) {
        const buf = await blob.slice(off, off + CHUNK).arrayBuffer();
        if (dc.readyState !== "open") return;
        if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);
        dc.send(buf);
      }
      if (dc.readyState === "open") dc.send(JSON.stringify({ t: "end", id: meta.id }));
    }).catch(() => {});
  }

  function sendChatFiles(files) {
    if (!anyOpen()) {
      toast("No one else is connected yet.");
      return;
    }
    for (const f of files) {
      if (f.size > CHAT_MEDIA_MAX) {
        toast("Chat media is limited to 10 MB — use a beam for big files.");
        continue;
      }
      const meta = { t: "file", id: ++state.counter, name: f.name || "pasted-image.png",
                     size: f.size, type: f.type, from: state.peer, chat: true };
      const el = chatMsgShell(state.peer, true);
      fillMediaBubble(el, f, meta.name);
      for (const [, p] of openPeers()) sendBlobToPeer(p, meta, f);
    }
  }

  // typing indicator — sent at most every 1.5s, shown for 3s
  let lastTypingSent = 0;

  function sendTyping() {
    const now = Date.now();
    if (now - lastTypingSent < 1500 || !anyOpen()) return;
    lastTypingSent = now;
    const payload = JSON.stringify({ t: "typing", from: state.peer });
    for (const [, p] of openPeers()) {
      try { p.dc.send(payload); } catch {}
    }
  }

  const typingSeen = new Map(); // peerId -> last seen ms

  function onTyping(remoteId, m) {
    const from = m.from || remoteId;
    if (from === state.peer) return;
    typingSeen.set(from, Date.now());
    renderTyping();
    setTimeout(renderTyping, 3200);
    if (isHost()) {
      const fwd = JSON.stringify({ t: "typing", from });
      for (const [id, p] of openPeers()) {
        if (id !== remoteId) { try { p.dc.send(fwd); } catch {} }
      }
    }
  }

  function renderTyping() {
    const now = Date.now();
    const names = [];
    for (const [id, ts] of typingSeen) {
      if (now - ts < 3000) names.push(nameFor(id, rosterNick(id)));
      else typingSeen.delete(id);
    }
    $("chat-typing").textContent = names.length
      ? names.join(" & ") + (names.length === 1 ? " is" : " are") + " typing…"
      : "";
  }

  function addChatSys(text) {
    const log = $("chat-log");
    const el = document.createElement("div");
    el.className = "chat-sys";
    el.textContent = text;
    log.append(el);
    log.scrollTop = log.scrollHeight;
  }

  // ---------- transfers (UI rows) ----------

  function txRow(dir, name, detail) {
    const el = document.createElement("div");
    el.className = "tx";
    el.innerHTML =
      '<div class="meta"><span class="name"></span>' +
      '<div class="detail"></div><div class="bar"><i></i></div></div>';
    el.querySelector(".name").textContent = (dir === "in" ? "↓ " : "↑ ") + name;
    el.querySelector(".detail").textContent = detail;
    $("transfers").prepend(el);
    return el;
  }

  function addTextTx(dir, body) {
    const el = document.createElement("div");
    el.className = "tx";
    const meta = document.createElement("div");
    meta.className = "meta";
    const txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = body;
    const label = document.createElement("div");
    label.className = "detail";
    label.textContent = dir === "in" ? "received text" : "sent text";
    meta.append(txt, label);
    el.append(meta);
    if (dir === "in") {
      const btn = document.createElement("a");
      btn.href = "#";
      btn.textContent = "Copy";
      btn.onclick = async (e) => {
        e.preventDefault();
        (await copyText(body)) ? toast("Copied.") : toast("Couldn't copy — select it manually.");
      };
      el.append(btn);
    }
    $("transfers").prepend(el);
  }

  // ---------- sending ----------

  function queueFiles(files) {
    for (const f of files) state.sendQueue.push(f);
    drainQueue();
  }

  async function drainQueue() {
    if (state.sending) return;
    const f = state.sendQueue.shift();
    if (!f) return;
    state.sending = true;
    try {
      if (anyOpen()) await sendFileP2P(f);
      else if (state.relayMode) await sendFileRelay(f);
      else if (isHost()) toast("No devices connected right now — they can join with the code.");
      else toast("Not connected yet — hang on a moment.");
    } catch (e) {
      toast("Sending failed: " + e.message);
    }
    state.sending = false;
    drainQueue();
  }

  function waitForDrain(dc) {
    return new Promise((resolve) => {
      const h = () => { dc.removeEventListener("bufferedamountlow", h); resolve(); };
      dc.addEventListener("bufferedamountlow", h);
    });
  }

  async function sendFileP2P(f) {
    const targets = openPeers();
    const total = f.size * targets.length;
    const id = ++state.counter;
    const el = txRow("out", f.name,
      fmtSize(f.size) + (targets.length > 1 ? " · to " + targets.length + " devices" : ""));
    let done = 0;
    for (const [, p] of targets) {
      const dc = p.dc;
      if (dc.readyState !== "open") continue;
      dc.send(JSON.stringify({ t: "file", id, name: f.name, size: f.size, type: f.type }));
      for (let off = 0; off < f.size; off += CHUNK) {
        const buf = await f.slice(off, off + CHUNK).arrayBuffer();
        if (dc.readyState !== "open") break;
        if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);
        dc.send(buf);
        done += Math.min(CHUNK, f.size - off);
        el.querySelector(".bar i").style.width = (total ? (done / total) * 100 : 100) + "%";
      }
      if (dc.readyState === "open") dc.send(JSON.stringify({ t: "end", id }));
    }
    el.querySelector(".detail").textContent = fmtSize(f.size) + " · beamed" +
      (targets.length > 1 ? " to " + targets.length + " devices" : "");
    el.querySelector(".bar i").style.width = "100%";
  }

  async function sendFileRelay(f) {
    if (f.size > RELAY_MAX) {
      toast("Relay is limited to 7 MB. For big files, connect both devices directly.");
      return;
    }
    const el = txRow("out", f.name, fmtSize(f.size) + " · uploading to relay");
    el.querySelector(".bar i").style.width = "30%";
    const res = await fetch("/api/relay.php", {
      method: "POST",
      headers: { "X-Beam-Code": state.code, "X-Beam-Name": f.name },
      body: f,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.querySelector(".detail").textContent = "failed";
      throw new Error(d.error || "relay upload failed");
    }
    if (isHost()) broadcastSignal({ type: "relay-file", name: f.name, size: f.size });
    else await sendSignal("h", { type: "relay-file", name: f.name, size: f.size });
    el.querySelector(".bar i").style.width = "100%";
    el.querySelector(".detail").textContent = fmtSize(f.size) + " · waiting for pickup";
  }

  function receiveRelayFile(msg) {
    const el = txRow("in", msg.name || "beamed-file", fmtSize(msg.size || 0) + " · via relay");
    const a = document.createElement("a");
    a.href = "/api/relay.php?code=" + encodeURIComponent(state.code);
    a.textContent = "Download";
    a.setAttribute("download", msg.name || "beamed-file");
    el.append(a);
    el.querySelector(".bar i").style.width = "100%";
    toast("A file is waiting — tap Download. It's deleted once you take it.");
  }

  // ---------- receiving (P2P) ----------

  function beginIncoming(from, m) {
    const isChat = state.mode === "chat" || m.chat === true;
    const inc = {
      id: m.id, name: m.name || "beamed-file", size: m.size || 0, type: m.type || "",
      chunks: [], received: 0, chat: isChat, from: m.from || from,
    };
    if (isChat) {
      inc.el = chatMsgShell(inc.from, false);
      inc.el.querySelector(".bubble").textContent = "↓ " + inc.name + " — 0%";
    } else {
      inc.el = txRow("in", inc.name, fmtSize(inc.size));
    }
    state.incomingBy.set(from, inc);
  }

  function appendIncoming(from, buf) {
    const inc = state.incomingBy.get(from);
    if (!inc) return;
    inc.chunks.push(buf);
    inc.received += buf.byteLength;
    if (inc.chat) {
      inc.el.querySelector(".bubble").textContent = "↓ " + inc.name + " — " +
        (inc.size ? Math.floor((inc.received / inc.size) * 100) : 0) + "%";
      return;
    }
    inc.el.querySelector(".bar i").style.width =
      (inc.size ? (inc.received / inc.size) * 100 : 100) + "%";
  }

  function finishIncoming(from) {
    const inc = state.incomingBy.get(from);
    if (!inc) return;
    state.incomingBy.delete(from);
    const blob = new Blob(inc.chunks, { type: inc.type || "application/octet-stream" });
    if (inc.chat) {
      fillMediaBubble(inc.el, blob, inc.name);
      $("chat-log").scrollTop = $("chat-log").scrollHeight;
      if (isHost()) {
        // star topology: relay the finished file to every other member
        const meta = { t: "file", id: ++state.counter, name: inc.name, size: blob.size,
                       type: blob.type, from: inc.from, chat: true };
        for (const [id, p] of openPeers()) {
          if (id !== from) sendBlobToPeer(p, meta, blob);
        }
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    if (previewKind(blob.type, inc.name)) {
      const pv = document.createElement("a");
      pv.href = "#";
      pv.textContent = "Preview";
      pv.onclick = (e) => { e.preventDefault(); openPreview(blob, inc.name, url); };
      inc.el.append(pv);
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = inc.name;
    a.textContent = "Save";
    inc.el.append(a);
    inc.el.querySelector(".detail").textContent = fmtSize(blob.size) + " · received";
    inc.el.querySelector(".bar i").style.width = "100%";
    toast("Received “" + inc.name + "”.");
  }

  // ---------- preview lightbox ----------

  function previewKind(type, name) {
    const t = (type || "").toLowerCase();
    if (t.startsWith("image/")) return "image";
    if (t.startsWith("video/")) return "video";
    if (t.startsWith("audio/")) return "audio";
    if (t === "application/pdf") return "pdf";
    if (t.startsWith("text/") || t === "application/json"
        || /\.(txt|md|json|csv|log|js|py|html|css|xml|yml|yaml)$/i.test(name || "")) return "text";
    return null;
  }

  function openPreview(blob, name, url) {
    const kind = previewKind(blob.type, name);
    const body = $("lb-body");
    body.innerHTML = "";
    $("lb-name").textContent = name;
    const save = $("lb-save");
    save.href = url;
    save.setAttribute("download", name);
    let el = null;
    if (kind === "image") {
      el = new Image();
      el.src = url;
      el.alt = name;
    } else if (kind === "video") {
      el = document.createElement("video");
      el.src = url;
      el.controls = true;
      el.playsInline = true;
    } else if (kind === "audio") {
      el = document.createElement("audio");
      el.src = url;
      el.controls = true;
    } else if (kind === "pdf") {
      el = document.createElement("iframe");
      el.src = url;
      el.title = name;
    } else if (kind === "text") {
      el = document.createElement("pre");
      el.textContent = "Loading…";
      blob.slice(0, 2097152).text().then((t) => {
        el.textContent = t + (blob.size > 2097152 ? "\n… (preview truncated)" : "");
      });
    }
    if (el) body.append(el);
    $("lightbox").hidden = false;
    $("lb-close").focus();
  }

  function closePreview() {
    $("lightbox").hidden = true;
    $("lb-body").innerHTML = ""; // removing the element also stops any playback
  }

  // ---------- QR ----------

  function renderQR(url, elId) {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    $(elId).innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
  }

  // ---------- QR scanner (BarcodeDetector where available, jsQR fallback) ----------

  let scanStream = null;
  let scanRAF = null;

  async function openScanner() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("This browser can't open the camera — type the code instead.");
      return;
    }
    $("scanner").hidden = false;
    $("scan-status").textContent = "Point your camera at the beam QR code.";
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
    } catch {
      closeScanner();
      toast("Couldn't open the camera — check permission, or type the code.");
      return;
    }
    const v = $("scan-video");
    v.srcObject = scanStream;
    await v.play().catch(() => {});

    let detector = null;
    if ("BarcodeDetector" in window) {
      try { detector = new BarcodeDetector({ formats: ["qr_code"] }); } catch {}
    }
    if (!detector && !window.jsQR) {
      $("scan-status").textContent = "Loading scanner…";
      await new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "/assets/jsqr.js?v=1";
        s.onload = resolve;
        s.onerror = resolve;
        document.head.append(s);
      });
      if (!window.jsQR) {
        closeScanner();
        toast("Scanning isn't supported here — type the code instead.");
        return;
      }
      $("scan-status").textContent = "Point your camera at the beam QR code.";
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if ($("scanner").hidden) return;
      if (v.readyState >= 2 && v.videoWidth) {
        let text = null;
        if (detector) {
          const codes = await detector.detect(v).catch(() => []);
          if (codes.length) text = codes[0].rawValue;
        } else {
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const r = window.jsQR(img.data, img.width, img.height);
          if (r) text = r.data;
        }
        if (text) {
          const m = text.match(/#j=([A-Za-z2-9]{6})\b/) || text.match(/^\s*([A-Za-z2-9]{6})\s*$/);
          if (m) {
            closeScanner();
            joinBeam(m[1]);
            return;
          }
          $("scan-status").textContent = "That QR isn't a beam code — keep looking.";
        }
      }
      scanRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  function closeScanner() {
    cancelAnimationFrame(scanRAF);
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
    $("scan-video").srcObject = null;
    $("scanner").hidden = true;
  }

  // ---------- secrets ----------

  const SECRET_MAX_CHARS = 40000;

  function updateSecretCount() {
    const n = $("secret-text").value.length;
    const el = $("secret-count");
    el.textContent = n ? n.toLocaleString() + " / " + SECRET_MAX_CHARS.toLocaleString() : "";
    el.classList.toggle("warn", n > SECRET_MAX_CHARS);
  }

  async function createSecret() {
    const text = $("secret-text").value;
    if (!text.trim()) { toast("Write the secret first."); return; }
    if (text.length > SECRET_MAX_CHARS) { toast("Secrets are limited to 40,000 characters."); return; }
    const btn = $("btn-secret-create");
    btn.disabled = true;
    btn.textContent = "Encrypting…";
    const ttlSel = $("secret-ttl");
    const ttlLabel = ttlSel.options[ttlSel.selectedIndex].text;
    try {
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const cipher = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, key, new TextEncoder().encode(text)
      ));
      const packed = new Uint8Array(iv.length + cipher.length);
      packed.set(iv, 0);
      packed.set(cipher, iv.length);
      const d = await api("secret.php", {
        action: "create", ct: b64u.enc(packed), ttl: parseInt($("secret-ttl").value, 10),
      });
      $("secret-link").value = location.origin + "/#s=" + d.id + "." + b64u.enc(keyBytes);
      $("secret-expiry").textContent =
        "If nobody opens it, it deletes itself after " + ttlLabel + ".";
      $("btn-secret-share").hidden = !navigator.share;
      $("secret-compose").hidden = true;
      $("secret-done").hidden = false;
      $("secret-text").value = "";
      updateSecretCount();
    } catch (e) {
      toast(e.message);
    }
    btn.disabled = false;
    btn.textContent = "Create one-time link";
  }

  // Short texts resolve out of cipher glyphs — decryption made visible.
  // Long texts blur into focus instead; scrambling 40k chars would just lag.
  function materializeText(el, text) {
    el.classList.remove("materialize");
    if (text.length > 400 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = text;
      void el.offsetWidth; // restart the CSS animation
      el.classList.add("materialize");
      return;
    }
    const glyphs = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789#*+=%$@!?";
    const dur = 650;
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const resolved = Math.floor(text.length * k);
      let out = text.slice(0, resolved);
      for (let i = resolved; i < text.length; i++) {
        const ch = text[i];
        out += (ch === "\n" || ch === " ") ? ch : glyphs[(Math.random() * glyphs.length) | 0];
      }
      el.textContent = out;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function revealSecret(id, keyStr) {
    const btn = $("btn-reveal");
    btn.disabled = true;
    btn.textContent = "Decrypting…";
    let fetched = false;
    try {
      const d = await api("secret.php", { action: "read", id });
      fetched = true;
      const packed = b64u.dec(d.ct);
      const key = await crypto.subtle.importKey("raw", b64u.dec(keyStr), "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12)
      );
      $("reveal-intro").hidden = true;
      $("reveal-out").hidden = false;
      materializeText($("reveal-text"), new TextDecoder().decode(plain));
      history.replaceState(null, "", "/");
    } catch (e) {
      if (!fetched && e.status === undefined) {
        // network failure — the secret is still intact, let them retry
        toast("Couldn't reach the server — check your connection and try again.");
        btn.disabled = false;
        btn.textContent = "Reveal secret";
        return;
      }
      $("reveal-intro").hidden = true;
      $("reveal-gone").hidden = false;
      history.replaceState(null, "", "/");
    }
  }

  // ---------- wiring ----------

  $("btn-start").onclick = startBeamAsHost;
  $("btn-chat").onclick = startChatAsHost;
  $("btn-chat-send").onclick = sendChat;
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  $("chat-nick").addEventListener("change", () => {
    state.nick = $("chat-nick").value.trim().slice(0, 24);
    if (state.mode !== "chat") return;
    if (isHost()) {
      broadcastRoster();
    } else {
      const p = state.peers.get("h");
      if (p && p.open) {
        try { p.dc.send(JSON.stringify({ t: "hello", nick: state.nick })); } catch {}
      }
    }
  });
  $("btn-chat-attach").onclick = () => $("chat-file").click();
  $("chat-file").onchange = (e) => { sendChatFiles(e.target.files); e.target.value = ""; };
  $("chat-input").addEventListener("input", sendTyping);
  window.addEventListener("paste", (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    if (!$("view-chat").hidden) {
      e.preventDefault();
      sendChatFiles(files);
    } else if (!$("view-link").hidden) {
      e.preventDefault();
      queueFiles(files);
    }
  });
  $("btn-chat-copylink").onclick = async () => {
    (await copyText(location.origin + "/#c=" + state.code))
      ? toast("Invite link copied.")
      : toast("Couldn't copy — the code is " + state.code);
  };
  $("btn-secret").onclick = () => {
    $("secret-compose").hidden = false;
    $("secret-done").hidden = true;
    show("secret");
  };
  $("btn-join").onclick = () => joinBeam($("join-code").value);
  $("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinBeam($("join-code").value);
  });
  $("btn-host-cancel").onclick = () => endBeam();

  document.querySelectorAll("[data-back]").forEach((el) => {
    el.onclick = (e) => { e.preventDefault(); endBeam(); };
  });

  const dz = $("drop-zone");
  dz.onclick = () => $("file-input").click();
  dz.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); } };
  $("file-input").onchange = (e) => { queueFiles(e.target.files); e.target.value = ""; };

  // the whole window is the drop target while beaming; drops elsewhere
  // must never trigger the browser's default file-open navigation
  const dragHasFiles = (e) =>
    e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!$("view-link").hidden && dragHasFiles(e)) {
      document.body.classList.add("dragging");
    }
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    if (!$("view-link").hidden && e.dataTransfer.files.length) {
      queueFiles(e.dataTransfer.files);
    }
  });

  $("btn-send-text").onclick = async () => {
    const v = $("text-input").value;
    if (!v.trim()) return;
    if (anyOpen()) {
      for (const [, p] of openPeers()) p.dc.send(JSON.stringify({ t: "text", body: v }));
      addTextTx("out", v);
      $("text-input").value = "";
    } else if (state.relayMode) {
      try {
        if (isHost()) broadcastSignal({ type: "text", body: v });
        else await sendSignal("h", { type: "text", body: v });
        addTextTx("out", v);
        $("text-input").value = "";
      } catch (e) { toast(e.message); }
    } else {
      toast("Not connected yet — hang on a moment.");
    }
  };
  $("text-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-send-text").click();
  });

  $("btn-scan").onclick = openScanner;
  $("btn-scan-close").onclick = closeScanner;

  $("lb-close").onclick = closePreview;
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox")) closePreview();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("lightbox").hidden) closePreview();
    if (!$("scanner").hidden) closeScanner();
  });

  $("btn-secret-create").onclick = createSecret;
  $("secret-text").addEventListener("input", updateSecretCount);
  $("btn-secret-share").onclick = async () => {
    try {
      await navigator.share({ url: $("secret-link").value });
    } catch {} // user closed the share sheet — not an error
  };
  $("btn-secret-copy").onclick = async () => {
    (await copyText($("secret-link").value)) ? toast("Link copied.") : toast("Couldn't copy — select it manually.");
  };
  $("btn-secret-again").onclick = () => {
    $("secret-compose").hidden = false;
    $("secret-done").hidden = true;
  };
  $("btn-reveal-copy").onclick = async () => {
    (await copyText($("reveal-text").textContent)) ? toast("Copied.") : toast("Couldn't copy — select it manually.");
  };

  // ---------- routing ----------

  function route() {
    const h = location.hash;
    if (h.startsWith("#j=") || h.startsWith("#c=")) {
      const code = h.slice(3);
      show("home");
      joinBeam(code);
    } else if (h.startsWith("#s=")) {
      const rest = h.slice(3);
      const dot = rest.indexOf(".");
      if (dot > 0) {
        const id = rest.slice(0, dot);
        const key = rest.slice(dot + 1);
        $("reveal-intro").hidden = false;
        $("reveal-out").hidden = true;
        $("reveal-gone").hidden = true;
        $("btn-reveal").disabled = false;
        $("btn-reveal").textContent = "Reveal secret";
        $("btn-reveal").onclick = () => revealSecret(id, key);
        show("reveal");
        return;
      }
      show("home");
    } else {
      show("home");
    }
  }

  // anonymous page-view tick: a bare counter increment, nothing identifying
  try { navigator.sendBeacon && navigator.sendBeacon("/api/stats.php", "1"); } catch {}

  window.addEventListener("hashchange", () => {
    if (state.code) return; // never yank an active beam
    route();
  });

  route();
})();
