/**
 * Small helpers that hide API differences between Foundry V13 and V14.
 */

export const MODULE_ID = "akella-search";

/** The major version of the running core software. */
export function generation() {
  return game.release?.generation ?? Number(String(game.version).split(".")[0]);
}

/** Does this core version have native scene levels (V14+)? */
export function hasNativeLevels() {
  return !!Scene.schema?.fields?.initialLevel;
}

/** Does a placeable document class carry a `levels` set field? */
export function docHasLevels(documentName) {
  const cls = CONFIG[documentName]?.documentClass;
  return !!cls?.schema?.fields?.levels;
}

export function FilePickerClass() {
  return foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

export function loadTex(src) {
  const fn = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
  return fn(src);
}

export function DialogV2() {
  return foundry.applications.api.DialogV2;
}

export function ImagePopoutClass() {
  return foundry.applications.apps?.ImagePopout ?? globalThis.ImagePopout;
}

export function loadHbs(paths) {
  const fn = foundry.applications.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  return fn(paths);
}

export function localize(key, data) {
  return data ? game.i18n.format(`GDMS.${key}`, data) : game.i18n.localize(`GDMS.${key}`);
}

export function notify(type, key, data) {
  ui.notifications[type](localize(key, data));
}

/** Escape a string for safe insertion into HTML. */
export function esc(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

/** Resolve an element passed to a context menu callback (HTMLElement in V13+, jQuery in older code). */
export function contextElement(li) {
  return li instanceof HTMLElement ? li : li?.[0];
}

/** Run async tasks with limited parallelism. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
