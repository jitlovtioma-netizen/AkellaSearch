import { MODULE_ID } from "./compat.js";

export const DEFAULT_FOLDER = "1nGkKVH959u3lA_4wP6ijjEvmJbUpnIzc";

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

export function registerSettings() {
  const world = (key, type, def, extra = {}) => game.settings.register(MODULE_ID, key, {
    name: `GDMS.Settings.${key}.Name`,
    hint: `GDMS.Settings.${key}.Hint`,
    scope: "world",
    config: true,
    type,
    default: def,
    ...extra
  });

  world("rootFolder", String, DEFAULT_FOLDER);
  world("apiKey", String, "");
  world("oauthClientId", String, "");
  world("storageSource", String, "data", {
    choices: { data: "User Data", forgevtt: "The Forge", s3: "Amazon S3" }
  });
  world("cacheFolder", String, "gdrive-media");
  world("exportFolderName", String, "Scene Packs");
  world("soundRadius", Number, 30);
  world("playersCanBrowse", Boolean, false, { requiresReload: true });

  // Internal state, not shown in the settings window.
  const hidden = (key, type, def) => game.settings.register(MODULE_ID, key, { scope: "world", config: false, type, default: def });
  hidden("indexPath", String, "");
  hidden("indexBuiltAt", Number, 0);
  hidden("cacheMap", Object, {});
}
