import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const clientsDirectory = path.join(root, "clients");
const registryDirectory = path.join(root, "registry");
const registryFile = path.join(registryDirectory, "clients.json");

const directoryEntries = await readdir(clientsDirectory, { withFileTypes: true });
const clients = [];
const seenIds = new Set();
const seenSiteIds = new Set();
const seenHostnames = new Set();

for (const directoryEntry of directoryEntries) {
  if (!directoryEntry.isDirectory()) continue;

  const directoryName = directoryEntry.name;
  const clientDirectory = path.join(clientsDirectory, directoryName);
  const configFile = path.join(clientDirectory, "client.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));

  if (!config.enabled) continue;
  if (!/^[a-z0-9-]+$/.test(config.id || "")) {
    throw new Error(`${directoryName}: id must contain lowercase letters, numbers, or hyphens only.`);
  }
  if (config.id !== directoryName) {
    throw new Error(`${directoryName}: folder name must match client id "${config.id}".`);
  }
  if (seenIds.has(config.id)) throw new Error(`Duplicate client id: ${config.id}`);
  seenIds.add(config.id);
  if (typeof config.name !== "string" || !config.name.trim()) {
    throw new Error(`${config.id}: name is required.`);
  }
  if (!/^[a-z0-9-]+$/.test(config.siteId || "")) {
    throw new Error(`${config.id}: siteId must contain lowercase letters, numbers, or hyphens only.`);
  }
  if (seenSiteIds.has(config.siteId)) throw new Error(`Duplicate siteId: ${config.siteId}`);
  seenSiteIds.add(config.siteId);
  if (!Array.isArray(config.hostnames) || !config.hostnames.length) {
    throw new Error(`${config.id}: at least one hostname is required.`);
  }
  const hostnames = config.hostnames.map(hostname => String(hostname).trim().toLowerCase());
  for (const hostname of hostnames) {
    if (!/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes(".")) {
      throw new Error(`${config.id}: invalid hostname "${hostname}".`);
    }
    if (seenHostnames.has(hostname)) throw new Error(`Duplicate hostname: ${hostname}`);
    seenHostnames.add(hostname);
  }
  if (typeof config.version !== "string" || !config.version.trim()) {
    throw new Error(`${config.id}: version must be a non-empty string.`);
  }
  if (typeof config.entry !== "string" || !/^[a-zA-Z0-9._-]+\.js$/.test(config.entry)) {
    throw new Error(`${config.id}: entry must be a JavaScript filename in the client folder.`);
  }

  const scriptFile = path.join(clientDirectory, config.entry);
  const originalSource = await readFile(scriptFile, "utf8");
  const version = config.version.trim();

  // Single source of truth: client.json's "version" field. Every place the
  // version is duplicated inside the client script (the userscript
  // "@version" tag, a trailing "vX.Y" in the "@name" tag if present, and the
  // "SCRIPT_VERSION" constant that drives the on-screen footer badge) is
  // rewritten here to match, so nobody has to remember to bump three spots
  // by hand for every release, for every client.
  const syncedSource = originalSource
    .replace(/(^\/\/ @version\s+).*/m, `$1${version}`)
    .replace(/(^\/\/ @name\s+.*?\s+v)[0-9][^\s]*/m, `$1${version}`)
    .replace(/(const SCRIPT_VERSION\s*=\s*['"]).*?(['"])/, `$1${version}$2`);

  if (syncedSource !== originalSource) {
    await writeFile(scriptFile, syncedSource, "utf8");
    console.log(`${config.id}: synced script version to ${version}.`);
  }

  const scriptBytes = Buffer.from(syncedSource, "utf8");
  // Compile as a function to catch JavaScript syntax errors before publishing.
  new Function(syncedSource);
  const sha256 = createHash("sha256").update(scriptBytes).digest("hex");

  clients.push({
    id: config.id,
    name: config.name.trim(),
    siteId: config.siteId,
    hostnames,
    version: config.version.trim(),
    file: `clients/${config.id}/${config.entry}`,
    sha256
  });
}

clients.sort((a, b) => a.name.localeCompare(b.name));
if (!clients.length) throw new Error("No enabled clients were found.");

const registry = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  clients
};

await mkdir(registryDirectory, { recursive: true });
await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
console.log(`Created registry/clients.json with ${clients.length} clients.`);