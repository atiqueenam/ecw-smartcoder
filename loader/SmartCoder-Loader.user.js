// ==UserScript==
// @name         eCW SmartCoder Client Loader
// @namespace    https://github.com/atiqueenam/ecw-smartcoder
// @version      1.1.1
// @description  Selects, caches, verifies, and runs the configured SmartCoder client.
// @match        https://*.com/mobiledoc/jsp/webemr/*
// @match        *://*.eclinicalworks.com/*
// @match        *://*.ecwcloud.com/*
// @match        *://*.eclinicalweb.com/*
// @updateURL    https://raw.githubusercontent.com/atiqueenam/ecw-smartcoder/main/loader/SmartCoder-Loader.user.js
// @downloadURL  https://raw.githubusercontent.com/atiqueenam/ecw-smartcoder/main/loader/SmartCoder-Loader.user.js
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
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
  const HEADER_STYLE_ID = "ecwSmartCoderLoaderHeaderStyle";
  const CLIENT_SELECT_ID = "ecwSmartCoderClientSelect";
  const RELOAD_BUTTON_ID = "ecsHotReload";

  let registry = null;

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
    const cryptoObject = window.crypto || unsafeWindow.crypto;
    const id = cryptoObject && typeof cryptoObject.randomUUID === "function"
      ? cryptoObject.randomUUID()
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

  function markForcedRefresh() {
    try { sessionStorage.setItem(SESSION_FORCE_REFRESH, "1"); } catch (_) {}
  }

  // Wait for the authenticated eCW shell. The loader does not download or
  // execute SmartCoder while a password/login form is displayed, preserving
  // normal Google Password Manager autofill and save-password behavior.
  function authenticatedAppIsReady() {
    if (document.readyState === "loading" || !document.body) return false;
    if (document.querySelector('input[type="password"]')) return false;
    const hasAuthenticatedShellElement = Boolean(
      document.querySelector("#topPanelUl1, #userProId, #encDropDownItem")
    );
    const pathname = location.pathname.toLowerCase();
    const hash = decodeURIComponent(location.hash || "").toLowerCase();
    const isKnownClientHost = [
      "nyshpyapp.eclinicalweb.com",
      "nygwmcapp.eclinicalweb.com"
    ].includes(location.hostname.toLowerCase());
    const isWebEmrRoute = pathname.includes("/mobiledoc/jsp/webemr/") &&
      hash.includes("/mobiledoc/jsp/webemr/");
    return hasAuthenticatedShellElement || (isKnownClientHost && isWebEmrRoute);
  }

  function waitForAuthenticatedApp() {
    if (authenticatedAppIsReady()) return Promise.resolve();
    return new Promise(resolve => {
      const check = () => {
        if (!authenticatedAppIsReady()) return;
        clearInterval(timer);
        window.removeEventListener("hashchange", check);
        window.removeEventListener("popstate", check);
        resolve();
      };
      const timer = setInterval(check, 500);
      window.addEventListener("hashchange", check);
      window.addEventListener("popstate", check);
      document.addEventListener("DOMContentLoaded", check, { once: true });
    });
  }

  function downloadText(url) {
    const requestUrl = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: requestUrl,
        timeout: 20000,
        anonymous: true,
        headers: { Accept: "text/plain, application/json;q=0.9, */*;q=0.8" },
        onload(response) {
          if (response.status >= 200 && response.status < 300) resolve(response.responseText);
          else reject(new Error(`GitHub returned HTTP ${response.status}.`));
        },
        ontimeout() { reject(new Error("GitHub request timed out.")); },
        onerror() { reject(new Error("Could not connect to GitHub.")); }
      });
    });
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
      if (client.file !== `clients/${client.id}/smartcoder.js`) throw new Error(`${client.id} has an invalid script location.`);
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
    const value = validateRegistry(JSON.parse(await downloadText(REGISTRY_URL)));
    writeStorage(STORAGE.registry, JSON.stringify(value));
    return value;
  }

  async function sha256(text) {
    const cryptoObject = window.crypto || unsafeWindow.crypto;
    if (!cryptoObject || !cryptoObject.subtle) throw new Error("This browser cannot verify scripts securely.");
    const digest = await cryptoObject.subtle.digest("SHA-256", new TextEncoder().encode(text));
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
    if (await cachedScriptIsValid(cached, client.sha256)) return { code: cached.code, stale: false };

    try {
      const code = await downloadText(clientScriptUrl(client));
      const actualHash = await sha256(code);
      if (actualHash !== client.sha256.toLowerCase()) {
        throw new Error(`Security check failed for ${client.name} v${client.version}.`);
      }
      writeStorage(STORAGE.scriptPrefix + client.id, JSON.stringify({
        version: client.version,
        sha256: client.sha256.toLowerCase(),
        code
      }));
      return { code, stale: false };
    } catch (downloadError) {
      if (cached && await cachedScriptIsValid(cached, cached.sha256)) {
        console.warn("eCW SmartCoder Loader: using older verified cached script.", downloadError);
        return { code: cached.code, stale: true };
      }
      throw downloadError;
    }
  }

  function executeScript(client, code) {
    const sourceUrl = clientScriptUrl(client).replace(/\s/g, "%20");
    // Supplying unsafeWindow as the script's window keeps the original
    // client scripts connected to eCW page functions while downloads remain
    // in Tampermonkey's permission-controlled request context.
    const run = new Function("window", `${code}\n//# sourceURL=${sourceUrl}`);
    run.call(unsafeWindow, unsafeWindow);
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

  function ensureHeaderStyle() {
    if (document.getElementById(HEADER_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HEADER_STYLE_ID;
    style.textContent = `
      #${CLIENT_SELECT_ID} {
        box-sizing: border-box !important;
        width: 132px !important;
        height: 22px !important;
        min-height: 22px !important;
        margin: 0 !important;
        padding: 0 20px 0 7px !important;
        border: 1px solid rgba(255,255,255,.5) !important;
        border-radius: 6px !important;
        outline: none !important;
        background: rgba(255,255,255,.16) !important;
        color: #fff !important;
        font: 700 11px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif !important;
        cursor: pointer !important;
      }
      #${CLIENT_SELECT_ID}:hover, #${CLIENT_SELECT_ID}:focus {
        background: rgba(255,255,255,.25) !important;
        border-color: rgba(255,255,255,.8) !important;
      }
      #${CLIENT_SELECT_ID} option { background:#fff !important; color:#0f172a !important; }
      #${RELOAD_BUTTON_ID} svg { width:12px; height:12px; display:block; fill:none; stroke:currentColor; stroke-width:2.2; }
      #${RELOAD_BUTTON_ID}.loading svg { animation:ecwLoaderSpin .7s linear infinite; }
      @keyframes ecwLoaderSpin { to { transform:rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function installHeaderControls() {
    const header = document.getElementById("ecsHeader");
    if (!header || !registry) return false;
    if (document.getElementById(CLIENT_SELECT_ID)) return true;

    const title = Array.from(header.children).find(element =>
      element.tagName === "SPAN" && element.id !== "ecsHeaderBtns"
    );
    const minimize = document.getElementById("ecsMinimize");
    if (!title || !minimize) return false;

    ensureHeaderStyle();
    const selected = selectedClientId();
    const select = document.createElement("select");
    select.id = CLIENT_SELECT_ID;
    select.title = "Select SmartCoder client";
    select.setAttribute("aria-label", "SmartCoder client");
    for (const client of registry.clients) {
      const option = document.createElement("option");
      option.value = client.id;
      option.textContent = client.name;
      option.selected = client.id === selected;
      select.appendChild(option);
    }
    select.addEventListener("mousedown", event => event.stopPropagation());
    select.addEventListener("click", event => event.stopPropagation());
    select.addEventListener("change", event => {
      event.stopPropagation();
      writeStorage(STORAGE.selectedClient, event.target.value);
      markForcedRefresh();
      location.reload();
    });
    title.replaceWith(select);

    const reload = document.createElement("span");
    reload.id = RELOAD_BUTTON_ID;
    reload.title = "Check updates and reload";
    reload.setAttribute("role", "button");
    reload.setAttribute("aria-label", "Check SmartCoder updates and reload");
    reload.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0 2 5.3"></path><path d="M20 4v7h-7"></path></svg>';
    reload.addEventListener("mousedown", event => event.stopPropagation());
    reload.addEventListener("click", event => {
      event.stopPropagation();
      reload.classList.add("loading");
      markForcedRefresh();
      location.reload();
    });
    minimize.replaceWith(reload);
    return true;
  }

  function maintainHeaderControls() {
    installHeaderControls();
    const observer = new MutationObserver(() => installHeaderControls());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", installHeaderControls);
  }

  async function start() {
    await waitForAuthenticatedApp();
    createUserId();

    const localRegistry = cachedRegistry();
    const shouldRefresh = consumeForcedRefresh() || isBrowserReload() || !localRegistry;
    if (shouldRefresh) {
      try {
        registry = await downloadRegistry();
      } catch (error) {
        if (!localRegistry) throw error;
        registry = localRegistry;
        console.warn("eCW SmartCoder Loader: GitHub unavailable; using saved registry.", error);
      }
    } else {
      registry = localRegistry;
    }

    let selected = selectedClientId();
    const detectedClient = clientForCurrentHostname();
    if (!selected && detectedClient) {
      selected = detectedClient.id;
      writeStorage(STORAGE.selectedClient, selected);
    }
    if (!selected) throw new Error(`No SmartCoder client is configured for ${location.hostname}.`);

    const client = registry.clients.find(item => item.id === selected);
    if (!client) {
      writeStorage(STORAGE.selectedClient, "");
      throw new Error("The saved SmartCoder client is no longer available.");
    }

    const script = await obtainClientScript(client);
    executeScript(client, script.code);
    maintainHeaderControls();
    console.info(`eCW SmartCoder Loader: ${client.name} v${client.version} active${script.stale ? " from older cache" : ""}.`);
  }

  start().catch(error => console.error("eCW SmartCoder Loader:", error));
})();
