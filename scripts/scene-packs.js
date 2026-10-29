/**
 * Scene packs: a scene exported as JSON (walls, lights, sounds, tiles, notes, regions...)
 * stored in Drive next to the media it uses. Importing downloads every referenced file into
 * local storage, rewrites the paths and creates the scene in one go.
 *
 * Also supported: Universal VTT files (.dd2vtt / .uvtt from Dungeondraft, DungeonFog, etc.)
 * and plain images (a new scene with that image as background).
 */
import { MODULE_ID, DialogV2, esc, hasNativeLevels, loadTex, localize, mapLimit, notify } from "./compat.js";
import { getSetting } from "./settings.js";
import * as drive from "./drive.js";
import { cacheRoot, ensureLocal, localFileExists, sanitize, storeBlob } from "./cache.js";
import { basename, extension, mediaIndex } from "./media-index.js";
import { convertLegacyLevels, hasLegacyLevels } from "./levels-converter.js";

const MEDIA_RE = /\.(png|jpe?g|webp|gif|svg|avif|bmp|tiff?|webm|mp4|m4v|ogv|mov|mp3|ogg|oga|opus|wav|flac|m4a|aac)(\?.*)?$/i;
const CORE_PREFIXES = ["icons/", "ui/", "sounds/", "/icons/", "/ui/", "/sounds/"];
const EMBEDDED = ["walls", "tiles", "lights", "sounds", "notes", "drawings", "regions", "tokens", "templates"];
const FOLDER_NAME = "Google Drive";

/* -------------------------------------------- */
/*  Path helpers                                */
/* -------------------------------------------- */

function isExternal(path) {
  return /^(https?:|data:|blob:)/i.test(path);
}

function fileName(path) {
  const clean = String(path).split("?")[0].split("/").pop();
  try {
    return decodeURIComponent(clean);
  } catch (err) {
    return clean;
  }
}

/** Collect every string in a nested object that looks like a media path. */
function collectPaths(data, found = new Set()) {
  if (typeof data === "string") {
    if (MEDIA_RE.test(data) && !data.startsWith("data:")) found.add(data);
  } else if (Array.isArray(data)) {
    for (const v of data) collectPaths(v, found);
  } else if (data && typeof data === "object") {
    for (const v of Object.values(data)) collectPaths(v, found);
  }
  return found;
}

function replacePaths(data, map) {
  if (typeof data === "string") return map.has(data) ? map.get(data) : data;
  if (Array.isArray(data)) return data.map(v => replacePaths(v, map));
  if (data && typeof data === "object") {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = replacePaths(v, map);
    return out;
  }
  return data;
}

/**
 * Resolve the media referenced by a scene pack: keep paths that already exist on this server,
 * otherwise find a file with the same name in the pack folder (or anywhere in the Drive index)
 * and download it.
 */
async function localizeMedia(data, packPath, onProgress) {
  const paths = [...collectPaths(data)];
  const local = mediaIndex.subtree(packPath);
  const byName = new Map();
  for (const e of [...mediaIndex.subtree(""), ...local]) byName.set(e.name.toLowerCase(), e); // pack folder wins
  const map = new Map();
  const missing = [];
  let done = 0;
  await mapLimit(paths, 4, async path => {
    if (!isExternal(path) && await localFileExists(path)) {
      map.set(path, path);
    } else {
      const entry = byName.get(fileName(path).toLowerCase());
      if (entry) map.set(path, await ensureLocal(entry));
      else if (!isExternal(path)) missing.push(path);
    }
    onProgress?.(++done, paths.length);
  });
  return { data: replacePaths(data, map), missing };
}

/* -------------------------------------------- */
/*  Version adaptation                          */
/* -------------------------------------------- */

function packLevels(data) {
  return Array.isArray(data.levels) ? data.levels : [];
}

/**
 * Turn V14 multi-level scene data into V13 scene data for one level.
 * Placeables tagged to other levels are dropped.
 */
function flattenToLevel(data, levelId) {
  const levels = packLevels(data);
  const level = levels.find(l => l._id === levelId) ?? levels[0];
  const out = foundry.utils.deepClone(data);
  delete out.levels;
  delete out.initialLevel;
  if (!level) return out;
  out.background = { ...(out.background ?? {}), ...(level.background ?? {}) };
  if (level.foreground?.src) out.foreground = level.foreground.src;
  if (Number.isFinite(level.elevation?.top)) out.foregroundElevation = level.elevation.top;
  if (levels.length > 1) out.name = `${data.name} — ${level.name || level._id}`;
  for (const key of EMBEDDED) {
    if (!Array.isArray(out[key])) continue;
    out[key] = out[key].filter(doc => {
      if (key === "tokens") return !doc.level || doc.level === level._id;
      return !doc.levels?.length || doc.levels.includes(level._id);
    }).map(doc => {
      const copy = { ...doc };
      delete copy.levels;
      delete copy.level;
      return copy;
    });
  }
  // Behaviours that do not exist in this core version would fail validation.
  if (Array.isArray(out.regions)) {
    const known = CONFIG.RegionBehavior?.dataModels ?? {};
    out.regions = out.regions.map(r => ({ ...r, behaviors: (r.behaviors ?? []).filter(b => b.type in known) }));
  }
  return out;
}

/** Remove links to actors that do not exist in this world, so tokens still import. */
function cleanTokens(data, includeTokens) {
  if (!Array.isArray(data.tokens)) return;
  if (!includeTokens) {
    data.tokens = [];
    return;
  }
  for (const token of data.tokens) {
    if (token.actorId && !game.actors.has(token.actorId)) {
      token.actorId = null;
      token.actorLink = false;
    }
  }
}

async function sceneFolderId() {
  let folder = game.folders.find(f => f.type === "Scene" && f.name === FOLDER_NAME);
  folder ??= await Folder.implementation.create({ name: FOLDER_NAME, type: "Scene" });
  return folder?.id ?? null;
}

async function makeThumbnail(scene) {
  try {
    const { thumb } = await scene.createThumbnail();
    if (thumb) await scene.update({ thumb }, { diff: false });
  } catch (err) {
    console.warn(`${MODULE_ID} | Thumbnail generation failed`, err);
  }
}

/** Create a scene from (possibly cross-version) data. */
async function createScene(data, { activate = false } = {}) {
  data = foundry.utils.deepClone(data);
  delete data._id;
  delete data._stats;
  delete data.ownership;
  data.active = false;
  data.folder = await sceneFolderId();
  data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [MODULE_ID]: { imported: true } });
  const scene = await Scene.implementation.create(data, { keepEmbeddedIds: true });
  if (!scene) throw new Error("Scene creation was cancelled");
  // V13 data in V14: core migrates the background into the first level on creation.
  // If it did not, add that level ourselves.
  if (hasNativeLevels() && scene.levels?.size === 0 && data.background?.src) {
    await scene.createEmbeddedDocuments("Level", [{ name: "Level 1", background: { src: data.background.src } }]);
  }
  await makeThumbnail(scene);
  if (activate) await scene.activate();
  else await scene.view();
  return scene;
}

/* -------------------------------------------- */
/*  Import dialog                               */
/* -------------------------------------------- */

async function importOptions(data, entry) {
  const levels = packLevels(data);
  const native = hasNativeLevels();
  const legacy = native && hasLegacyLevels(data);
  let levelSelect = "";
  if (!native && levels.length > 1) {
    const opts = levels.map(l => `<option value="${esc(l._id)}">${esc(l.name || l._id)}</option>`).join("");
    levelSelect = `<div class="form-group"><label>${localize("Import.Level")}</label>
      <select name="level"><option value="__all">${localize("Import.AllLevels")}</option>${opts}</select>
      <p class="hint">${localize("Import.LevelHint")}</p></div>`;
  }
  const counts = EMBEDDED.filter(k => data[k]?.length).map(k => `${localize(`Import.Count.${k}`)}: ${data[k].length}`).join(", ");
  const content = `<form class="gdms-dialog">
    <p><strong>${esc(data.name ?? entry.name)}</strong></p>
    <p class="hint">${esc(counts || localize("Import.NoPlaceables"))}</p>
    <div class="form-group"><label>${localize("Import.Name")}</label><input type="text" name="name" value="${esc(data.name ?? basename(entry.name))}"></div>
    <div class="form-group"><label><input type="checkbox" name="tokens" ${data.tokens?.length ? "checked" : ""}> ${localize("Import.Tokens")}</label></div>
    ${legacy ? `<div class="form-group"><label><input type="checkbox" name="convert" checked> ${localize("Import.ConvertLevels")}</label></div>` : ""}
    ${levelSelect}
    <div class="form-group"><label><input type="checkbox" name="activate"> ${localize("Import.Activate")}</label></div>
  </form>`;
  return DialogV2().wait({
    window: { title: localize("Import.Title"), icon: "fa-solid fa-map" },
    content,
    buttons: [
      {
        action: "import", label: localize("Import.Button"), icon: "fa-solid fa-download", default: true,
        callback: (event, button) => {
          const f = button.form.elements;
          return {
            name: f.name.value.trim(),
            tokens: f.tokens.checked,
            convert: !!f.convert?.checked,
            level: f.level?.value ?? null,
            activate: f.activate.checked
          };
        }
      },
      { action: "cancel", label: localize("Cancel"), icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  }).then(r => (r && r !== "cancel" ? r : null));
}

/* -------------------------------------------- */
/*  Universal VTT (.dd2vtt / .uvtt)             */
/* -------------------------------------------- */

async function fromUniversalVTT(json, entry) {
  const res = json.resolution ?? {};
  const ppg = res.pixels_per_grid ?? 100;
  const origin = res.map_origin ?? { x: 0, y: 0 };
  const size = res.map_size ?? { x: 10, y: 10 };
  const pt = p => [Math.round((p.x - origin.x) * ppg), Math.round((p.y - origin.y) * ppg)];
  const distance = canvas.scene?.grid?.distance ?? 5;

  const walls = [];
  for (const line of [...(json.line_of_sight ?? []), ...(json.objects_line_of_sight ?? [])]) {
    for (let i = 0; i < line.length - 1; i++) walls.push({ c: [...pt(line[i]), ...pt(line[i + 1])] });
  }
  for (const portal of json.portals ?? []) {
    if (!portal.bounds?.length) continue;
    walls.push({ c: [...pt(portal.bounds[0]), ...pt(portal.bounds[1])], door: 1, ds: portal.closed === false ? 1 : 0 });
  }

  const lights = (json.lights ?? []).map(l => {
    const [x, y] = pt(l.position);
    const color = typeof l.color === "string" ? `#${l.color.slice(-6)}` : null;
    const dim = (l.range ?? 4) * distance;
    return { x, y, walls: l.shadows !== false, config: { dim, bright: dim / 2, color, alpha: Math.min(1, 0.5 * (l.intensity ?? 1)) } };
  });

  let src = null;
  if (json.image) {
    const bytes = Uint8Array.from(atob(json.image), c => c.charCodeAt(0));
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const ext = isPng ? "png" : isJpg ? "jpg" : "webp";
    const blob = new Blob([bytes], { type: `image/${ext === "jpg" ? "jpeg" : ext}` });
    const dir = [cacheRoot(), ...entry.path.split("/").filter(Boolean).map(sanitize)].join("/");
    src = await storeBlob(blob, dir, `${basename(entry.name)}.${ext}`);
  } else {
    const sibling = mediaIndex.subtree(entry.path).find(e => e.path === entry.path && e.kind === "image" && basename(e.name) === basename(entry.name));
    if (sibling) src = await ensureLocal(sibling);
  }

  return {
    name: basename(entry.name),
    width: Math.round(size.x * ppg),
    height: Math.round(size.y * ppg),
    padding: 0,
    grid: { size: ppg, distance },
    background: { src },
    tokenVision: true,
    walls,
    lights
  };
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/** Import a scene pack (Foundry JSON or Universal VTT) from a Drive index entry. */
export async function importPack(entry) {
  const progress = notifyProgress(localize("Notify.Downloading", { name: entry.name }));
  try {
    const blob = await drive.download(entry.id);
    const text = await blob.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(localize("Errors.BadJson"));
    }

    const ext = extension(entry.name);
    let scenes;
    if (["dd2vtt", "uvtt", "df2vtt"].includes(ext) || json.line_of_sight) scenes = [await fromUniversalVTT(json, entry)];
    else if (Array.isArray(json)) scenes = json;
    else if (Array.isArray(json.scenes)) scenes = json.scenes;
    else scenes = [json];
    scenes = scenes.filter(s => s && typeof s === "object" && (s.walls || s.grid || s.background || s.levels || s.width));
    if (!scenes.length) throw new Error(localize("Errors.NotAScene"));
    progress.close();

    const created = [];
    for (const raw of scenes) {
      const options = await importOptions(raw, entry);
      if (!options) continue;
      const step = notifyProgress(localize("Notify.Importing", { name: options.name || raw.name }));
      try {
        const { data, missing } = await localizeMedia(raw, entry.path, (n, total) => step.update(`${n}/${total}`));
        if (missing.length) {
          console.warn(`${MODULE_ID} | Missing media in ${entry.name}:`, missing);
          notify("warn", "Notify.MissingMedia", { count: missing.length });
        }
        data.name = options.name || data.name;
        cleanTokens(data, options.tokens);

        let variants = [data];
        if (!hasNativeLevels() && packLevels(data).length) {
          const levels = packLevels(data);
          variants = options.level && options.level !== "__all"
            ? [flattenToLevel(data, options.level)]
            : levels.length > 1 ? levels.map(l => flattenToLevel(data, l._id)) : [flattenToLevel(data, levels[0]?._id)];
        }
        for (const v of variants) {
          const scene = await createScene(v, { activate: options.activate && variants.length === 1 });
          if (options.convert) await convertLegacyLevels(scene, { duplicate: false, interactive: false });
          created.push(scene);
        }
      } finally {
        step.close();
      }
    }
    if (created.length) notify("info", "Notify.Imported", { count: created.length });
    return created;
  } catch (err) {
    progress.close();
    console.error(err);
    ui.notifications.error(err.message);
    return [];
  }
}

/** Guess the grid size from names like "Tavern 30x20.webp" (30 columns). */
function guessGrid(name, width, height) {
  const match = String(name).match(/(\d{1,3})\s*[xх×]\s*(\d{1,3})/i);
  if (match) {
    const cols = Number(match[1]);
    const rows = Number(match[2]);
    const size = Math.round(width / cols);
    if (size >= 20 && Math.abs(size * rows - height) < size) return size;
  }
  return 100;
}

/** Create a new scene with an image or video as the background. */
export async function createSceneFromMedia(entry) {
  const pack = mediaIndex.packFor(entry);
  if (pack) return importPack(pack);
  const src = await ensureLocal(entry);
  const tex = await loadTex(src);
  const width = tex?.width ?? 4000;
  const height = tex?.height ?? 3000;
  const name = basename(entry.name);
  const grid = { size: guessGrid(name, width, height) };
  if (hasNativeLevels()) {
    const id = foundry.utils.randomID();
    try {
      return await createScene({ name, width, height, grid, padding: 0.1, levels: [{ _id: id, name: "Level 1", background: { src } }], initialLevel: id });
    } catch (err) {
      console.warn(`${MODULE_ID} | Falling back to legacy background data`, err);
    }
  }
  return createScene({ name, width, height, grid, padding: 0.1, background: { src } });
}

/* -------------------------------------------- */
/*  Export to Drive                             */
/* -------------------------------------------- */

/** Upload a scene and every local file it uses into "<root>/<Scene Packs>/<scene name>/". */
export async function exportSceneToDrive(scene) {
  if (!drive.isSignedIn()) {
    try {
      await drive.signIn();
    } catch (err) {
      return ui.notifications.error(err.message);
    }
  }
  const progress = notifyProgress(localize("Notify.Exporting", { name: scene.name }));
  try {
    const data = scene.toObject();
    delete data._stats;
    delete data.ownership;
    delete data.folder;
    data.active = false;

    const root = drive.rootFolderId();
    const exportName = getSetting("exportFolderName") || "Scene Packs";
    const packsFolder = await drive.ensureFolder(exportName, root);
    const packFolder = await drive.ensureFolder(sanitize(scene.name), packsFolder.id);

    const paths = [...collectPaths(data)].filter(p => !isExternal(p) && !CORE_PREFIXES.some(c => p.startsWith(c)));
    const map = new Map();
    const usedNames = new Map();
    const uploaded = [];
    let duplicates = 0;
    await mapLimit(paths, 3, async path => {
      let response = await fetch(encodeURI(path)).catch(() => null);
      if (!response?.ok) response = await fetch(path).catch(() => null);
      if (!response?.ok) return;
      const blob = await response.blob();
      let name = sanitize(fileName(path));
      // Two different files with the same name: keep both.
      if (usedNames.has(name.toLowerCase())) name = `${basename(name)}-${++duplicates}.${extension(name)}`;
      usedNames.set(name.toLowerCase(), path);
      uploaded.push(await drive.uploadFile(blob, name, packFolder.id));
      map.set(path, name);
      progress.update(`${map.size}/${paths.length}`);
    });

    const json = replacePaths(data, map);
    json.flags = foundry.utils.mergeObject(json.flags ?? {}, { [MODULE_ID]: { exportedFrom: game.release?.version ?? game.version } });
    const jsonBlob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    uploaded.push(await drive.uploadFile(jsonBlob, `${sanitize(scene.name)}.json`, packFolder.id));

    const packsPath = exportName;
    const packPath = `${exportName}/${sanitize(scene.name)}`;
    await mediaIndex.addFolder(packsFolder, "");
    await mediaIndex.addFolder(packFolder, packsPath);
    await mediaIndex.addEntries(uploaded, packPath, packFolder.id);
    notify("info", "Notify.Exported", { name: scene.name, count: uploaded.length });
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
  } finally {
    progress.close();
  }
}

/* -------------------------------------------- */

/** A persistent notification that can be updated and closed. */
export function notifyProgress(message) {
  const n = ui.notifications.info(message, { permanent: true });
  return {
    update(suffix) {
      try {
        if (typeof n?.update === "function") n.update({ message: `${message} ${suffix}` });
      } catch (err) { /* ignore */ }
    },
    close() {
      try {
        ui.notifications.remove(n?.id ?? n);
      } catch (err) { /* ignore */ }
    }
  };
}
