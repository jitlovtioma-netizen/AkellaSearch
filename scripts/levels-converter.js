/**
 * Converts multi-floor maps made for V13 (the "Levels" module by theripper93 together with
 * "Wall Height") into native V14 scene levels.
 *
 * What it reads from the old scene:
 *  - scene flag levels.sceneLevels: [[bottom, top, name], ...] (the floor list);
 *    if absent, floors are inferred from tile elevations;
 *  - tile elevation + flags.levels.rangeTop;
 *  - wall flags["wall-height"].bottom/top;
 *  - light, sound and note flags.levels.rangeBottom/rangeTop;
 *  - drawings used as stairs/elevators (flags.levels.drawingMode 2/3) and holes (1);
 *  - token elevation.
 *
 * What it creates in V14:
 *  - one Level per floor with its elevation band, the full-size floor tile promoted to the level background;
 *  - `levels` tags on walls, tiles, lights, sounds, notes, drawings; `level` on tokens;
 *  - a "Define Surface" region for each upper floor (with holes cut out), and
 *    "Change Level" regions where the old stairs were.
 */
import { MODULE_ID, DialogV2, docHasLevels, esc, hasNativeLevels, localize, notify } from "./compat.js";

const STAIR_MODES = new Set([2, 3]);
const HOLE_MODE = 1;

function flagsOf(doc) {
  return doc?.flags ?? {};
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function plain(source) {
  return source?.toObject ? source.toObject() : source;
}

/** Does the scene (document or plain data) use the old Levels module setup? */
export function hasLegacyLevels(source) {
  const data = plain(source);
  if (!data) return false;
  if (flagsOf(data).levels?.sceneLevels?.length) return true;
  return (data.tiles ?? []).some(t => num(flagsOf(t).levels?.rangeTop) !== null)
    || (data.walls ?? []).some(w => flagsOf(w)["wall-height"] && (num(flagsOf(w)["wall-height"].top) !== null || num(flagsOf(w)["wall-height"].bottom) !== null));
}

/** Read the old floor list, sorted bottom-up, with finite tops. */
export function readLegacyFloors(source) {
  const data = plain(source);
  const raw = flagsOf(data).levels?.sceneLevels;
  let floors = [];
  if (Array.isArray(raw)) {
    floors = raw.map(l => (Array.isArray(l)
      ? { bottom: num(l[0]), top: num(l[1]), name: l[2] }
      : { bottom: num(l.bottom ?? l.rangeBottom), top: num(l.top ?? l.rangeTop), name: l.name }));
  }
  floors = floors.filter(f => f.bottom !== null);
  if (!floors.length) {
    // No floor list: every distinct elevation of a Levels-ranged tile starts a floor.
    const elevations = new Set([0]);
    for (const t of data.tiles ?? []) if (num(flagsOf(t).levels?.rangeTop) !== null) elevations.add(num(t.elevation) ?? 0);
    floors = [...elevations].map(e => ({ bottom: e, top: null, name: null }));
  }
  floors.sort((a, b) => a.bottom - b.bottom);
  floors.forEach((f, i) => {
    const next = floors[i + 1];
    if (f.top === null || !Number.isFinite(f.top)) {
      const height = i > 0 ? floors[i].bottom - floors[i - 1].bottom : 10;
      f.top = next ? next.bottom : f.bottom + (height || 10);
    }
    // Levels used inclusive integer tops (0-9, 10-19); close the gap so bands touch.
    if (next && next.bottom - f.top <= 1) f.top = next.bottom;
    f.name ||= `${localize("Convert.Floor")} ${i + 1}`;
  });
  return floors;
}

function regionBehaviorType(className, fallback) {
  const models = CONFIG.RegionBehavior?.dataModels ?? {};
  for (const [key, cls] of Object.entries(models)) if (cls?.name === className) return key;
  return fallback in models ? fallback : null;
}

function drawingShape(d) {
  const shape = d.shape ?? {};
  const x = d.x ?? 0;
  const y = d.y ?? 0;
  const width = shape.width ?? 0;
  const height = shape.height ?? 0;
  const rotation = d.rotation ?? 0;
  if (shape.type === "e") return { type: "ellipse", x: x + width / 2, y: y + height / 2, radiusX: width / 2, radiusY: height / 2, rotation };
  if (shape.type === "p" && shape.points?.length >= 6) {
    const points = shape.points.map((v, i) => v + (i % 2 ? y : x));
    return { type: "polygon", points };
  }
  return { type: "rectangle", x, y, width, height, rotation };
}

/** Build the list of changes without touching the scene, so it can be shown to the GM first. */
export function planConversion(scene) {
  const floors = readLegacyFloors(scene);
  const data = scene.toObject();
  const levelsFor = (bottom, top) => floors.filter(f => {
    const b = bottom ?? -Infinity;
    const t = top ?? Infinity;
    return f.bottom < t && f.top > b || f.bottom === b;
  });
  const floorAt = e => floors.findLast(f => f.bottom <= (e ?? 0)) ?? floors[0];
  return { floors, data, levelsFor, floorAt };
}

/**
 * Convert a V13 multi-floor scene into V14 native levels.
 * @param {Scene} scene
 * @param {object} options
 * @param {boolean} [options.duplicate=true]   Work on a copy and keep the original.
 * @param {boolean} [options.interactive=true] Show the options dialog first.
 */
export async function convertLegacyLevels(scene, { duplicate = true, interactive = true } = {}) {
  if (!hasNativeLevels()) {
    notify("warn", "Convert.NeedV14");
    return null;
  }
  let options = { duplicate, promote: true, surfaces: true, stairs: true, visibility: true };
  if (interactive) {
    options = await askOptions(scene, options);
    if (!options) return null;
  }
  if (options.duplicate) {
    scene = await scene.clone({ name: `${scene.name} (V14)` }, { save: true, keepId: false });
  }

  const { floors, data, levelsFor, floorAt } = planConversion(scene);
  const report = { levels: floors.length, tagged: 0, stairs: 0, surfaces: 0, promoted: 0, holes: 0 };

  // 1. Levels: reuse the level core created during migration for the ground floor.
  const existing = scene.levels.contents.sort((a, b) => (a.elevation?.bottom ?? 0) - (b.elevation?.bottom ?? 0));
  const resolve = v => (typeof v === "string" ? scene.levels.get(v) : v);
  const base = resolve(scene.initialLevel) ?? resolve(scene.firstLevel) ?? existing[0];
  const ids = [];
  if (base) {
    await scene.updateEmbeddedDocuments("Level", [{ _id: base.id, name: floors[0].name, elevation: { bottom: floors[0].bottom, top: floors[0].top } }]);
    ids.push(base.id);
  }
  const toCreate = floors.slice(base ? 1 : 0).map((f, i) => ({ name: f.name, elevation: { bottom: f.bottom, top: f.top }, sort: (i + 1) * 1000 }));
  if (toCreate.length) {
    const created = await scene.createEmbeddedDocuments("Level", toCreate);
    ids.push(...created.map(l => l.id));
  }
  floors.forEach((f, i) => { f.id = ids[i]; });
  const idsOf = list => list.map(f => f.id).filter(Boolean);

  // 2. Upper floors may see the floors below them (through holes and openings).
  if (options.visibility && floors.length > 1) {
    const updates = floors.slice(1).map((f, i) => ({ _id: f.id, visibility: { levels: idsOf(floors.slice(0, i + 1)) } }));
    await safe(() => scene.updateEmbeddedDocuments("Level", updates), "visibility");
  }

  // 3. Promote full-scene floor tiles to level backgrounds.
  const rect = scene.dimensions?.sceneRect ?? { x: 0, y: 0, width: scene.width, height: scene.height };
  const promotedTiles = new Set();
  if (options.promote) {
    const levelUpdates = [];
    for (const f of floors.slice(1)) {
      const tile = data.tiles.find(t => !promotedTiles.has(t._id)
        && (num(t.elevation) ?? 0) === f.bottom
        && Math.abs(t.x - rect.x) <= rect.width * 0.02 && Math.abs(t.y - rect.y) <= rect.height * 0.02
        && Math.abs(t.width - rect.width) <= rect.width * 0.02 && Math.abs(t.height - rect.height) <= rect.height * 0.02);
      if (!tile?.texture?.src) continue;
      promotedTiles.add(tile._id);
      levelUpdates.push({ _id: f.id, background: { src: tile.texture.src } });
    }
    if (levelUpdates.length) {
      const ok = await safe(() => scene.updateEmbeddedDocuments("Level", levelUpdates), "backgrounds");
      if (ok) {
        await scene.deleteEmbeddedDocuments("Tile", [...promotedTiles]);
        report.promoted = promotedTiles.size;
      } else promotedTiles.clear();
    }
  }

  // 4. Tag placeables.
  const tag = async (documentName, docs, rangeOf, extra = () => ({})) => {
    if (!docHasLevels(documentName)) return;
    const updates = [];
    for (const d of docs) {
      const range = rangeOf(d);
      if (!range) continue;
      const levels = idsOf(range);
      if (!levels.length || levels.length === floors.length) continue; // blank = all levels
      updates.push({ _id: d._id, levels, ...extra(d) });
    }
    if (updates.length && await safe(() => scene.updateEmbeddedDocuments(documentName, updates), documentName)) report.tagged += updates.length;
  };

  await tag("Wall", data.walls, w => {
    const wh = flagsOf(w)["wall-height"];
    if (!wh) return null;
    const bottom = num(wh.bottom);
    const top = num(wh.top);
    if (bottom === null && top === null) return null;
    return levelsFor(bottom, top);
  });
  await tag("Tile", data.tiles.filter(t => !promotedTiles.has(t._id)), t => [floorAt(num(t.elevation))]);
  const ranged = d => {
    const lf = flagsOf(d).levels ?? {};
    const bottom = num(lf.rangeBottom);
    const top = num(lf.rangeTop);
    if (bottom === null && top === null) return null;
    return levelsFor(bottom, top);
  };
  const elevationFromRange = d => {
    const bottom = num(flagsOf(d).levels?.rangeBottom);
    return bottom !== null && Number.isFinite(bottom) ? { elevation: bottom } : {};
  };
  await tag("AmbientLight", data.lights, ranged, elevationFromRange);
  await tag("AmbientSound", data.sounds, ranged, elevationFromRange);
  await tag("Note", data.notes ?? [], ranged);
  await tag("Drawing", (data.drawings ?? []).filter(d => !flagsOf(d).levels?.drawingMode), ranged);

  if (CONFIG.Token.documentClass.schema.fields.level && floors.length > 1) {
    const updates = data.tokens.map(t => ({ _id: t._id, level: floorAt(num(t.elevation)).id }));
    if (updates.length) await safe(() => scene.updateEmbeddedDocuments("Token", updates), "tokens");
  }

  // 5. Stairs and elevators become "Change Level" regions; holes are cut out of floor surfaces.
  const changeLevel = regionBehaviorType("ChangeLevelRegionBehaviorType", "changeLevel");
  const defineSurface = regionBehaviorType("DefineSurfaceRegionBehaviorType", "defineSurface");
  const regions = [];
  const holes = [];
  for (const d of data.drawings ?? []) {
    const lf = flagsOf(d).levels ?? {};
    const mode = num(lf.drawingMode);
    if (mode === HOLE_MODE) holes.push({ shape: drawingShape(d), bottom: num(lf.rangeBottom), top: num(lf.rangeTop) });
    if (!options.stairs || !STAIR_MODES.has(mode) || !changeLevel) continue;
    const bottom = num(lf.rangeBottom) ?? 0;
    const top = num(lf.rangeTop) ?? bottom;
    const spanned = floors.filter(f => f.top >= bottom && f.bottom <= top);
    regions.push({
      name: d.text || localize("Convert.Stairs"),
      shapes: [drawingShape(d)],
      elevation: { bottom, top },
      levels: idsOf(spanned.length > 1 ? spanned : levelsFor(bottom, top)),
      behaviors: [{ name: localize("Convert.Stairs"), type: changeLevel, system: {} }]
    });
  }
  // Old region behaviours from the Levels module are not available in V14 core.
  const legacyRegions = (data.regions ?? []).filter(r => (r.behaviors ?? []).some(b => String(b.type).startsWith("levels.")));
  for (const r of legacyRegions) {
    if (!options.stairs || !changeLevel) break;
    const bottom = num(r.elevation?.bottom) ?? 0;
    const top = num(r.elevation?.top) ?? bottom;
    regions.push({ ...r, _id: undefined, levels: idsOf(levelsFor(bottom, top)), behaviors: [{ name: localize("Convert.Stairs"), type: changeLevel, system: {} }] });
  }
  report.stairs = regions.length;

  if (options.surfaces && defineSurface) {
    for (const f of floors.slice(1)) {
      const floorHoles = holes.filter(h => h.bottom === null || (h.bottom <= f.bottom && (h.top ?? Infinity) >= f.bottom));
      report.holes += floorHoles.length;
      regions.push({
        name: `${localize("Convert.Surface")}: ${f.name}`,
        shapes: [
          { type: "rectangle", x: rect.x, y: rect.y, width: rect.width, height: rect.height, rotation: 0, hole: false },
          ...floorHoles.map(h => ({ ...h.shape, hole: true }))
        ],
        elevation: { bottom: f.bottom, top: f.bottom },
        levels: [f.id],
        behaviors: [{ name: localize("Convert.Surface"), type: defineSurface, system: {} }]
      });
      report.surfaces++;
    }
  }
  if (legacyRegions.length) await safe(() => scene.deleteEmbeddedDocuments("Region", legacyRegions.map(r => r._id)), "legacy regions");
  if (regions.length) await safe(() => scene.createEmbeddedDocuments("Region", regions.map(r => {
    const copy = { ...r };
    delete copy._id;
    return copy;
  })), "regions");

  await scene.update({ [`flags.${MODULE_ID}.convertedToLevels`]: Date.now() });
  notify("info", "Convert.Done", { name: scene.name, ...report });
  return scene;
}

async function safe(fn, label) {
  try {
    await fn();
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | Level conversion step "${label}" failed`, err);
    notify("warn", "Convert.StepFailed", { step: label, error: err.message });
    return false;
  }
}

async function askOptions(scene, defaults) {
  const floors = readLegacyFloors(scene);
  const legacy = hasLegacyLevels(scene);
  const rows = floors.map(f => `<li>${esc(f.name)}: ${f.bottom} → ${f.top}</li>`).join("");
  const box = (name, label) => `<div class="form-group"><label><input type="checkbox" name="${name}" ${defaults[name] ? "checked" : ""}> ${localize(label)}</label></div>`;
  const content = `<form class="gdms-dialog">
    <p>${localize(legacy ? "Convert.Found" : "Convert.NotFound")}</p>
    <ul>${rows}</ul>
    ${box("duplicate", "Convert.Duplicate")}
    ${box("promote", "Convert.Promote")}
    ${box("surfaces", "Convert.Surfaces")}
    ${box("stairs", "Convert.StairsOption")}
    ${box("visibility", "Convert.Visibility")}
  </form>`;
  const result = await DialogV2().wait({
    window: { title: `${localize("Convert.Title")}: ${scene.name}`, icon: "fa-solid fa-layer-group" },
    content,
    buttons: [
      {
        action: "convert", label: localize("Convert.Button"), icon: "fa-solid fa-layer-group", default: true,
        callback: (event, button) => Object.fromEntries(["duplicate", "promote", "surfaces", "stairs", "visibility"].map(k => [k, button.form.elements[k].checked]))
      },
      { action: "cancel", label: localize("Cancel"), icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });
  return result && result !== "cancel" ? result : null;
}
