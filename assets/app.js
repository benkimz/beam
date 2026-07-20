/* beam™ — pairing, direct multi-device transfer, secrets */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const views = ["home", "host", "link", "secret", "reveal"];
  const CHUNK = 16384;
  const HIGH_WATER = 1048576;
  const RELAY_MAX = 7 * 1048576;

  const state = {
    code: null,
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
          endBeam(isHost() ? undefined : "The host ended this beam.");
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
      endBeam("The host ended this beam.");
      return;
    }
    peerGone(remoteId);
  }

  function hostIdleState() {
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
      state.lastMsgId = 0;
      history.replaceState(null, "", "/");
      const p = createPeerFor("h", true);
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      await sendSignal("h", { type: "offer", sdp: offer.sdp });
      $("link-title").textContent = "Connecting…";
      $("link-status").textContent = "Joining beam " + code + "…";
      show("link");
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
    if (msg) toast(msg);
    show("home");
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
    state.incomingBy.set(from, {
      id: m.id, name: m.name || "beamed-file", size: m.size || 0, type: m.type || "",
      chunks: [], received: 0,
      el: txRow("in", m.name || "beamed-file", fmtSize(m.size || 0)),
    });
  }

  function appendIncoming(from, buf) {
    const inc = state.incomingBy.get(from);
    if (!inc) return;
    inc.chunks.push(buf);
    inc.received += buf.byteLength;
    inc.el.querySelector(".bar i").style.width =
      (inc.size ? (inc.received / inc.size) * 100 : 100) + "%";
  }

  function finishIncoming(from) {
    const inc = state.incomingBy.get(from);
    if (!inc) return;
    state.incomingBy.delete(from);
    const blob = new Blob(inc.chunks, { type: inc.type || "application/octet-stream" });
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

  async function createSecret() {
    const text = $("secret-text").value;
    if (!text.trim()) { toast("Write the secret first."); return; }
    if (text.length > 40000) { toast("Secrets are limited to 40,000 characters."); return; }
    const btn = $("btn-secret-create");
    btn.disabled = true;
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
      $("secret-compose").hidden = true;
      $("secret-done").hidden = false;
      $("secret-text").value = "";
    } catch (e) {
      toast(e.message);
    }
    btn.disabled = false;
  }

  async function revealSecret(id, keyStr) {
    const btn = $("btn-reveal");
    btn.disabled = true;
    let fetched = false;
    try {
      const d = await api("secret.php", { action: "read", id });
      fetched = true;
      const packed = b64u.dec(d.ct);
      const key = await crypto.subtle.importKey("raw", b64u.dec(keyStr), "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12)
      );
      $("reveal-text").textContent = new TextDecoder().decode(plain);
      $("reveal-intro").hidden = true;
      $("reveal-out").hidden = false;
      history.replaceState(null, "", "/");
    } catch (e) {
      if (!fetched && e.status === undefined) {
        // network failure — the secret is still intact, let them retry
        toast("Couldn't reach the server — check your connection and try again.");
        btn.disabled = false;
        return;
      }
      $("reveal-intro").hidden = true;
      $("reveal-gone").hidden = false;
      history.replaceState(null, "", "/");
    }
  }

  // ---------- wiring ----------

  $("btn-start").onclick = startBeamAsHost;
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
    if (h.startsWith("#j=")) {
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
