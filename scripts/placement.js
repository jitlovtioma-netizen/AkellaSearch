/**
 * Putting Drive media on the canvas: images and videos become tiles, audio becomes ambient sounds,
 * scene files are imported as whole scenes.
 */
import { MODULE_ID, hasNativeLevels, loadTex, notify } from "./compat.js";
import { getSetting } from "./settings.js";
import { ensureLocal } from "./cache.js";
import { mediaIndex } from "./media-index.js";
import { importPack } from "./scene-packs.js";

export const DRAG_TYPE = "GDriveMedia";

/** The level the GM is currently looking at (V14 only). */
function viewedLevel() {
  if (!hasNativeLevels()) return null;
  return canvas.level ?? null;
}

function levelData() {
  const level = viewedLevel();
  if (!level) return {};
  const data = { levels: [level.id] };
  const bottom = level.elevation?.bottom;
  if (Number.isFinite(bottom)) data.elevation = bottom;
  return data;
}

export function viewCenter() {
  const { x, y } = canvas.stage.pivot;
  return { x, y };
}

export async function placeMedia(entry, x, y) {
  if (!canvas.scene) return notify("warn", "Errors.NoScene");
  if (entry.kind === "scene") return importPack(entry);
  const src = await ensureLocal(entry);
  if (entry.kind === "image" || entry.kind === "video") {
    const tex = await loadTex(src);
    let width = tex?.width ?? canvas.grid.size;
    let height = tex?.height ?? canvas.grid.size;
    const max = Math.max(canvas.dimensions.sceneWidth, canvas.dimensions.sceneHeight);
    if (Math.max(width, height) > max) {
      const k = max / Math.max(width, height);
      width *= k;
      height *= k;
    }
    const data = { texture: { src }, x: Math.round(x - width / 2), y: Math.round(y - height / 2), width: Math.round(width), height: Math.round(height), ...levelData() };
    if (entry.kind === "video") data.video = { autoplay: true, loop: true, volume: 0 };
    return canvas.scene.createEmbeddedDocuments("Tile", [data]);
  }
  if (entry.kind === "audio") {
    const data = { x: Math.round(x), y: Math.round(y), path: src, radius: getSetting("soundRadius") || 30, volume: 0.5, walls: true, easing: true, ...levelData() };
    return canvas.scene.createEmbeddedDocuments("AmbientSound", [data]);
  }
  notify("warn", "Errors.CannotPlace");
}

/** Handle a drop from the media browser onto the canvas. Returns false to stop core handling. */
export function onDropCanvasData(cnv, data) {
  if (data?.type !== DRAG_TYPE) return;
  const entry = mediaIndex.get(data.id);
  if (!entry) return false;
  placeMedia(entry, data.x, data.y).catch(err => {
    console.error(`${MODULE_ID} |`, err);
    ui.notifications.error(err.message);
  });
  return false;
}
