/**
 * Uploading to Drive with automatic sorting and format conversion.
 *
 * Layout on Drive (folder names are fixed so every world finds the same structure):
 *   Maps/<Author>/<Map or pack>/      maps, their scene JSON and the assets the scene uses
 *   Tokens/<Author>/                  Tiles/<Author>/
 *   Music/<Author>/  Ambience/<Author>/  SFX/<Author>/
 *   Other/
 */
import { MODULE_ID, DialogV2, esc, localize, mapLimit, notify, notifyProgress } from "./compat.js";
import { conversionOptions, getSetting, setSetting, uploadConcurrency } from "./settings.js";
import * as drive from "./drive.js";
import { sanitize } from "./cache.js";
import { conversionTarget, convertedName, maybeConvert } from "./convert.js";
import { basename, classify, extension, mediaIndex } from "./media-index.js";

export const CATEGORIES = {
  maps: "Maps",
  tokens: "Tokens",
  tiles: "Tiles",
  music: "Music",
  ambience: "Ambience",
  sfx: "SFX",
  other: "Other"
};

const UNKNOWN_AUTHOR = "Unknown";
const MEDIA_RE = /\.(png|jpe?g|webp|gif|svg|avif|bmp|tiff?|webm|mp4|m4v|ogv|mov|mp3|ogg|oga|opus|wav|flac|m4a|aac)(\?.*)?$/i;

/* -------------------------------------------- */
/*  Guessing                                    */
/* -------------------------------------------- */

/** Guess the category from the file type, its path hints and (for images) its size. */
export async function guessCategory(blob, name, hint = "") {
  const kind = classify({ name, mimeType: blob.type });
  const text = `${hint}/${name}`.toLowerCase();
  if (kind === "scene") return "maps";
  if (kind === "audio") {
    if (/ambien|атмосф|окруж/.test(text)) return "ambience";
    if (/sfx|effect|эффект|door|двер/.test(text)) return "sfx";
    return "music";
  }
  if (kind === "image" || kind === "video") {
    if (/token|токен/.test(text)) return "tokens";
    if (/tile|asset|prop|тайл|ассет/.test(text)) return "tiles";
    if (/map|карт|battle|scene|сцен/.test(text)) return "maps";
    if (kind === "video") return "maps";
    try {
      const bmp = await createImageBitmap(blob);
      const { width, height } = bmp;
      bmp.close?.();
      if (Math.min(width, height) >= 1000) return "maps";
      if (Math.max(width, height) <= 600 && Math.abs(width - height) <= 0.1 * width) return "tokens";
      return "tiles";
    } catch (err) {
      return "maps";
    }
  }
  return "other";
}

/** "Tom Cartos - Tavern.jpg" or "[Tom Cartos] Tavern.jpg" → "Tom Cartos". */
export function guessAuthor(name) {
  const stem = basename(name);
  const bracket = stem.match(/^\s*[[(]([^\])]{2,40})[\])]/);
  if (bracket) return bracket[1].trim();
  const dash = stem.match(/^(.{2,40}?)\s+[-–—]\s+.+$/);
  if (dash) return dash[1].trim();
  return "";
}

// Words that mark a variant of the same map ("Tavern Night Gridless" belongs with "Tavern").
const VARIANT_WORDS = "day|night|dawn|dusk|evening|morning|grid|gridded|gridless|no ?grid|nogrid|hd|4k|8k|uhd|original|alt|alternate|variant|ver|v|copy|final|light|dark|lit|unlit|день|ночь|сетка|без сетки";
const VARIANT_TAIL = new RegExp(`[\\s\\-.,]+(?:\\(\\d+\\)|\\[\\d+\\]|(?:${VARIANT_WORDS})\\s*\\d*|\\d+(?:x\\d+)?)$`, "i");
const NUMBER_HEAD = /^\s*(?:\d+[\s_.\-)]+|#\d+\s*|[[(][^\])]{2,40}[\])]\s*)/;

/**
 * Folder name for a map: the file name without its numbering and variant markers, so
 * "001 Ground Floor", "002 Ground Floor" and "Ground Floor Night" all land in "Ground Floor".
 */
export function mapGroupName(name) {
  let stem = ` ${basename(name).replace(/_/g, " ").trim()}`; // leading space lets the tail rule see the first word
  for (let i = 0; i < 6; i++) {
    const next = stem.replace(NUMBER_HEAD, "").replace(VARIANT_TAIL, "").trim();
    if (!next || next === stem) break;
    stem = next;
  }
  stem = stem.replace(/\s{2,}/g, " ").replace(/[\s\-.,]+$/, "").trim();
  return stem || basename(name);
}

/** Folder segments for a file. */
export function destination(category, author, pack, name) {
  const who = sanitize(author || UNKNOWN_AUTHOR);
  const sub = pack ? sanitize(pack) : "";
  const root = CATEGORIES[category] ?? CATEGORIES.other;
  if (category === "maps") return [root, who, sub || sanitize(mapGroupName(name))];
  if (category === "other") return sub ? [root, sub] : [root];
  return sub ? [root, who, sub] : [root, who];
}

/* -------------------------------------------- */
/*  Upload session                              */
/* -------------------------------------------- */

/** Lets at most `limit` tasks run at once (used to keep heavy conversions from piling up). */
function semaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const FLUSH_EVERY = 200;

/**
 * Collects uploads, creates folders on demand and updates the index in batches.
 * Each Drive folder is listed once, so uploads need no per-file lookup, and with
 * `skipExisting` files already on Drive are skipped (an interrupted upload simply resumes).
 */
export class UploadSession {
  #folders = new Map([["", Promise.resolve(drive.rootFolderId())]]);
  #listings = new Map(); // folder id -> Promise<Map(lower name -> file)>
  #pending = [];
  #flushing = Promise.resolve();
  #usedNames = new Map(); // folder path -> Map(lower name -> source key)
  #convertSlot = semaphore(2);
  #uploadSlot = semaphore(uploadConcurrency()); // shared by everything this session sends
  /** Lower-case original name -> new name, for files renamed by conversion. */
  renamed = new Map();
  uploaded = 0;
  skipped = 0;
  failedConversions = [];
  /** Source keys (usually local paths) already uploaded in this session. */
  sources = new Set();

  constructor({ convert = true, skipExisting = false } = {}) {
    this.options = conversionOptions(convert);
    this.skipExisting = skipExisting;
  }

  /** Drive folder for a list of segments, created if missing. Safe to call in parallel. */
  async folder(segments) {
    let path = "";
    let parentId = await this.#folders.get("");
    for (const seg of segments.filter(Boolean)) {
      const next = path ? `${path}/${seg}` : seg;
      if (!this.#folders.has(next)) {
        const known = mediaIndex.folderIds?.get(next);
        const parent = parentId;
        const parentPath = path;
        this.#folders.set(next, known ? Promise.resolve(known) : (async () => {
          const children = await this.#listing(parent);
          let folder = children.get(seg.toLowerCase());
          if (folder?.mimeType !== drive.FOLDER_MIME) {
            folder = await drive.createFolder(seg, parent);
            children.set(seg.toLowerCase(), folder);
            this.#listings.set(folder.id, Promise.resolve(new Map())); // new and empty
          }
          if (!mediaIndex.folderIds?.has(next)) this.#pending.push({ file: folder, path: parentPath, folderId: parent });
          return folder.id;
        })());
      }
      try {
        parentId = await this.#folders.get(next);
      } catch (err) {
        this.#folders.delete(next); // let a later file try again
        throw err;
      }
      path = next;
    }
    return { id: parentId, path };
  }

  /** Children of a Drive folder by lower-case name, listed once per session. */
  #listing(folderId) {
    if (!this.#listings.has(folderId)) {
      const promise = drive.listFolder(folderId).then(files => {
        const map = new Map();
        for (const f of files) {
          const key = f.name.toLowerCase();
          if (!map.has(key) || f.mimeType === drive.FOLDER_MIME) map.set(key, f);
        }
        return map;
      });
      promise.catch(() => this.#listings.delete(folderId));
      this.#listings.set(folderId, promise);
    }
    return this.#listings.get(folderId);
  }

  #uniqueName(folderPath, name, sourceKey) {
    if (!this.#usedNames.has(folderPath)) this.#usedNames.set(folderPath, new Map());
    const used = this.#usedNames.get(folderPath);
    let candidate = name;
    let n = 1;
    while (used.has(candidate.toLowerCase()) && used.get(candidate.toLowerCase()) !== sourceKey) {
      candidate = `${basename(name)}-${n++}.${extension(name)}`;
    }
    used.set(candidate.toLowerCase(), sourceKey);
    return candidate;
  }

  /** A file of the same name already on Drive (skip mode), checked before any conversion. */
  async #alreadyThere(name, id, path, convert, sourceKey) {
    if (!this.skipExisting) return null;
    const used = this.#usedNames.get(path);
    const children = await this.#listing(id);
    const target = convert ? conversionTarget(name, this.options) : null;
    const candidates = target ? [convertedName(name, target), name] : [name];
    for (const candidate of candidates) {
      const owner = used?.get(candidate.toLowerCase());
      if (owner !== undefined && owner !== sourceKey) continue; // another file of this upload took the name
      const file = children.get(candidate.toLowerCase());
      if (file && file.mimeType !== drive.FOLDER_MIME) return file;
    }
    return null;
  }

  /**
   * Convert (if enabled) and upload one file.
   * @returns {Promise<{file: object, name: string, path: string, skipped?: boolean}>}
   */
  async put(blob, name, segments, { sourceKey = name, convert = true } = {}) {
    const clean = sanitize(name);
    const { id, path } = await this.folder(segments);
    const existing = await this.#alreadyThere(clean, id, path, convert, sourceKey);
    if (existing) {
      if (existing.name.toLowerCase() !== clean.toLowerCase()) this.renamed.set(String(name).toLowerCase(), existing.name);
      if (!this.#usedNames.has(path)) this.#usedNames.set(path, new Map());
      this.#usedNames.get(path).set(existing.name.toLowerCase(), sourceKey);
      if (!mediaIndex.get(existing.id)) this.#queue({ file: existing, path, folderId: id });
      this.skipped++;
      this.sources.add(sourceKey);
      return { file: existing, name: existing.name, path, skipped: true };
    }

    let out = { blob, name: clean };
    if (convert && conversionTarget(clean, this.options)) {
      const result = await this.#convertSlot(() => maybeConvert(blob, clean, this.options));
      if (result.error) this.failedConversions.push(name);
      out = { blob: result.blob, name: result.name };
    }
    const finalName = this.#uniqueName(path, out.name, sourceKey);
    // Only conversions rename references; a "-1" suffix means a different file with the same name.
    if (out.name !== clean) this.renamed.set(String(name).toLowerCase(), finalName);
    const children = await this.#listing(id);
    const same = children.get(finalName.toLowerCase());
    const file = await this.#uploadSlot(() => drive.uploadFile(out.blob, finalName, id, { existing: same && same.mimeType !== drive.FOLDER_MIME ? same : null }));
    children.set(finalName.toLowerCase(), file);
    this.#queue({ file: { ...file, modifiedTime: file.modifiedTime ?? new Date().toISOString() }, path, folderId: id });
    this.uploaded++;
    this.sources.add(sourceKey);
    return { file, name: finalName, path };
  }

  /** Add to the index; saved every few hundred files so a long upload is not lost if it stops. */
  #queue(item) {
    this.#pending.push(item);
    if (this.#pending.length >= FLUSH_EVERY) this.flush();
  }

  flush() {
    this.#flushing = this.#flushing.then(async () => {
      const items = this.#pending;
      this.#pending = [];
      try {
        await mediaIndex.addMany(items);
      } catch (err) {
        console.warn("Akella Search | index save failed", err);
        this.#pending.unshift(...items);
      }
    });
    return this.#flushing;
  }

  /** Point media references inside a scene JSON at the renamed (converted) files. */
  rewriteJson(text) {
    if (!this.renamed.size) return text;
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return text;
    }
    const walk = v => {
      if (typeof v === "string") {
        if (!MEDIA_RE.test(v)) return v;
        const parts = v.split("/");
        const last = parts.pop();
        let decoded = last;
        try {
          decoded = decodeURIComponent(last);
        } catch (err) { /* keep as is */ }
        const renamed = this.renamed.get(decoded.toLowerCase());
        return renamed ? [...parts, renamed].join("/") : v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return JSON.stringify(walk(data), null, 2);
  }

  /** Progress text: "120/8000, skipped 300". */
  progressText(done, total) {
    return this.skipped ? `${done}/${total} · ${localize("Upload.SkippedCount", { count: this.skipped })}` : `${done}/${total}`;
  }

  async finish() {
    await this.flush();
    if (this.failedConversions.length) notify("warn", "Notify.ConversionFailed", { count: this.failedConversions.length });
  }
}

/* -------------------------------------------- */
/*  Upload dialog                               */
/* -------------------------------------------- */

export function knownAuthors() {
  const set = new Set();
  for (const root of Object.values(CATEGORIES)) for (const a of mediaIndex.childFolders(root)) set.add(a);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function authorDatalist(id) {
  return `<datalist id="${id}">${knownAuthors().map(a => `<option value="${esc(a)}">`).join("")}</datalist>`;
}

function categoryOptions(selected, withAuto) {
  const auto = withAuto ? `<option value="auto">${localize("Upload.Auto")}</option>` : "";
  return auto + Object.keys(CATEGORIES).map(k => `<option value="${k}" ${k === selected ? "selected" : ""}>${localize(`Category.${k}`)} (${CATEGORIES[k]})</option>`).join("");
}

/**
 * Ask where uploaded files go, then upload them.
 * @param {File[]} files
 * @param {string} currentFolder  The folder selected in the browser (used when sorting is off).
 */
export async function uploadWithDialog(files, currentFolder = "") {
  if (!files.length) return;
  if (!drive.isSignedIn()) return notify("warn", "Errors.SignInRequired");
  const autoSort = getSetting("autoSort");
  const fromFolders = files.some(f => f.gdmsPath?.includes("/"));
  // Loose files with a scene JSON form one pack; dropped folders are packed folder by folder.
  const scene = fromFolders ? null : files.find(f => classify({ name: f.name }) === "scene");
  const author = getSetting("lastAuthor") || guessAuthor(files[0].name);
  const convertDefault = getSetting("convertImages") || getSetting("convertAudio");
  const content = `<form class="gdms-dialog">
    <p>${localize("Upload.Files", { count: files.length })}: ${files.slice(0, 6).map(f => esc(f.name)).join(", ")}${files.length > 6 ? "…" : ""}</p>
    ${autoSort ? `
    <div class="form-group"><label>${localize("Upload.Category")}</label><select name="category">${categoryOptions("auto", true)}</select></div>
    <div class="form-group"><label>${localize("Upload.Author")}</label><input type="text" name="author" value="${esc(author)}" list="gdms-authors" placeholder="${UNKNOWN_AUTHOR}"></div>
    <div class="form-group"><label>${localize("Upload.Pack")}</label><input type="text" name="pack" value="${esc(scene ? basename(scene.name) : "")}" placeholder="${localize("Upload.PackPlaceholder")}"></div>
    <p class="hint">${localize(scene ? "Upload.PackHint" : "Upload.SortHint")}</p>
    ${authorDatalist("gdms-authors")}` : `<p class="hint">${localize("Upload.ToFolder", { folder: esc(currentFolder || "/") })}</p>`}
    <div class="form-group"><label><input type="checkbox" name="convert" ${convertDefault ? "checked" : ""}> ${localize("Upload.Convert")}</label></div>
    <div class="form-group"><label><input type="checkbox" name="skip" checked> ${localize("Upload.SkipExisting")}</label></div>
    ${files.length > 50 ? `<p class="hint">${localize("Upload.ManyHint", { concurrency: uploadConcurrency() })}</p>` : ""}
  </form>`;
  const choice = await DialogV2().wait({
    window: { title: localize("Upload.Title"), icon: "fa-solid fa-cloud-arrow-up" },
    content,
    buttons: [{
      action: "upload", label: localize("Upload.Button"), icon: "fa-solid fa-cloud-arrow-up", default: true,
      callback: (ev, button) => {
        const f = button.form.elements;
        return { category: f.category?.value ?? null, author: f.author?.value.trim() ?? "", pack: f.pack?.value.trim() ?? "", convert: f.convert.checked, skip: f.skip.checked };
      }
    }, { action: "cancel", label: localize("Cancel") }],
    rejectClose: false
  });
  if (!choice || choice === "cancel") return;
  if (choice.author) await setSetting("lastAuthor", choice.author);

  const session = new UploadSession({ convert: choice.convert, skipExisting: choice.skip });
  const currentSegments = currentFolder ? currentFolder.split("/") : [];
  // A scene JSON in the batch makes it a pack: everything goes into one map folder, the JSON last.
  const packName = choice.pack || (scene ? basename(scene.name) : "");
  const isScene = f => classify({ name: f.name }) === "scene";
  const media = files.filter(f => !isScene(f));
  const scenes = files.filter(isScene);
  const packDirs = new Set(scenes.map(f => relativeDir(f).join("/")));
  // Where a file goes. Files from a dropped folder keep their subfolders ("Czepeku/Tavern/x.webp").
  const segmentsFor = async file => {
    const rel = relativeDir(file);
    if (!autoSort) return [...currentSegments, ...rel];
    let category = choice.category === "auto" ? await guessCategory(file, file.name, rel.join("/")) : choice.category;
    const inPack = scene || (fromFolders && packDirs.has(rel.join("/")));
    if (inPack && (choice.category === "auto" || choice.category === "maps")) category = "maps";
    // The dropped folder itself is the collection; only its subfolders become map folders.
    const inner = rel.slice(1);
    const sub = category === "maps" ? inner.join(" - ") : rel.join(" - ");
    const pack = category === "maps" ? (packName || sub) : (choice.pack || sub);
    return destination(category, choice.author, pack, file.name);
  };
  let done = 0;
  const failed = [];
  const progress = notifyProgress(localize("Notify.Uploading", { count: files.length, folder: "" }));
  const one = async file => {
    try {
      const segments = await segmentsFor(file);
      const sourceKey = file.gdmsPath ?? file.name;
      if (isScene(file)) {
        const text = session.rewriteJson(await file.text());
        await session.put(new Blob([text], { type: "application/json" }), file.name, segments, { sourceKey, convert: false });
      } else {
        await session.put(file, file.name, segments, { sourceKey });
      }
    } catch (err) {
      if (err.code === "auth") throw err;
      console.error(`Upload of ${file.name} failed`, err);
      failed.push(file.name);
    }
    progress.update(session.progressText(++done, files.length));
  };
  try {
    await mapLimit(media, uploadConcurrency(), one);
    await mapLimit(scenes, 2, one);
    await session.finish();
    notify("info", "Notify.Uploaded", { count: session.uploaded });
    if (session.skipped) notify("info", "Upload.Skipped", { count: session.skipped });
    if (failed.length) notify("warn", "Upload.Failed", { count: failed.length, names: failed.slice(0, 10).join(", ") });
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
    await session.finish();
  } finally {
    progress.close();
  }
}

/** Subfolders of a file picked from a dropped folder, without the file name. */
function relativeDir(file) {
  const rel = file.gdmsPath ?? file.webkitRelativePath ?? "";
  return rel.split("/").slice(0, -1).filter(Boolean).map(sanitize);
}

/**
 * Files from a drop, including everything inside dropped folders.
 * Each file from a folder gets `gdmsPath` ("Folder/Sub/name.webp").
 */
export async function filesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some(e => e.isDirectory)) return [...dataTransfer.files];
  const out = [];
  const readAll = reader => new Promise((resolve, reject) => {
    const all = [];
    const step = () => reader.readEntries(batch => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      step();
    }, reject);
    step();
  });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      file.gdmsPath = `${prefix}${file.name}`;
      out.push(file);
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out.filter(f => !f.name.startsWith(".") && classify({ name: f.name }) !== "other");
}

/* -------------------------------------------- */
/*  Convert files already on Drive              */
/* -------------------------------------------- */

export async function convertExisting(folder = "") {
  if (!drive.isSignedIn()) return notify("warn", "Errors.SignInRequired");
  const options = conversionOptions(true);
  const targets = mediaIndex.subtree(folder).filter(e => conversionTarget(e.name, options));
  if (!targets.length) return notify("info", "ConvertDrive.Nothing");
  const choice = await DialogV2().wait({
    window: { title: localize("ConvertDrive.Title"), icon: "fa-solid fa-file-export" },
    content: `<form class="gdms-dialog"><p>${localize("ConvertDrive.Body", { count: targets.length, folder: esc(folder || "/") })}</p>
      <div class="form-group"><label><input type="checkbox" name="trash"> ${localize("ConvertDrive.Trash")}</label></div>
      <p class="hint">${localize("ConvertDrive.Hint")}</p></form>`,
    buttons: [{ action: "ok", label: localize("ConvertDrive.Button"), default: true, callback: (ev, b) => ({ trash: b.form.elements.trash.checked }) },
      { action: "cancel", label: localize("Cancel") }],
    rejectClose: false
  });
  if (!choice || choice === "cancel") return;
  const progress = notifyProgress(localize("ConvertDrive.Running"));
  const session = new UploadSession({ convert: true });
  const trashed = [];
  let done = 0;
  let failed = 0;
  try {
    await mapLimit(targets, 2, async entry => {
      const blob = await drive.download(entry.id);
      const typed = blob.type ? blob : new Blob([blob], { type: entry.mimeType });
      const result = await maybeConvert(typed, entry.name, options);
      if (!result.converted) {
        failed++;
        return;
      }
      await session.put(result.blob, result.name, entry.path ? entry.path.split("/") : [], { sourceKey: entry.id, convert: false });
      if (choice.trash) {
        await drive.trashFile(entry.id);
        trashed.push(entry.id);
      }
      progress.update(`${++done}/${targets.length}`);
    });
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
  } finally {
    await session.finish();
    if (trashed.length) await mediaIndex.remove(trashed);
    progress.close();
  }
  notify("info", "ConvertDrive.Done", { count: session.uploaded });
  if (failed) notify("warn", "Notify.ConversionFailed", { count: failed });
}

/* -------------------------------------------- */
/*  Merge over-split map folders                */
/* -------------------------------------------- */

/**
 * Merge sibling folders that hold variants of one map ("001 Ground Floor", "002 Ground Floor")
 * into one folder ("Ground Floor"). File names keep their numbers. Works on the folders directly
 * inside `folder`, or inside every author folder when `folder` is "Maps".
 */
export async function regroupFolders(folder = "") {
  if (!drive.isSignedIn()) return notify("warn", "Errors.SignInRequired");
  const parents = folder === CATEGORIES.maps || !folder
    ? mediaIndex.childFolders(CATEGORIES.maps).map(a => `${CATEGORIES.maps}/${a}`)
    : [folder];
  const plan = [];
  for (const parent of parents) {
    for (const name of mediaIndex.childFolders(parent)) {
      const group = sanitize(mapGroupName(name));
      if (group && group !== name) plan.push({ parent, from: `${parent}/${name}`, group });
    }
  }
  if (!plan.length) return notify("info", "Regroup.Nothing");
  const groups = new Set(plan.map(p => `${p.parent}/${p.group}`));
  const sample = [...groups].slice(0, 8).map(g => `<li>${esc(g)}</li>`).join("");
  const ok = await DialogV2().confirm({
    window: { title: localize("Regroup.Title"), icon: "fa-solid fa-object-group" },
    content: `<p>${localize("Regroup.Body", { folders: plan.length, groups: groups.size })}</p><ul>${sample}</ul>${groups.size > 8 ? "<p>…</p>" : ""}<p class="hint">${localize("Regroup.Hint")}</p>`,
    rejectClose: false
  });
  if (!ok) return;

  const session = new UploadSession({ convert: false });
  const progress = notifyProgress(localize("Regroup.Running"));
  const entries = mediaIndex.entries.map(({ kind, search, ...rest }) => rest);
  const byFolder = new Map();
  for (const e of entries) {
    if (!byFolder.has(e.path)) byFolder.set(e.path, []);
    byFolder.get(e.path).push(e);
  }
  const trashed = new Set();
  let moved = 0;
  let done = 0;
  try {
    // Create the target folders first, one by one, then move files in parallel.
    for (const p of plan) p.target = await session.folder(`${p.parent}/${p.group}`.split("/"));
    for (const p of plan) {
      const sourceId = mediaIndex.folderIds.get(p.from);
      if (!sourceId || sourceId === p.target.id) continue;
      const children = byFolder.get(p.from) ?? [];
      await mapLimit(children, uploadConcurrency(), async child => {
        await drive.moveFile(child.id, p.target.id, sourceId);
        moved++;
        const oldPath = child.mimeType === drive.FOLDER_MIME ? `${p.from}/${child.name}` : null;
        child.path = p.target.path;
        child.folderId = p.target.id;
        // Anything deeper keeps its place, only its path text changes.
        if (oldPath) {
          const newPath = `${p.target.path}/${child.name}`;
          for (const e of entries) {
            if (e.path === oldPath || e.path.startsWith(`${oldPath}/`)) e.path = newPath + e.path.slice(oldPath.length);
          }
        }
      });
      await drive.trashFile(sourceId);
      trashed.add(sourceId);
      progress.update(`${++done}/${plan.length}`);
    }
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
  } finally {
    await session.finish();
    // session.finish() may have added the new group folders; merge them with the moved entries.
    const known = new Set(entries.map(e => e.id));
    const added = mediaIndex.entries.filter(e => !known.has(e.id)).map(({ kind, search, ...rest }) => rest);
    mediaIndex.setEntries([...entries.filter(e => !trashed.has(e.id)), ...added]);
    await mediaIndex.save();
    Hooks.callAll(`${MODULE_ID}.indexChanged`);
    progress.close();
  }
  notify("info", "Regroup.Done", { folders: trashed.size, files: moved });
}
