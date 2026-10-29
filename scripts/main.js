import { MODULE_ID, contextElement, hasNativeLevels, loadHbs, localize } from "./compat.js";
import { getSetting, registerSettings } from "./settings.js";
import * as drive from "./drive.js";
import { mediaIndex } from "./media-index.js";
import { MediaBrowser } from "./browser.js";
import { onDropCanvasData, placeMedia } from "./placement.js";
import { createSceneFromMedia, exportSceneToDrive, importPack } from "./scene-packs.js";
import { convertLegacyLevels, hasLegacyLevels } from "./levels-converter.js";
import { setEncoderUrl, maybeConvert } from "./convert.js";
import { convertExisting, uploadWithDialog } from "./uploader.js";
import { openTransfer } from "./transfer.js";

function canBrowse() {
  return game.user.isGM || getSetting("playersCanBrowse");
}

Hooks.once("init", () => {
  registerSettings();
  const worker = `modules/${MODULE_ID}/vendor/opus/encoderWorker.min.js`;
  setEncoderUrl(foundry.utils.getRoute?.(worker) ?? worker);
  loadHbs([
    `modules/${MODULE_ID}/templates/browser-header.hbs`,
    `modules/${MODULE_ID}/templates/browser-results.hbs`
  ]);
  game.keybindings.register(MODULE_ID, "open", {
    name: "GDMS.Keybinding",
    editable: [{ key: "KeyM", modifiers: ["Control", "Shift"] }],
    onDown: () => {
      if (canBrowse()) MediaBrowser.open();
      return true;
    }
  });
});

Hooks.once("ready", async () => {
  drive.restoreToken();
  if (game.user.isGM) drive.preload();
  await mediaIndex.load();
  game.modules.get(MODULE_ID).api = {
    open: () => MediaBrowser.open(),
    index: mediaIndex,
    drive,
    rebuildIndex: () => mediaIndex.rebuild(),
    search: options => mediaIndex.search(options),
    placeMedia,
    importPack,
    createSceneFromMedia,
    exportSceneToDrive,
    openTransfer,
    uploadFiles: (files, folder) => uploadWithDialog(files, folder),
    convertDriveFolder: folder => convertExisting(folder),
    convert: maybeConvert,
    convertLegacyLevels,
    hasLegacyLevels
  };
});

Hooks.on(`${MODULE_ID}.indexChanged`, () => MediaBrowser.refresh());
Hooks.on(`${MODULE_ID}.authChanged`, () => MediaBrowser.refresh());
Hooks.on("updateSetting", setting => {
  if (setting.key === `${MODULE_ID}.indexBuiltAt` && !game.user.isGM) mediaIndex.load();
  if (setting.key === `${MODULE_ID}.oauthClientId` && game.user.isGM) drive.preload();
});

Hooks.on("dropCanvasData", onDropCanvasData);

/* -------------------------------------------- */
/*  Scene controls button                       */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", controls => {
  if (!canBrowse()) return;
  const tool = {
    name: MODULE_ID,
    title: "GDMS.Title",
    icon: "fa-brands fa-google-drive",
    button: true,
    order: 100,
    visible: true,
    onChange: () => MediaBrowser.open(),
    onClick: () => MediaBrowser.open()
  };
  // V13+: controls is an object keyed by control name, tools is an object too.
  if (!Array.isArray(controls)) {
    const tiles = controls.tiles ?? controls.tokens;
    if (tiles?.tools) tiles.tools[MODULE_ID] = { ...tool, onClick: undefined };
    return;
  }
  const tiles = controls.find(c => c.name === "tiles") ?? controls[0];
  tiles?.tools.push({ ...tool, onChange: undefined });
});

/* -------------------------------------------- */
/*  Scene directory                             */
/* -------------------------------------------- */

Hooks.on("renderSceneDirectory", (app, html) => {
  if (!canBrowse()) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector(".gdms-open")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gdms-open";
  button.innerHTML = `<i class="fa-brands fa-google-drive"></i> ${localize("Title")}`;
  button.addEventListener("click", () => MediaBrowser.open());
  const actions = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  actions?.append(button);
});

// V13+ calls getSceneContextOptions; older builds called getSceneDirectoryEntryContext.
function addSceneContextOptions(app, options) {
  if (options.some(o => o.name === "GDMS.Context.Export")) return;
  const sceneOf = li => {
    const el = contextElement(li);
    return game.scenes.get(el?.dataset.entryId ?? el?.dataset.documentId);
  };
  options.push({
    name: "GDMS.Context.Export",
    icon: '<i class="fa-brands fa-google-drive"></i>',
    condition: () => game.user.isGM && drive.canSignIn(),
    callback: li => {
      const scene = sceneOf(li);
      if (scene) exportSceneToDrive(scene);
    }
  });
  options.push({
    name: "GDMS.Context.Convert",
    icon: '<i class="fa-solid fa-layer-group"></i>',
    condition: li => game.user.isGM && hasNativeLevels() && !!sceneOf(li),
    callback: li => {
      const scene = sceneOf(li);
      if (scene) convertLegacyLevels(scene, { duplicate: true, interactive: true });
    }
  });
}

Hooks.on("getSceneContextOptions", addSceneContextOptions);
Hooks.on("getSceneDirectoryEntryContext", addSceneContextOptions);
