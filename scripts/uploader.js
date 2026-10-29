/**
 * Uploading to Drive with automatic sorting and format conversion.
 *
 * Layout on Drive (folder names are fixed so every world finds the same structure):
 *   Maps/<Author>/<Map or pack>/      maps, their scene JSON and the assets the scene uses
 *   Tokens/<Author>/                  Tiles/<Author>/
 *   Music/<Author>/  Ambience/<Author>/  SFX/<Author>/
 *   Other/
 */
import { DialogV2, esc, localize, mapLimit, notify, notifyProgress } from "./compat.js";
import { conversionOptions, getSetting, setSetting } from "./settings.js";
import * as drive from "./drive.js";
import { sanitize } from "./cache.js";
import { conversionTarget, maybeConvert } from "./convert.js";
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

/** Folder segments for a file. */
export function destination(category, author, pack, name) {
  const who = sanitize(author || UNKNOWN_AUTHOR);
  const sub = pack ? sanitize(pack) : "";
  const root = CATEGORIES[category] ?? CATEGORIES.other;
  if (category === "maps") return [root, who, sub || sanitize(basename(name))];
  if (category === "other") return sub ? [root, sub] : [root];
  return sub ? [root, who, sub] : [root, who];
}

/* -------------------------------------------- */
/*  Upload session                              */
/* -------------------------------------------- */

/**
 * Collects uploads, creates folders on demand and updates the index once at the end.
 */
export class UploadSession {
  #folders = new Map([["", drive.rootFolderId()]]);
  #pending = [];
  #usedNames = new Map(); // folder path -> Map(lower name -> source key)
  /** Lower-case original name -> new name, for files renamed by conversion. */
  renamed = new Map();
  uploaded = 0;
  failedConversions = [];
  /** Source keys (usually local paths) already uploaded in this session. */
  sources = new Set();

  constructor({ convert = true } = {}) {
    this.options = conversionOptions(convert);
  }

  /** Drive folder for a list of segments, created if missing. */
  async folder(segments) {
    let path = "";
    let parentId = this.#folders.get("");
    for (const seg of segments.filter(Boolean)) {
      const next = path ? `${path}/${seg}` : seg;
      let id = this.#folders.get(next) ?? mediaIndex.folderIds?.get(next);
      if (!id) {
        const folder = await drive.ensureFolder(seg, parentId);
        id = folder.id;
        if (!mediaIndex.folderIds?.has(next)) this.#pending.push({ file: folder, path, folderId: parentId });
      }
      this.#folders.set(next, id);
      path = next;
      parentId = id;
    }
    return { id: parentId, path };
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

  /**
   * Convert (if enabled) and upload one file.
   * @returns {Promise<{file: object, name: string, path: string}>}
   */
  async put(blob, name, segments, { sourceKey = name, convert = true } = {}) {
    let out = { blob, name: sanitize(name) };
    if (convert) {
      const result = await maybeConvert(blob, out.name, this.options);
      if (result.error) this.failedConversions.push(name);
      out = { blob: result.blob, name: result.name };
    }
    const { id, path } = await this.folder(segments);
    const finalName = this.#uniqueName(path, out.name, sourceKey);
    // Only conversions rename references; a "-1" suffix means a different file with the same name.
    if (out.name !== sanitize(name)) this.renamed.set(String(name).toLowerCase(), finalName);
    const file = await drive.uploadFile(out.blob, finalName, id);
    this.#pending.push({ file: { ...file, modifiedTime: file.modifiedTime ?? new Date().toISOString() }, path, folderId: id });
    this.uploaded++;
    this.sources.add(sourceKey);
    return { file, name: finalName, path };
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

  async finish() {
    const items = this.#pending;
    this.#pending = [];
    await mediaIndex.addMany(items);
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
  const scene = files.find(f => classify({ name: f.name }) === "scene");
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
  </form>`;
  const choice = await DialogV2().wait({
    window: { title: localize("Upload.Title"), icon: "fa-solid fa-cloud-arrow-up" },
    content,
    buttons: [{
      action: "upload", label: localize("Upload.Button"), icon: "fa-solid fa-cloud-arrow-up", default: true,
      callback: (ev, button) => {
        const f = button.form.elements;
        return { category: f.category?.value ?? null, author: f.author?.value.trim() ?? "", pack: f.pack?.value.trim() ?? "", convert: f.convert.checked };
      }
    }, { action: "cancel", label: localize("Cancel") }],
    rejectClose: false
  });
  if (!choice || choice === "cancel") return;
  if (choice.author) await setSetting("lastAuthor", choice.author);

  const session = new UploadSession({ convert: choice.convert });
  const currentSegments = currentFolder ? currentFolder.split("/") : [];
  // A scene JSON in the batch makes it a pack: everything goes into one map folder, the JSON last.
  const packName = choice.pack || (scene ? basename(scene.name) : "");
  const ordered = [...files].sort((a, b) => (classify({ name: a.name }) === "scene") - (classify({ name: b.name }) === "scene"));
  let done = 0;
  const progress = notifyProgress(localize("Notify.Uploading", { count: files.length, folder: "" }));
  try {
    const plan = await Promise.all(ordered.map(async file => {
      if (!autoSort) return { file, segments: currentSegments };
      let category = choice.category === "auto" ? await guessCategory(file, file.name) : choice.category;
      if (scene && (choice.category === "auto" || choice.category === "maps")) category = "maps";
      return { file, segments: destination(category, choice.author, category === "maps" ? packName : choice.pack, file.name) };
    }));
    const media = plan.filter(p => classify({ name: p.file.name }) !== "scene");
    const scenes = plan.filter(p => classify({ name: p.file.name }) === "scene");
    await mapLimit(media, 2, async p => {
      await session.put(p.file, p.file.name, p.segments);
      progress.update(`${++done}/${files.length}`);
    });
    for (const p of scenes) {
      const text = session.rewriteJson(await p.file.text());
      await session.put(new Blob([text], { type: "application/json" }), p.file.name, p.segments, { convert: false });
      progress.update(`${++done}/${files.length}`);
    }
    await session.finish();
    notify("info", "Notify.Uploaded", { count: session.uploaded });
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
    await session.finish();
  } finally {
    progress.close();
  }
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
