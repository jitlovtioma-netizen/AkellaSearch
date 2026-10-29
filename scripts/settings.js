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
  // Kept per browser: players can read world settings.
  world("oauthClientSecret", String, "", { scope: "client" });
  world("uploadConcurrency", Number, 6, { range: { min: 1, max: 10, step: 1 } });
  world("storageSource", String, "data", {
    choices: { data: "User Data", forgevtt: "The Forge", s3: "Amazon S3" }
  });
  world("cacheFolder", String, "gdrive-media");
  world("autoSort", Boolean, true);
  world("convertImages", Boolean, true);
  world("convertAudio", Boolean, true);
  world("webpQuality", Number, 85, { range: { min: 50, max: 100, step: 5 } });
  world("audioBitrate", Number, 128, { range: { min: 64, max: 256, step: 32 } });
  world("convertOnImport", Boolean, false);
  world("soundRadius", Number, 30);
  world("playersCanBrowse", Boolean, false, { requiresReload: true });

  // Internal state, not shown in the settings window.
  const hidden = (key, type, def) => game.settings.register(MODULE_ID, key, { scope: "world", config: false, type, default: def });
  hidden("indexPath", String, "");
  hidden("indexBuiltAt", Number, 0);
  hidden("cacheMap", Object, {});
  game.settings.register(MODULE_ID, "refreshToken", { scope: "client", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "lastAuthor", { scope: "client", config: false, type: String, default: "" });
}

/** Conversion options from the settings, for convert.js. */
export function conversionOptions(enabled = true) {
  return {
    images: enabled && getSetting("convertImages"),
    audio: enabled && getSetting("convertAudio"),
    quality: (getSetting("webpQuality") || 85) / 100,
    bitRate: (getSetting("audioBitrate") || 128) * 1000
  };
}

/** How many files to send to Drive at the same time. */
export function uploadConcurrency() {
  return Math.min(10, Math.max(1, Number(getSetting("uploadConcurrency")) || 6));
}
