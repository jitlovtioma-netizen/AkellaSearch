/**
 * Search index of the Drive folder tree. It is built by the GM and saved as a JSON file in
 * Foundry storage, so it loads instantly and does not hit the Drive API on every search.
 */
import { MODULE_ID, notify } from "./compat.js";
import { getSetting, setSetting } from "./settings.js";
import * as drive from "./drive.js";
import { cacheRoot, storeBlob } from "./cache.js";

const EXT = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp", "tif", "tiff"],
  video: ["webm", "mp4", "m4v", "ogv", "mov"],
  audio: ["mp3", "ogg", "oga", "opus", "wav", "flac", "m4a", "aac"],
  scene: ["json", "dd2vtt", "uvtt", "df2vtt"]
};

export const KINDS = ["image", "video", "audio", "scene", "other"];

export function extension(name) {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export function basename(name) {
  return String(name).replace(/\.[^.]+$/, "");
}

export function classify(entry) {
  if (entry.mimeType === drive.FOLDER_MIME) return "folder";
  const ext = extension(entry.name);
  if (ext === "webm" && entry.mimeType?.startsWith("audio/")) return "audio";
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind;
  if (entry.mimeType?.startsWith("image/")) return "image";
  if (entry.mimeType?.startsWith("video/")) return "video";
  if (entry.mimeType?.startsWith("audio/")) return "audio";
  return "other";
}

class MediaIndex {
  entries = [];
  byId = new Map();
  folders = [];
  loaded = false;
  building = false;

  setEntries(entries) {
    this.entries = entries
      .filter(e => e.mimeType === drive.FOLDER_MIME || !e.mimeType?.startsWith("application/vnd.google-apps"))
      .map(e => ({ ...e, kind: classify(e), search: `${e.path}/${e.name}`.toLowerCase() }));
    this.byId = new Map(this.entries.map(e => [e.id, e]));
    this.folders = this.entries
      .filter(e => e.kind === "folder")
      .map(e => (e.path ? `${e.path}/${e.name}` : e.name))
      .sort((a, b) => a.localeCompare(b));
    this.folderIds = new Map([["", drive.rootFolderId()]]);
    for (const e of this.entries) if (e.kind === "folder") this.folderIds.set(e.path ? `${e.path}/${e.name}` : e.name, e.id);
    // Which folders contain scene data files, by basename. Used to mark maps that ship as full scene packs.
    this.scenesByFolder = new Map();
    this.imagesByFolder = new Map();
    for (const e of this.entries) {
      const target = e.kind === "scene" ? this.scenesByFolder : e.kind === "image" || e.kind === "video" ? this.imagesByFolder : null;
      if (!target) continue;
      if (!target.has(e.path)) target.set(e.path, new Map());
      const byName = target.get(e.path);
      const key = basename(e.name).toLowerCase();
      // Prefer webp/images over videos when both share a name.
      if (!byName.has(key) || (byName.get(key).kind === "video" && e.kind === "image")) byName.set(key, e);
    }
    this.loaded = true;
  }

  get(id) {
    return this.byId.get(id);
  }

  /** A scene data file sitting next to an image with the same name, if any. */
  packFor(entry) {
    if (entry.kind !== "image" && entry.kind !== "video") return null;
    return this.scenesByFolder?.get(entry.path)?.get(basename(entry.name).toLowerCase()) ?? null;
  }

  /** The map image of a scene data file: same name in the same folder, else the closest name there. */
  mapFor(scene) {
    if (scene?.kind !== "scene") return null;
    const images = this.imagesByFolder?.get(scene.path);
    if (!images?.size) return null;
    const key = basename(scene.name).toLowerCase();
    if (images.has(key)) return images.get(key);
    let best = null;
    let bestScore = 0;
    for (const [name, entry] of images) {
      let n = 0;
      while (n < name.length && n < key.length && name[n] === key[n]) n++;
      if (n > bestScore) {
        best = entry;
        bestScore = n;
      }
    }
    return bestScore >= 4 ? best : images.size === 1 ? images.values().next().value : null;
  }

  /** Files inside a folder path and all of its subfolders. */
  subtree(path) {
    if (!path) return this.entries.filter(e => e.kind !== "folder");
    return this.entries.filter(e => e.kind !== "folder" && (e.path === path || e.path.startsWith(`${path}/`)));
  }

  search({ query = "", kind = "all", folder = "" } = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries.filter(e => {
      if (e.kind === "folder") return false;
      if (kind === "ready") {
        if (e.kind !== "scene") return false;
      } else if (kind !== "all" && e.kind !== kind) return false;
      if (folder && e.path !== folder && !e.path.startsWith(`${folder}/`)) return false;
      return terms.every(t => e.search.includes(t));
    }).sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  }

  async load() {
    const path = getSetting("indexPath");
    if (!path) return false;
    try {
      const response = await fetch(`${encodeURI(path)}?t=${getSetting("indexBuiltAt")}`, { cache: "no-store" });
      if (!response.ok) return false;
      const data = await response.json();
      if (data.root !== drive.rootFolderId()) return false;
      this.setEntries(data.entries ?? []);
      Hooks.callAll(`${MODULE_ID}.indexChanged`);
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not load the index`, err);
      return false;
    }
  }

  async save() {
    if (!game.user.isGM) return;
    const root = drive.rootFolderId();
    const plain = this.entries.map(({ kind, search, ...rest }) => rest);
    const blob = new Blob([JSON.stringify({ root, builtAt: Date.now(), entries: plain })], { type: "application/json" });
    const path = await storeBlob(blob, cacheRoot(), "index.json");
    await setSetting("indexPath", path);
    await setSetting("indexBuiltAt", Date.now());
  }

  async rebuild(onProgress) {
    if (this.building) return;
    this.building = true;
    try {
      const root = drive.rootFolderId();
      if (!root) throw new Error(game.i18n.localize("GDMS.Errors.NoFolder"));
      const entries = await drive.crawl(root, onProgress);
      this.setEntries(entries);
      await this.save();
      notify("info", "Notify.IndexBuilt", { count: this.entries.filter(e => e.kind !== "folder").length });
      Hooks.callAll(`${MODULE_ID}.indexChanged`);
    } finally {
      this.building = false;
    }
  }

  /**
   * Add freshly uploaded files and folders without a full rebuild.
   * @param {{file: object, path: string, folderId: string}[]} items
   */
  async addMany(items) {
    if (!items.length) return;
    const plain = new Map(this.entries.map(({ kind, search, ...rest }) => [rest.id, rest]));
    for (const { file, path, folderId } of items) plain.set(file.id, { ...plain.get(file.id), ...file, path, folderId });
    this.setEntries([...plain.values()]);
    await this.save();
    Hooks.callAll(`${MODULE_ID}.indexChanged`);
  }

  addEntries(files, path, folderId) {
    return this.addMany(files.map(file => ({ file, path, folderId })));
  }

  async remove(ids) {
    const drop = new Set(ids);
    this.setEntries(this.entries.filter(e => !drop.has(e.id)).map(({ kind, search, ...rest }) => rest));
    await this.save();
    Hooks.callAll(`${MODULE_ID}.indexChanged`);
  }

  /** Names of the direct subfolders of a folder path (e.g. the authors under "Maps"). */
  childFolders(path) {
    const prefix = path ? `${path}/` : "";
    return this.folders.filter(f => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")).map(f => f.slice(prefix.length));
  }
}

export const mediaIndex = new MediaIndex();
