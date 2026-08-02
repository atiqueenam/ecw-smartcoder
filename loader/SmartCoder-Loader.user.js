// ==UserScript==
// @name         eCW SmartCoder Client Loader
// @namespace    https://github.com/atiqueenam/ecw-smartcoder
// @version      1.0.0
// @description  Selects, caches, verifies, and runs the configured SmartCoder client.
// @match        https://*.com/mobiledoc/jsp/webemr/*
// @match        *://*.eclinicalworks.com/*
// @match        *://*.ecwcloud.com/*
// @match        *://*.eclinicalweb.com/*
// @updateURL    https://raw.githubusercontent.com/atiqueenam/ecw-smartcoder/main/loader/SmartCoder-Loader.user.js
// @downloadURL  https://raw.githubusercontent.com/atiqueenam/ecw-smartcoder/main/loader/SmartCoder-Loader.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const REPOSITORY_RAW = "https://raw.githubusercontent.com/atiqueenam/ecw-smartcoder/main/";
  const REGISTRY_URL = `${REPOSITORY_RAW}registry/clients.json`;
  const STORAGE = {
    userId: "ecw_smartcoder_user_id",
    selectedClient: "ecw_smartcoder_selected_client",
    registry: "ecw_smartcoder_registry",
    scriptPrefix: "ecw_smartcoder_script_"
  };
  const SESSION_FORCE_REFRESH = "ecw_smartcoder_force_refresh";
  const UI_ID = "ecw-smartcoder-loader-ui";

  let registry = null;
  let uiHost = null;
  let statusMessage = "Starting…";
  let statusLevel = "normal";
  let busy = false;

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function readJson(key) {
    const value = readStorage(key);
    if (!value) return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function createUserId() {
    const existing = readStorage(STORAGE.userId);
    if (existing) return existing;
    const id = window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    writeStorage(STORAGE.userId, id);
    return id;
  }

  function isBrowserReload() {
    try {
      const navigation = performance.getEntriesByType("navigation")[0];
      if (navigation) return navigation.type === "reload";
      return performance.navigation && performance.navigation.type === 1;
    } catch (_) {
      return false;
    }
  }

  function consumeForcedRefresh() {
    try {
      const forced = sessionStorage.getItem(SESSION_FORCE_REFRESH) === "1";
      sessionStorage.removeItem(SESSION_FORCE_REFRESH);
      return forced;
    } catch (_) {
      return false;
    }
  }

  async function fetchText(url) {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    return response.text();
  }

  function validateRegistry(value) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.clients)) {
      throw new Error("The client registry has an invalid format.");
    }
    const ids = new Set();
    for (const client of value.clients) {
      if (!client || !/^[a-z0-9-]+$/.test(client.id || "") || ids.has(client.id)) {
        throw new Error("The registry contains an invalid or duplicate client ID.");
      }
      ids.add(client.id);
      if (typeof client.name !== "string" || !client.name.trim()) throw new Error("A client has no name.");
      if (!/^[a-z0-9-]+$/.test(client.siteId || "")) throw new Error(`${client.id} has an invalid site ID.`);
      if (!Array.isArray(client.hostnames) || !client.hostnames.length || client.hostnames.some(hostname => !/^[a-z0-9.-]+$/i.test(hostname))) {
        throw new Error(`${client.id} has an invalid hostname list.`);
      }
      if (typeof client.version !== "string" || !client.version.trim()) throw new Error(`${client.id} has no version.`);
      if (typeof client.file !== "string" || client.file !== `clients/${client.id}/smartcoder.js`) {
        throw new Error(`${client.id} has an invalid script location.`);
      }
      if (!/^[a-f0-9]{64}$/i.test(client.sha256 || "")) throw new Error(`${client.id} has an invalid checksum.`);
    }
    return value;
  }

  function cachedRegistry() {
    const value = readJson(STORAGE.registry);
    if (!value) return null;
    try { return validateRegistry(value); } catch (_) { return null; }
  }

  async function downloadRegistry() {
    const text = await fetchText(REGISTRY_URL);
    const value = validateRegistry(JSON.parse(text));
    writeStorage(STORAGE.registry, JSON.stringify(value));
    return value;
  }

  async function sha256(text) {
    if (!window.crypto || !window.crypto.subtle) throw new Error("This browser cannot verify scripts securely.");
    const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function clientScriptUrl(client) {
    const url = new URL(client.file, REPOSITORY_RAW);
    if (url.origin !== "https://raw.githubusercontent.com") throw new Error("Invalid script host.");
    return url.href;
  }

  function cachedScript(clientId) {
    const value = readJson(STORAGE.scriptPrefix + clientId);
    if (!value || typeof value.code !== "string" || typeof value.sha256 !== "string") return null;
    return value;
  }

  async function cachedScriptIsValid(value, expectedHash) {
    if (!value || value.sha256.toLowerCase() !== expectedHash.toLowerCase()) return false;
    return (await sha256(value.code)) === expectedHash.toLowerCase();
  }

  async function obtainClientScript(client) {
    const cached = cachedScript(client.id);
    if (await cachedScriptIsValid(cached, client.sha256)) {
      return { code: cached.code, source: "local cache", stale: false };
    }

    try {
      const code = await fetchText(clientScriptUrl(client));
      const actualHash = await sha256(code);
      if (actualHash !== client.sha256.toLowerCase()) {
        throw new Error(`Security check failed for ${client.name} v${client.version}.`);
      }
      writeStorage(STORAGE.scriptPrefix + client.id, JSON.stringify({
        version: client.version,
        sha256: client.sha256.toLowerCase(),
        code
      }));
      return { code, source: "GitHub", stale: false };
    } catch (downloadError) {
      if (cached && await cachedScriptIsValid(cached, cached.sha256)) {
        return { code: cached.code, source: "older local cache", stale: true, warning: downloadError.message };
      }
      throw downloadError;
    }
  }

  function executeScript(client, code) {
    const sourceUrl = clientScriptUrl(client).replace(/\s/g, "%20");
    const run = new Function(`${code}\n//# sourceURL=${sourceUrl}`);
    run.call(window);
  }

  function selectedClientId() {
    return readStorage(STORAGE.selectedClient) || "";
  }

  function clientForCurrentHostname() {
    const hostname = location.hostname.toLowerCase();
    return registry && registry.clients.find(client =>
      client.hostnames.some(value => value.toLowerCase() === hostname)
    );
  }

  function setStatus(message, level = "normal") {
    statusMessage = message;
    statusLevel = level;
    renderUi();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
    })[character]);
  }

  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }

  function renderUi() {
    if (!document.body || !registry) return;
    if (!uiHost || !uiHost.isConnected) {
      uiHost = document.createElement("div");
      uiHost.id = UI_ID;
      document.body.appendChild(uiHost);
      uiHost.attachShadow({ mode: "open" });
    }

    const selected = selectedClientId();
    const options = registry.clients.map(client =>
      `<option value="${client.id}"${client.id === selected ? " selected" : ""}>${escapeHtml(client.name)} (${escapeHtml(client.siteId)}) — v${escapeHtml(client.version)}</option>`
    ).join("");
    const color = statusLevel === "error" ? "#b91c1c" : statusLevel === "warning" ? "#a16207" : "#64748b";
    const shortUserId = createUserId().split("-").slice(-1)[0].slice(-8);

    uiHost.shadowRoot.innerHTML = `
      <style>
        :host { all:initial; }
        .card { position:fixed; right:12px; bottom:12px; z-index:2147483647; box-sizing:border-box;
          width:232px; padding:9px; border:1px solid #cbd5e1; border-radius:10px; background:#fff;
          box-shadow:0 5px 18px rgba(15,23,42,.2); font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }
        .top { display:flex; align-items:center; justify-content:space-between; margin-bottom:5px; }
        label { color:#0f172a; font-weight:750; }
        .uid { color:#94a3b8; font-size:9.5px; }
        select { box-sizing:border-box; width:100%; height:30px; padding:0 7px; border:1px solid #94a3b8;
          border-radius:6px; background:#fff; color:#0f172a; font:12px "Segoe UI",Arial,sans-serif; }
        button { width:100%; height:27px; margin-top:6px; border:0; border-radius:6px; background:#2563eb;
          color:#fff; cursor:pointer; font:600 11px "Segoe UI",Arial,sans-serif; }
        button:disabled { background:#94a3b8; cursor:wait; }
        .status { margin-top:5px; color:${color}; font-size:10px; overflow-wrap:anywhere; }
      </style>
      <div class="card">
        <div class="top"><label for="client">eCW SmartCoder client</label><span class="uid">ID ${escapeHtml(shortUserId)}</span></div>
        <select id="client"${busy ? " disabled" : ""}>
          <option value="">Choose a client…</option>${options}
        </select>
        <button id="refresh" type="button"${busy ? " disabled" : ""}>${busy ? "Checking…" : "Check updates / Refresh clients"}</button>
        <div class="status">${escapeHtml(statusMessage)}</div>
      </div>`;

    uiHost.shadowRoot.getElementById("client").addEventListener("change", event => {
      writeStorage(STORAGE.selectedClient, event.target.value);
      try { sessionStorage.setItem(SESSION_FORCE_REFRESH, "1"); } catch (_) {}
      location.reload();
    }, { once: true });

    uiHost.shadowRoot.getElementById("refresh").addEventListener("click", () => {
      try { sessionStorage.setItem(SESSION_FORCE_REFRESH, "1"); } catch (_) {}
      location.reload();
    }, { once: true });
  }

  async function start() {
    createUserId();
    const localRegistry = cachedRegistry();
    const shouldRefresh = consumeForcedRefresh() || isBrowserReload() || !localRegistry;

    if (shouldRefresh) {
      busy = true;
      registry = localRegistry || { schemaVersion: 1, clients: [] };
      await waitForBody();
      setStatus("Checking GitHub for client updates…");
      try {
        registry = await downloadRegistry();
        setStatus("Client list is current.");
      } catch (error) {
        if (!localRegistry) throw error;
        registry = localRegistry;
        setStatus(`GitHub unavailable; using saved client list. ${error.message}`, "warning");
      } finally {
        busy = false;
        renderUi();
      }
    } else {
      registry = localRegistry;
      await waitForBody();
      setStatus("Using saved client list. Reload or press Check updates to refresh.");
    }

    let selected = selectedClientId();
    const detectedClient = clientForCurrentHostname();
    if (!selected && detectedClient) {
      selected = detectedClient.id;
      writeStorage(STORAGE.selectedClient, selected);
      setStatus(`Automatically selected ${detectedClient.name} for ${detectedClient.siteId}.`);
    }
    if (!selected) {
      setStatus("Select a client once; the choice will be remembered.", "warning");
      return;
    }

    const client = registry.clients.find(item => item.id === selected);
    if (!client) {
      writeStorage(STORAGE.selectedClient, "");
      setStatus("The saved client is unavailable. Select a client.", "warning");
      return;
    }

    setStatus(`Loading ${client.name} v${client.version}…`);
    const script = await obtainClientScript(client);
    executeScript(client, script.code);
    if (script.stale) {
      setStatus(`${client.name} is running from an older verified cache. ${script.warning}`, "warning");
    } else {
      setStatus(`${client.name} v${client.version} active from ${script.source}.`);
    }
  }

  start().catch(async error => {
    await waitForBody();
    if (!registry) registry = { schemaVersion: 1, clients: [] };
    busy = false;
    setStatus(error && error.message ? error.message : String(error), "error");
    console.error("eCW SmartCoder Loader:", error);
  });
})();
