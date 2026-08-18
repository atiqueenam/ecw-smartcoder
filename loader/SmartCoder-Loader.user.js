// ==UserScript==
// @name         eCW SmartCoder by ATQ
// @namespace    https://github.com/atiqueenam/ecw-smartcoder
// @version      1.2.7
// @description  Selects, caches, verifies, and runs the configured SmartCoder client.
// @match        https://*.com/mobiledoc/jsp/webemr/*
// @match        *://*.eclinicalworks.com/*
// @match        *://*.ecwcloud.com/*
// @match        *://*.eclinicalweb.com/*
// @updateURL    https://raw.githubusercontent.com/atiqueenam/ecw-smartcoder/main/loader/SmartCoder-Loader.user.js
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  console.info("eCW SmartCoder Loader v1.2.7: userscript started.");

  const REPOSITORY_RAW = "https://raw.githubusercontent.com/atiqueenam/ecw-smartcoder/dev/";
  const REGISTRY_URL = `${REPOSITORY_RAW}registry/clients.json`;
  const STORAGE = {
    userId: "ecw_smartcoder_user_id",
    selectedClient: "ecw_smartcoder_selected_client",
    registry: "ecw_smartcoder_registry",
    scriptPrefix: "ecw_smartcoder_script_"
  };
  const SESSION_FORCE_REFRESH = "ecw_smartcoder_force_refresh";
  const HEADER_STYLE_ID = "ecwSmartCoderLoaderHeaderStyle";
  const CLIENT_PICKER_ID = "ecwSmartCoderClientPicker";
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

  function visiblePasswordFieldExists() {
    return Array.from(document.querySelectorAll('input[type="password"]')).some(input => {
      const style = getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      return !input.disabled &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;
    });
  }

  function authenticatedAppIsReady() {
    if (document.readyState === "loading" || !document.body) return false;
    if (visiblePasswordFieldExists()) return false;
    return true;
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

  // Minimal flat style — no blur/glass, small footprint so most of the
  // header stays free for dragging the panel.
  function ensureHeaderStyle() {
    const existing = document.getElementById(HEADER_STYLE_ID);
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.id = HEADER_STYLE_ID;
    style.textContent = `
      #${CLIENT_PICKER_ID}, #${CLIENT_PICKER_ID} * { box-sizing:border-box; }
      #${CLIENT_PICKER_ID} { position:relative; width:88px; height:20px; flex:0 0 88px; }

      #ecwSmartCoderClientButton {
        width:88px; height:20px; margin:0; padding:0 6px;
        display:flex; align-items:center; justify-content:space-between; gap:4px;
        border:1px solid rgba(255,255,255,.45); border-radius:5px;
        outline:none; cursor:pointer;
        background:rgba(255,255,255,.16);
        color:#fff;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
        font-size:10.5px; font-weight:600; line-height:14px;
        transition:background .12s ease, border-color .12s ease;
      }
      #ecwSmartCoderClientButton:hover, #ecwSmartCoderClientButton:focus-visible {
        border-color:rgba(255,255,255,.7);
        background:rgba(255,255,255,.26);
      }
      #ecwSmartCoderClientButton .ecw-sc-label {
        min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
      }
      #ecwSmartCoderClientButton .ecw-sc-chevron {
        width:9px; height:9px; flex:0 0 9px; fill:none; stroke:currentColor;
        stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; opacity:.85;
        transition:transform .14s ease;
      }
      #${CLIENT_PICKER_ID}.open .ecw-sc-chevron { transform:rotate(180deg); }

      #ecwSmartCoderClientMenu {
        position:absolute; top:23px; left:0; z-index:2147483647;
        width:132px; padding:3px; overflow:hidden;
        border:1px solid #dbe5e9; border-radius:7px; background:#fff;
        box-shadow:0 8px 20px rgba(15,23,42,.20), 0 2px 5px rgba(15,23,42,.08);
      }
      #ecwSmartCoderClientMenu[hidden] { display:none !important; }
      #ecwSmartCoderClientMenu button {
        width:100%; height:24px; margin:0 0 1px; padding:0 7px;
        display:flex; align-items:center; gap:5px;
        border:0; border-radius:4px; background:transparent; color:#1e293b;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
        font-size:11px; font-weight:600; line-height:14px; text-align:left; cursor:pointer;
      }
      #ecwSmartCoderClientMenu button:last-child { margin-bottom:0; }
      #ecwSmartCoderClientMenu button:hover, #ecwSmartCoderClientMenu button:focus-visible {
        outline:none; background:#f0fdfa; color:#0f766e;
      }
      #ecwSmartCoderClientMenu button.selected { background:#0f766e; color:#fff; }
      #ecwSmartCoderClientMenu .ecw-sc-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #ecwSmartCoderClientMenu .ecw-sc-check {
        width:11px; height:11px; flex:0 0 11px; fill:none; stroke:currentColor;
        stroke-width:2.6; stroke-linecap:round; stroke-linejoin:round;
        visibility:hidden;
      }
      #ecwSmartCoderClientMenu button.selected .ecw-sc-check { visibility:visible; }

      #${RELOAD_BUTTON_ID} {
        width:20px !important; height:20px !important; padding:0 !important;
        display:inline-flex !important; align-items:center !important; justify-content:center !important;
        border:1px solid rgba(255,255,255,.45) !important; border-radius:50% !important;
        background:rgba(255,255,255,.16) !important; color:#fff !important; cursor:pointer !important;
        transition:background .12s ease, border-color .12s ease !important;
      }
      #${RELOAD_BUTTON_ID}:hover {
        border-color:rgba(255,255,255,.7) !important;
        background:rgba(255,255,255,.26) !important;
      }
      #${RELOAD_BUTTON_ID} svg {
        width:13px; height:13px; display:block; fill:none; stroke:currentColor;
        stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round;
        shape-rendering:geometricPrecision;
      }
      #${RELOAD_BUTTON_ID}.loading svg { animation:ecwLoaderSpin .7s linear infinite; }
      @keyframes ecwLoaderSpin { to { transform:rotate(360deg); } }

      /* Bigger, easier target for the close/minimize (×) button now that
         it sits right next to the reload button — reduces mis-clicks. */
      #ecsClose {
        width:24px !important; height:24px !important;
        font-size:16px !important; line-height:24px !important;
        display:inline-flex !important; align-items:center !important; justify-content:center !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function installHeaderControls() {
    const header = document.getElementById("ecsHeader");
    if (!header || !registry) return false;
    if (document.getElementById(CLIENT_PICKER_ID)) return true;

    const title = Array.from(header.children).find(element =>
      element.tagName === "SPAN" && element.id !== "ecsHeaderBtns"
    );
    const minimize = document.getElementById("ecsMinimize");
    if (!title || !minimize) return false;

    ensureHeaderStyle();
    const selected = selectedClientId();
    const selectedClient = registry.clients.find(client => client.id === selected) || registry.clients[0];

    const picker = document.createElement("div");
    picker.id = CLIENT_PICKER_ID;

    const trigger = document.createElement("button");
    trigger.id = "ecwSmartCoderClientButton";
    trigger.type = "button";
    trigger.title = "Select SmartCoder client";
    trigger.setAttribute("aria-label", "SmartCoder client");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = `<span class="ecw-sc-label"></span><svg class="ecw-sc-chevron" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"></path></svg>`;
    trigger.querySelector(".ecw-sc-label").textContent = selectedClient ? selectedClient.name : "Select";

    const menu = document.createElement("div");
    menu.id = "ecwSmartCoderClientMenu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    for (const client of registry.clients) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.clientId = client.id;
      option.setAttribute("role", "menuitem");
      if (client.id === selected) option.classList.add("selected");
      option.innerHTML = `
        <svg class="ecw-sc-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg>
        <span class="ecw-sc-name"></span>
      `;
      option.querySelector(".ecw-sc-name").textContent = client.name;
      option.addEventListener("mousedown", event => event.stopPropagation());
      // Selecting a client reloads the page immediately, so there's no
      // separate "reload" control needed anywhere in this header.
      option.addEventListener("click", event => {
        event.stopPropagation();
        writeStorage(STORAGE.selectedClient, client.id);
        markForcedRefresh();
        location.reload();
      });
      menu.appendChild(option);
    }
    trigger.addEventListener("mousedown", event => event.stopPropagation());
    trigger.addEventListener("click", event => {
      event.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      picker.classList.toggle("open", open);
      trigger.setAttribute("aria-expanded", String(open));
    });
    picker.addEventListener("mousedown", event => event.stopPropagation());
    picker.append(trigger, menu);
    title.replaceWith(picker);
    document.addEventListener("click", event => {
      if (picker.contains(event.target)) return;
      menu.hidden = true;
      picker.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      menu.hidden = true;
      picker.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    });

    const reload = document.createElement("span");
    reload.id = RELOAD_BUTTON_ID;
    reload.title = "Check updates and reload";
    reload.setAttribute("role", "button");
    reload.setAttribute("aria-label", "Check SmartCoder updates and reload");
    // Two-arrow "sync" icon (top arrow one way, bottom arrow the other),
    // rather than the single-arrow refresh loop this used before.
    reload.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';
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
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(installHeaderControls, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", installHeaderControls);
  }

  async function start() {
    await waitForAuthenticatedApp();
    console.info("eCW SmartCoder Loader: authenticated page ready.");
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
    console.info(`eCW SmartCoder Loader: registry ready with ${registry.clients.length} clients.`);

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
    console.info(`eCW SmartCoder Loader: selected ${client.name} for ${location.hostname}.`);

    const script = await obtainClientScript(client);
    console.info(`eCW SmartCoder Loader: ${client.name} script verified.`);
    executeScript(client, script.code);
    console.info(`eCW SmartCoder Loader: ${client.name} script executed.`);
    maintainHeaderControls();
    console.info(`eCW SmartCoder Loader: ${client.name} v${client.version} active${script.stale ? " from older cache" : ""}.`);
  }

  start().catch(error => console.error("eCW SmartCoder Loader:", error));
})();