/* beam™ — pairing, direct transfer, secrets */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const views = ["home", "host", "link", "secret", "reveal"];
  const CHUNK = 16384;
  const HIGH_WATER = 1048576;
  const RELAY_MAX = 15 * 1048576;

  const state = {
    code: null,
    role: null,          // 'h' | 'g'
    pc: null,
    dc: null,
    connected: false,
    relayMode: false,
    lastSignalId: 0,
    pollTimer: null,
    fallbackTimer: null,
    sending: false,
    sendQueue: [],
    incoming: null,      // { id, name, size, type, chunks, received, el }
    counter: 0,
  };

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
    if (!res.ok) throw new Error(data.error || "Something went wrong — try again.");
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

  async function sendSignal(obj) {
    await api("beam.php", {
      action: "signal", code: state.code, role: state.role,
      body: JSON.stringify(obj),
    });
  }

  function startPolling() {
    stopPolling();
    const tick = async () => {
      if (!state.code) return;
      try {
        const d = await api("beam.php", {
          action: "poll", code: state.code, role: state.role, after: state.lastSignalId,
        });
        if (state.role === "h" && d.peer && !state.connected && !state.relayMode) {
          $("host-status").textContent = "Device found — connecting…";
        }
        for (const m of d.msgs) {
          state.lastSignalId = Math.max(state.lastSignalId, m.id);
          let body;
          try { body = JSON.parse(m.body); } catch { continue; }
          await handleSignal(body);
        }
      } catch (e) {
        if (String(e.message).includes("expired") || String(e.message).includes("No beam")) {
          endBeam("This beam expired. Start a new one when you're ready.");
          return;
        }
      }
      state.pollTimer = setTimeout(tick, state.connected ? 4000 : 1200);
    };
    tick();
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  async function handleSignal(msg) {
    try {
      if (msg.type === "offer") {
        setupPeer(false);
        await state.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const ans = await state.pc.createAnswer();
        await state.pc.setLocalDescription(ans);
        await sendSignal({ type: "answer", sdp: ans.sdp });
        armFallback();
      } else if (msg.type === "answer" && state.pc) {
        await state.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } else if (msg.type === "ice" && state.pc && msg.c) {
        await state.pc.addIceCandidate(msg.c).catch(() => {});
      } else if (msg.type === "text") {
        addTextTx("in", msg.body);
        if (!state.connected) toast("Text received via relay.");
      } else if (msg.type === "relay-file") {
        receiveRelayFile(msg);
      }
    } catch (e) {
      console.warn("signal handling", e);
    }
  }

  // ---------- WebRTC ----------

  function setupPeer(initiator) {
    if (state.pc) return;
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    state.pc = pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal({ type: "ice", c: ev.candidate.toJSON() }).catch(() => {});
    };
    if (initiator) {
      attachChannel(pc.createDataChannel("beam", { ordered: true }));
    } else {
      pc.ondatachannel = (ev) => attachChannel(ev.channel);
    }
  }

  function attachChannel(dc) {
    state.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = 262144;
    dc.onopen = () => {
      state.connected = true;
      state.relayMode = false;
      clearTimeout(state.fallbackTimer);
      document.body.classList.add("beaming");
      $("link-title").textContent = "Beamed in.";
      $("link-status").textContent = "Connected directly — transfers are device-to-device.";
      $("drop-hint").textContent = "any size · straight to the other device";
      show("link");
      toast("Devices connected.");
    };
    dc.onclose = () => {
      if (state.code) {
        state.connected = false;
        enterRelayMode("The direct connection dropped — falling back to relay.");
      }
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "text") addTextTx("in", m.body);
        else if (m.t === "file") beginIncoming(m);
        else if (m.t === "end") finishIncoming();
      } else {
        appendIncoming(ev.data);
      }
    };
  }

  async function startBeamAsHost() {
    try {
      const d = await api("beam.php", { action: "create" });
      state.code = d.code;
      state.role = "h";
      state.lastSignalId = 0;
      $("code-text").textContent = d.code;
      renderQR("https://beamtm.com/#j=" + d.code);
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
    try {
      await api("beam.php", { action: "join", code });
      state.code = code;
      state.role = "g";
      state.lastSignalId = 0;
      history.replaceState(null, "", "/");
      setupPeer(true);
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      await sendSignal({ type: "offer", sdp: offer.sdp });
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
      if (!state.connected && state.code) {
        enterRelayMode("Couldn't connect directly (strict network) — using relay instead.");
      }
    }, 15000);
  }

  function enterRelayMode(reason) {
    state.relayMode = true;
    document.body.classList.remove("beaming");
    $("link-title").textContent = "Beaming via relay";
    $("link-status").textContent = reason + " Files up to 15 MB.";
    $("link-status").classList.remove("live");
    $("drop-hint").textContent = "up to 15 MB via relay";
    show("link");
  }

  function endBeam(msg) {
    stopPolling();
    clearTimeout(state.fallbackTimer);
    try { state.dc && state.dc.close(); } catch {}
    try { state.pc && state.pc.close(); } catch {}
    Object.assign(state, {
      code: null, role: null, pc: null, dc: null, connected: false,
      relayMode: false, lastSignalId: 0, sending: false, sendQueue: [], incoming: null,
    });
    document.body.classList.remove("beaming");
    $("transfers").innerHTML = "";
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
      if (state.connected) await sendFileP2P(f);
      else if (state.relayMode) await sendFileRelay(f);
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
    const dc = state.dc;
    const id = ++state.counter;
    const el = txRow("out", f.name, fmtSize(f.size));
    dc.send(JSON.stringify({ t: "file", id, name: f.name, size: f.size, type: f.type }));
    let sent = 0;
    for (let off = 0; off < f.size; off += CHUNK) {
      const buf = await f.slice(off, off + CHUNK).arrayBuffer();
      if (dc.readyState !== "open") throw new Error("connection closed");
      if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);
      dc.send(buf);
      sent = Math.min(f.size, off + CHUNK);
      el.querySelector(".bar i").style.width = (f.size ? (sent / f.size) * 100 : 100) + "%";
    }
    dc.send(JSON.stringify({ t: "end", id }));
    el.querySelector(".detail").textContent = fmtSize(f.size) + " · beamed";
    el.querySelector(".bar i").style.width = "100%";
  }

  async function sendFileRelay(f) {
    if (f.size > RELAY_MAX) {
      toast("Relay is limited to 15 MB. For big files, connect both devices directly.");
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
    await sendSignal({ type: "relay-file", name: f.name, size: f.size });
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

  function beginIncoming(m) {
    state.incoming = {
      id: m.id, name: m.name || "beamed-file", size: m.size || 0, type: m.type || "",
      chunks: [], received: 0,
      el: txRow("in", m.name || "beamed-file", fmtSize(m.size || 0)),
    };
  }

  function appendIncoming(buf) {
    const inc = state.incoming;
    if (!inc) return;
    inc.chunks.push(buf);
    inc.received += buf.byteLength;
    inc.el.querySelector(".bar i").style.width =
      (inc.size ? (inc.received / inc.size) * 100 : 100) + "%";
  }

  function finishIncoming() {
    const inc = state.incoming;
    if (!inc) return;
    state.incoming = null;
    const blob = new Blob(inc.chunks, { type: inc.type || "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = inc.name;
    a.textContent = "Save";
    inc.el.append(a);
    inc.el.querySelector(".detail").textContent = fmtSize(blob.size) + " · received";
    inc.el.querySelector(".bar i").style.width = "100%";
    toast("Received “" + inc.name + "”.");
  }

  // ---------- QR ----------

  function renderQR(url) {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    $("qr-box").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
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
      $("secret-link").value = "https://beamtm.com/#s=" + d.id + "." + b64u.enc(keyBytes);
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
    try {
      const d = await api("secret.php", { action: "read", id });
      const packed = b64u.dec(d.ct);
      const key = await crypto.subtle.importKey("raw", b64u.dec(keyStr), "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12)
      );
      $("reveal-text").textContent = new TextDecoder().decode(plain);
      $("reveal-intro").hidden = true;
      $("reveal-out").hidden = false;
    } catch (e) {
      $("reveal-intro").hidden = true;
      $("reveal-gone").hidden = false;
    }
    history.replaceState(null, "", "/");
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
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
  dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove("over");
    if (e.dataTransfer.files.length) queueFiles(e.dataTransfer.files);
  };
  $("file-input").onchange = (e) => { queueFiles(e.target.files); e.target.value = ""; };

  $("btn-send-text").onclick = async () => {
    const v = $("text-input").value;
    if (!v.trim()) return;
    if (state.connected) {
      state.dc.send(JSON.stringify({ t: "text", body: v }));
      addTextTx("out", v);
      $("text-input").value = "";
    } else if (state.relayMode) {
      try {
        await sendSignal({ type: "text", body: v });
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
        show("reveal");
        $("btn-reveal").onclick = () => revealSecret(id, key);
        return;
      }
      show("home");
    } else {
      show("home");
    }
  }

  route();
})();
