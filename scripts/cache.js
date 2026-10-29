/**
 * Local cache: Drive files are copied into Foundry's own storage before use,
 * so every client loads them from the Foundry server (no CORS or Google quota issues).
 */
import { FilePickerClass } from "./compat.js";
import { conversionOptions, getSetting, setSetting } from "./settings.js";
import { maybeConvert } from "./convert.js";
import * as drive from "./drive.js";

const createdDirs = new Set();
const inFlight = new Map();
let saveTimer = null;
let pendingMap = null;

export function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, "_").replace(/\s+/g, " ").trim() || "file";
}

export function cacheRoot() {
  return String(getSetting("cacheFolder") || "gdrive-media").replace(/^\/+|\/+$/g, "");
}

function source() {
  return getSetting("storageSource") || "data";
}

export async function ensureDir(path) {
  const FP = FilePickerClass();
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (createdDirs.has(current)) continue;
    try {
      await FP.createDirectory(source(), current, {});
    } catch (err) {
      // The directory already exists, which is what we want.
    }
    createdDirs.add(current);
  }
}

/** Upload a blob into Foundry storage and return the stored path. */
export async function storeBlob(blob, dir, name) {
  const FP = FilePickerClass();
  await ensureDir(dir);
  const file = new File([blob], sanitize(name), { type: blob.type });
  const response = await FP.upload(source(), dir, file, {}, { notify: false });
  if (!response || response.status === "error") throw new Error(response?.message ?? `Upload failed: ${name}`);
  return response.path ?? `${dir}/${file.name}`;
}

async function exists(path) {
  const candidates = new Set([encodeURI(path), path]);
  for (const url of candidates) {
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (response.ok) return true;
    } catch (err) { /* try the next form */ }
  }
  return false;
}

function cacheMap() {
  return pendingMap ?? getSetting("cacheMap") ?? {};
}

function remember(id, record) {
  pendingMap = { ...cacheMap(), [id]: record };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const map = pendingMap;
    pendingMap = null;
    if (game.user.isGM) await setSetting("cacheMap", map);
  }, 1000);
}

export function cachedPath(entry) {
  const record = cacheMap()[entry.id];
  return record && record.modifiedTime === entry.modifiedTime ? record.path : null;
}

/** Make sure a Drive file is available locally and return its Foundry path. */
export function ensureLocal(entry) {
  if (inFlight.has(entry.id)) return inFlight.get(entry.id);
  const promise = (async () => {
    const known = cachedPath(entry);
    if (known && await exists(known)) return known;
    const blob = await drive.download(entry.id);
    let typed = blob.type ? blob : new Blob([blob], { type: entry.mimeType });
    let name = entry.name;
    if (getSetting("convertOnImport")) {
      const result = await maybeConvert(typed, name, conversionOptions(true));
      typed = result.blob;
      name = result.name;
    }
    const dir = [cacheRoot(), ...String(entry.path ?? "").split("/").filter(Boolean).map(sanitize)].join("/");
    const path = await storeBlob(typed, dir, name);
    remember(entry.id, { path, modifiedTime: entry.modifiedTime });
    return path;
  })();
  inFlight.set(entry.id, promise);
  promise.finally(() => inFlight.delete(entry.id));
  return promise;
}

export { exists as localFileExists };
