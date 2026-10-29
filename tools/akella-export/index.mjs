#!/usr/bin/env node
/**
 * Akella Export: turns installed Foundry VTT map modules into an Akella Search library.
 *
 *   node index.mjs scan  --data <Foundry Data> --out <Google Drive folder>
 *   node index.mjs run   --data <Foundry Data> --out <Google Drive folder>
 *
 * scan  finds modules with maps and writes akella-export.config.json (edit it to choose).
 * run   reads every chosen module's scene compendiums (LevelDB or old .db), converts the
 *       media (png/jpg → webp, mp3/wav/flac → ogg, 4K videos → Full HD) and writes
 *       Maps/<Author>/<Map>/ scene packs into the Google Drive desktop folder, which then
 *       uploads them. Interrupted runs continue where they stopped.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { groupNames } from "./grouping.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, "akella-export.config.json");
const STATE_FILE = path.join(HERE, "akella-export.state.json");
const LOG_FILE = path.join(HERE, "akella-export.log");

const EXT = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp", "tif", "tiff"],
  video: ["webm", "mp4", "m4v", "ogv", "mov"],
  audio: ["mp3", "ogg", "oga", "opus", "wav", "flac", "m4a", "aac"]
};
const TO_WEBP = ["png", "jpg", "jpeg", "bmp", "tif", "tiff"];
const TO_OGG = ["mp3", "wav", "flac", "m4a", "aac"];
const MEDIA_RE = /\.(png|jpe?g|webp|gif|svg|avif|bmp|tiff?|webm|mp4|m4v|ogv|mov|mp3|ogg|oga|opus|wav|flac|m4a|aac)(\?.*)?$/i;
const CORE_PREFIXES = ["icons/", "ui/", "sounds/", "/icons/", "/ui/", "/sounds/"];
const MAP_WORDS = /master|snowy\s*star|snowystar|maps?\b|battle\s*maps?|battlemap|czepeku|cartos|baileywiki|beneos|cartographer|dungeon|encounter|scenes?|адвенчур|карт/i;
const UHD_RE = /(^|[\s_\-.(\[])(4k|uhd|2160p?)(?=$|[\s_\-.)\]])/i;
const FHD_RE = /(^|[\s_\-.(\[])(fhd|1080p?|full\s*hd|hd)(?=$|[\s_\-.)\]])/i;
const CATEGORIES = { maps: "Maps", tokens: "Tokens", tiles: "Tiles", music: "Music", ambience: "Ambience", sfx: "SFX", other: "Other" };

/* -------------------------------------------- */
/*  Small helpers                               */
/* -------------------------------------------- */

const ext = name => (String(name).split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
const stem = name => path.basename(String(name)).replace(/\.[a-z0-9]{2,5}$/i, "");
const kindOf = name => Object.entries(EXT).find(([, list]) => list.includes(ext(name)))?.[0] ?? "other";
// Same rules as the Foundry module, plus what Windows refuses in file names.
const sanitize = name => String(name).replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "file";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtBytes = b => (b > 1e9 ? `${(b / 1e9).toFixed(2)} ГБ` : `${(b / 1e6).toFixed(1)} МБ`);

let logStream = null;
function log(...args) {
  const line = args.join(" ");
  console.log(line);
  logStream?.write(`${new Date().toISOString()} ${line}\n`);
}
function warn(...args) {
  const line = args.join(" ");
  console.warn(`  ! ${line}`);
  logStream?.write(`${new Date().toISOString()} WARN ${line}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

function defaultDataDir() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "FoundryVTT", "Data");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "FoundryVTT", "Data");
  return path.join(os.homedir(), ".local", "share", "FoundryVTT", "Data");
}

/** Run tasks with a fixed number in flight. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

/* -------------------------------------------- */
/*  Reading compendiums                         */
/* -------------------------------------------- */

/** Copy a LevelDB folder first: Foundry keeps a lock on packs of a running world. */
async function readLevelDb(dir) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "akella-pack-"));
  try {
    for (const f of await fsp.readdir(dir)) {
      if (f === "LOCK") continue;
      const src = path.join(dir, f);
      if ((await fsp.stat(src)).isFile()) await fsp.copyFile(src, path.join(tmp, f));
    }
    const db = new ClassicLevel(tmp, { keyEncoding: "utf8", valueEncoding: "utf8", createIfMissing: false });
    await db.open();
    const entries = new Map();
    for await (const [key, value] of db.iterator()) {
      try {
        entries.set(key, JSON.parse(value));
      } catch (err) { /* not a document */ }
    }
    await db.close();
    return entries;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Foundry V11+ stores embedded documents under their own keys:
 * "!scenes!<id>" holds walls: ["<wallId>", …], and "!scenes.walls!<id>.<wallId>" holds each wall.
 * Put them back together, at any depth (adventures → scenes → walls).
 */
function hydrate(entries, collection, idPath, doc) {
  const out = { ...doc };
  for (const [field, value] of Object.entries(doc)) {
    if (!Array.isArray(value) || !value.length || !value.every(v => typeof v === "string")) continue;
    const sub = `${collection}.${field}`;
    const prefix = `!${sub}!${idPath}.`;
    if (!entries.has(prefix + value[0])) continue;
    out[field] = value.map(id => {
      const child = entries.get(prefix + id);
      return child ? hydrate(entries, sub, `${idPath}.${id}`, child) : null;
    }).filter(Boolean);
  }
  return out;
}

/** Scenes of one compendium as [{ name, data }]. */
async function readPack(moduleDir, pack) {
  const rel = String(pack.path ?? `packs/${pack.name}`).replace(/^\/+/, "");
  let full = path.join(moduleDir, rel);
  const type = pack.type ?? pack.documentName ?? pack.entity;
  const scenes = [];
  let docs = [];
  const asDir = full.replace(/\.db$/i, "");
  if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
    const entries = await readLevelDb(asDir);
    const coll = type === "Adventure" ? "adventures" : "scenes";
    for (const [key, doc] of entries) {
      const m = key.match(/^!([a-zA-Z]+)!([^.!]+)$/);
      if (m && m[1] === coll) docs.push(hydrate(entries, coll, m[2], doc));
    }
  } else {
    if (!fs.existsSync(full) && fs.existsSync(`${full}.db`)) full = `${full}.db`;
    if (!fs.existsSync(full)) return scenes;
    // V10 and older: NeDB, one JSON document per line.
    const byId = new Map();
    for (const line of (await fsp.readFile(full, "utf8")).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.$$deleted) byId.delete(d._id);
        else byId.set(d._id, d);
      } catch (err) { /* broken line */ }
    }
    docs = [...byId.values()];
  }
  for (const doc of docs) {
    if (type === "Adventure") {
      for (const s of doc.scenes ?? []) if (s && typeof s === "object") scenes.push({ name: s.name, data: s, adventure: doc.name });
    } else scenes.push({ name: doc.name, data: doc });
  }
  return scenes;
}

/* -------------------------------------------- */
/*  Modules                                     */
/* -------------------------------------------- */

async function readModules(dataDir) {
  const root = path.join(dataDir, "modules");
  const list = [];
  for (const id of await fsp.readdir(root).catch(() => [])) {
    const dir = path.join(root, id);
    const file = path.join(dir, "module.json");
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(await fsp.readFile(file, "utf8"));
      const packs = (json.packs ?? []).filter(p => ["Scene", "Adventure"].includes(p.type ?? p.documentName ?? p.entity));
      list.push({ id: json.id ?? json.name ?? id, dir, json, packs });
    } catch (err) {
      warn(`${id}: module.json не читается (${err.message})`);
    }
  }
  return list;
}

function moduleAuthor(json) {
  const authors = (json.authors ?? []).map(a => (typeof a === "string" ? a : a?.name)).filter(Boolean);
  return authors[0] ?? json.author ?? json.title ?? json.id;
}

function backgroundOf(scene) {
  return scene.background?.src ?? scene.img ?? scene.levels?.find?.(l => l?.background?.src)?.background?.src ?? null;
}

async function scan(args) {
  const dataDir = path.resolve(args.data ?? defaultDataDir());
  if (!fs.existsSync(path.join(dataDir, "modules"))) throw new Error(`Не найдена папка modules в ${dataDir}. Укажите --data`);
  log(`Ищу модули с картами в ${dataDir}…`);
  const old = fs.existsSync(CONFIG_FILE) ? JSON.parse(await fsp.readFile(CONFIG_FILE, "utf8")) : null;
  const previous = new Map((old?.modules ?? []).map(m => [m.id, m]));
  const modules = [];
  for (const mod of await readModules(dataDir)) {
    const text = `${mod.id} ${mod.json.title ?? ""}`;
    let scenes = 0;
    let withMap = 0;
    for (const pack of mod.packs) {
      try {
        for (const s of await readPack(mod.dir, pack)) {
          scenes++;
          const bg = backgroundOf(s.data);
          if (bg && !CORE_PREFIXES.some(p => bg.startsWith(p))) withMap++;
        }
      } catch (err) {
        warn(`${mod.id}/${pack.name}: ${err.message}`);
      }
    }
    const byName = MAP_WORDS.test(text);
    if (!scenes && !byName) continue;
    const reason = [byName ? "имя" : null, withMap ? `${withMap} сцен с картами` : null].filter(Boolean).join(", ") || "есть компендиум сцен";
    const prev = previous.get(mod.id);
    modules.push({
      id: mod.id,
      title: mod.json.title ?? mod.id,
      author: prev?.author ?? moduleAuthor(mod.json),
      scenes,
      include: prev?.include ?? (withMap > 0 || (byName && scenes > 0)),
      loose: prev?.loose ?? true,
      reason
    });
  }
  modules.sort((a, b) => Number(b.include) - Number(a.include) || a.title.localeCompare(b.title));
  const config = {
    data: dataDir,
    out: args.out ? path.resolve(args.out) : old?.out ?? "",
    convertImages: old?.convertImages ?? true,
    convertAudio: old?.convertAudio ?? true,
    webpQuality: old?.webpQuality ?? 85,
    audioBitrate: old?.audioBitrate ?? 128,
    maxVideoHeight: old?.maxVideoHeight ?? 1080,
    looseCategories: old?.looseCategories ?? ["maps", "tokens", "tiles", "music", "ambience", "sfx"],
    modules
  };
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  log("");
  for (const m of modules) log(`${m.include ? "[x]" : "[ ]"} ${m.title}  (${m.id}) · автор: ${m.author} · сцен: ${m.scenes} · ${m.reason}`);
  log("");
  log(`Найдено модулей: ${modules.length}, выбрано: ${modules.filter(m => m.include).length}.`);
  log(`Список сохранён в ${CONFIG_FILE}. Поправьте "include", "author" и "out", затем запустите run.`);
}

/* -------------------------------------------- */
/*  Conversion                                  */
/* -------------------------------------------- */

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", d => { err += d; });
    p.on("error", reject);
    p.on("close", code => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `ffmpeg ${code}`))));
  });
}

async function videoHeight(file) {
  // ffmpeg prints the stream info to stderr; no ffprobe needed.
  return new Promise(resolve => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", d => { err += d; });
    p.on("close", () => resolve(Number(err.match(/Video:.*?(\d{3,5})x(\d{3,5})/)?.[2]) || 0));
    p.on("error", () => resolve(0));
  });
}

/**
 * Write `src` to `dest` (converted when asked). Returns the final file name.
 * Writes to a temporary name first so Google Drive never uploads half a file.
 */
async function produce(src, destDir, name, config) {
  const e = ext(name);
  let outName = name;
  let job;
  if (config.convertImages && TO_WEBP.includes(e)) {
    outName = `${stem(name)}.webp`;
    job = async tmp => {
      const img = sharp(src, { limitInputPixels: false });
      const meta = await img.metadata();
      if (Math.max(meta.width ?? 0, meta.height ?? 0) > 16383) throw Object.assign(new Error("too large for webp"), { keep: true });
      await img.webp({ quality: config.webpQuality, effort: 4 }).toFile(tmp);
    };
  } else if (config.convertAudio && TO_OGG.includes(e)) {
    outName = `${stem(name)}.ogg`;
    job = tmp => runFfmpeg(["-i", src, "-vn", "-c:a", "libopus", "-b:a", `${config.audioBitrate}k`, "-f", "ogg", tmp]);
  } else if (EXT.video.includes(e) && config.maxVideoHeight && (await videoHeight(src)) > config.maxVideoHeight) {
    // Only a 4K version exists: make a Full HD webm.
    outName = `${stem(name).replace(UHD_RE, "$1FHD")}.webm`;
    job = tmp => runFfmpeg(["-i", src, "-vf", `scale=-2:${config.maxVideoHeight}`, "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0",
      "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-an", "-f", "webm", tmp]);
  }
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, outName);
  const tmp = `${dest}.akpart`;
  try {
    if (job) await job(tmp);
    else await fsp.copyFile(src, tmp);
    await fsp.rename(tmp, dest);
    return outName;
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (!job) throw err;
    warn(`${path.basename(src)}: конвертация не удалась (${err.message}), копирую как есть`);
    await fsp.copyFile(src, path.join(destDir, name));
    return name;
  }
}

/* -------------------------------------------- */
/*  Run                                         */
/* -------------------------------------------- */

class State {
  constructor(data) {
    this.files = data?.files ?? {}; // source key -> relative dest path
    this.scenes = data?.scenes ?? {}; // scene key -> relative json path
    this.names = data?.names ?? {}; // lower-case shared asset name -> source key
    this.dirty = 0;
  }
  static async load() {
    try {
      return new State(JSON.parse(await fsp.readFile(STATE_FILE, "utf8")));
    } catch (err) {
      return new State();
    }
  }
  async save(force = false) {
    if (!force && ++this.dirty < 25) return;
    this.dirty = 0;
    const tmp = `${STATE_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ files: this.files, scenes: this.scenes, names: this.names }));
    await fsp.rename(tmp, STATE_FILE);
  }
}

/** Resolve a path written in a scene to a file under Data. */
function localFile(dataDir, p) {
  let clean = String(p).split("?")[0].replace(/^\/+/, "");
  try {
    clean = decodeURIComponent(clean);
  } catch (err) { /* keep */ }
  const full = path.join(dataDir, ...clean.split("/"));
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

const variantKey = name => stem(name).toLowerCase().replace(UHD_RE, " ").replace(FHD_RE, " ").replace(/[^a-z0-9а-я]+/gi, "");

/** For a 4K video, the Full HD file next to it (Czepeku ships both), if there is one. */
function fhdSibling(file) {
  if (!UHD_RE.test(path.basename(file))) return null;
  const dir = path.dirname(file);
  const key = variantKey(file);
  for (const f of fs.readdirSync(dir)) {
    if (f !== path.basename(file) && kindOf(f) === "video" && FHD_RE.test(f) && variantKey(f) === key) return path.join(dir, f);
  }
  return null;
}

function collectPaths(data, found = new Set()) {
  if (typeof data === "string") {
    if (MEDIA_RE.test(data) && !/^(https?:|data:|blob:)/i.test(data) && !CORE_PREFIXES.some(p => data.startsWith(p))) found.add(data);
  } else if (Array.isArray(data)) data.forEach(v => collectPaths(v, found));
  else if (data && typeof data === "object") Object.values(data).forEach(v => collectPaths(v, found));
  return found;
}

function replacePaths(data, map) {
  if (typeof data === "string") return map.has(data) ? map.get(data) : data;
  if (Array.isArray(data)) return data.map(v => replacePaths(v, map));
  if (data && typeof data === "object") return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, replacePaths(v, map)]));
  return data;
}

async function guessCategory(file, rel) {
  const kind = kindOf(file);
  const text = rel.toLowerCase();
  if (kind === "audio") {
    if (/ambien|атмосф|окруж/.test(text)) return "ambience";
    if (/sfx|effect|эффект|door|двер/.test(text)) return "sfx";
    return "music";
  }
  if (kind === "video") return "maps";
  if (kind !== "image") return null;
  if (/token|токен/.test(text)) return "tokens";
  if (/tile|asset|prop|тайл|ассет/.test(text)) return "tiles";
  if (/maps?\/|карт|battle|scene/.test(text)) return "maps";
  try {
    const { width = 0, height = 0 } = await sharp(file, { limitInputPixels: false }).metadata();
    if (Math.min(width, height) >= 1000) return "maps";
    if (Math.max(width, height) <= 600 && Math.abs(width - height) <= 0.1 * width) return "tokens";
    return "tiles";
  } catch (err) {
    return "other";
  }
}

async function walkFiles(dir, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["packs", "node_modules", ".git"].includes(entry.name)) await walkFiles(full, out);
    } else if (kindOf(entry.name) !== "other") out.push(full);
  }
  return out;
}

async function run(args) {
  if (!fs.existsSync(CONFIG_FILE)) {
    log("Сначала выполните scan, он найдёт модули и создаст список.");
    return scan(args).then(() => run(args));
  }
  const config = JSON.parse(await fsp.readFile(CONFIG_FILE, "utf8"));
  if (args.data) config.data = path.resolve(args.data);
  if (args.out) config.out = path.resolve(args.out);
  if (args["no-convert"]) config.convertImages = config.convertAudio = false;
  const only = args.modules ? new Set(String(args.modules).split(",").map(s => s.trim())) : null;
  if (!config.out) throw new Error(`Укажите папку Google Drive: --out "G:\\Мой диск\\…" или поле "out" в ${CONFIG_FILE}`);
  const outRoot = config.out;
  if (!fs.existsSync(outRoot)) throw new Error(`Папка ${outRoot} не найдена. Это должна быть папка библиотеки на диске Google Drive (та, что указана в настройках модуля).`);
  const dataDir = config.data;
  const workers = Math.max(1, Number(args.jobs) || Math.max(2, Math.floor(os.cpus().length / 2)));
  const dry = !!args["dry-run"];
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  const state = await State.load();
  const stats = { scenes: 0, scenesSkipped: 0, files: 0, filesSkipped: 0, inBytes: 0, outBytes: 0, missing: 0, skipped4k: 0 };
  let stopping = false;
  process.on("SIGINT", async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("\nОстанавливаюсь после текущих файлов… (Ctrl+C ещё раз, чтобы выйти сразу)");
  });

  const chosen = (await readModules(dataDir)).filter(m => {
    const c = config.modules.find(x => x.id === m.id);
    return only ? only.has(m.id) : c?.include;
  });
  log(`Модулей к переносу: ${chosen.length}. Папка: ${outRoot}. Параллельно: ${workers}.${dry ? " Пробный прогон." : ""}`);

  // A copy of one source file in the library; shared assets are written once.
  const usedInFolder = new Map(); // dest dir -> Map(lower name -> source key)
  const sourceKey = async file => {
    const st = await fsp.stat(file);
    return `${path.relative(dataDir, file).split(path.sep).join("/")}|${st.size}|${Math.round(st.mtimeMs)}`;
  };
  const uniqueName = (dir, name, key, global) => {
    if (!usedInFolder.has(dir)) usedInFolder.set(dir, new Map());
    const used = usedInFolder.get(dir);
    let candidate = name;
    for (let n = 2; ; n++) {
      const lower = candidate.toLowerCase();
      const owner = used.get(lower) ?? (global ? state.names[lower] : undefined);
      const onDisk = !owner && fs.existsSync(path.join(dir, candidate));
      if ((!owner && !onDisk) || owner === key) break;
      candidate = `${stem(name)}-${n}.${ext(name)}`;
    }
    used.set(candidate.toLowerCase(), key);
    if (global) state.names[candidate.toLowerCase()] = key;
    return candidate;
  };
  /** Put one file into `relDir` (relative to the library). Returns its final name. */
  const inFlight = new Map(); // source key -> promise, so a file shared by two scenes is written once
  const place = async (file, relDir, wantName, options = {}) => {
    const key = await sourceKey(file);
    if (!inFlight.has(key)) inFlight.set(key, placeOnce(file, key, relDir, wantName, options));
    return inFlight.get(key);
  };
  const placeOnce = async (file, key, relDir, wantName, { global = false } = {}) => {
    const done = state.files[key];
    if (done && fs.existsSync(path.join(outRoot, done))) {
      stats.filesSkipped++;
      return path.basename(done);
    }
    const destDir = path.join(outRoot, ...relDir);
    // The final name depends on the conversion; reserve the name the file will have.
    const e = ext(wantName);
    const target = config.convertImages && TO_WEBP.includes(e) ? "webp" : config.convertAudio && TO_OGG.includes(e) ? "ogg" : e;
    const reserved = uniqueName(destDir, `${stem(wantName)}.${target}`, key, global);
    if (dry) return reserved;
    const name = await produce(file, destDir, `${stem(reserved)}.${e}`, config);
    const rel = [...relDir, name].join("/");
    state.files[key] = rel;
    stats.files++;
    stats.inBytes += (await fsp.stat(file)).size;
    stats.outBytes += (await fsp.stat(path.join(outRoot, ...relDir, name))).size;
    await state.save();
    return name;
  };

  for (const mod of chosen) {
    if (stopping) break;
    const c = config.modules.find(x => x.id === mod.id) ?? {};
    const author = sanitize(c.author || moduleAuthor(mod.json));
    const title = sanitize(mod.json.title ?? mod.id);
    log(`\n=== ${mod.json.title ?? mod.id} → Maps/${author}`);
    const scenes = [];
    for (const pack of mod.packs) {
      try {
        for (const s of await readPack(mod.dir, pack)) scenes.push({ ...s, key: `${mod.id}/${pack.name}/${s.data._id ?? s.name}` });
      } catch (err) {
        warn(`${pack.name}: компендиум не читается (${err.message})`);
      }
    }
    // Media files of the module that no scene uses (maps without scenes, tokens, music).
    const used = new Set();
    for (const s of scenes) for (const p of collectPaths(s.data)) {
      const f = localFile(dataDir, p);
      if (f) used.add(f);
    }
    const looseAll = c.loose === false ? [] : (await walkFiles(mod.dir)).filter(f => !used.has(f));
    const loose = [];
    for (const f of looseAll) {
      // 4K versions are skipped, the Full HD ones are enough.
      if (kindOf(f) === "video" && UHD_RE.test(path.basename(f))) {
        stats.skipped4k++;
        continue;
      }
      const category = await guessCategory(f, path.relative(mod.dir, f).split(path.sep).join("/"));
      if (category && config.looseCategories.includes(category)) loose.push({ file: f, category });
    }
    const existing = fs.existsSync(path.join(outRoot, "Maps", author))
      ? (await fsp.readdir(path.join(outRoot, "Maps", author), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
      : [];
    const groups = groupNames([...scenes.map(s => s.name), ...loose.filter(l => l.category === "maps").map(l => path.basename(l.file))], existing);

    let i = 0;
    await mapLimit(scenes, Math.min(2, workers), async scene => {
      if (stopping) return;
      const n = ++i;
      if (state.scenes[scene.key] && fs.existsSync(path.join(outRoot, state.scenes[scene.key]))) {
        stats.scenesSkipped++;
        return;
      }
      const pack = sanitize(scene.name || "Scene");
      const relDir = ["Maps", author, sanitize(groups.get(scene.name) ?? pack)];
      const data = structuredClone(scene.data);
      for (const k of ["_id", "_stats", "ownership", "folder", "thumb", "sort"]) delete data[k];
      data.active = false;
      const main = backgroundOf(data);
      const paths = [...collectPaths(data)];
      const map = new Map();
      await mapLimit(paths, workers, async p => {
        let file = localFile(dataDir, p);
        if (!file) {
          stats.missing++;
          warn(`${scene.name}: нет файла ${p}`);
          return;
        }
        if (kindOf(file) === "video") file = fhdSibling(file) ?? file;
        const isMain = p === main;
        const name = isMain ? `${pack}.${ext(file)}` : path.basename(file);
        try {
          map.set(p, await place(file, relDir, name, { global: !isMain }));
        } catch (err) {
          warn(`${scene.name}: ${path.basename(file)} не скопирован (${err.message})`);
        }
      });
      const json = replacePaths(data, map);
      json.flags = { ...(json.flags ?? {}), "akella-search": { ...(json.flags?.["akella-search"] ?? {}), exportedFrom: "akella-export", author, module: mod.id } };
      if (!dry) {
        const dir = path.join(outRoot, ...relDir);
        await fsp.mkdir(dir, { recursive: true });
        const jsonName = `${pack}.json`;
        await fsp.writeFile(path.join(dir, `${jsonName}.akpart`), JSON.stringify(json, null, 2));
        await fsp.rename(path.join(dir, `${jsonName}.akpart`), path.join(dir, jsonName));
        state.scenes[scene.key] = [...relDir, jsonName].join("/");
        await state.save();
      }
      stats.scenes++;
      log(`  [${n}/${scenes.length}] ${scene.name} → ${relDir.join("/")}`);
    });

    let j = 0;
    await mapLimit(loose, workers, async ({ file, category }) => {
      if (stopping) return;
      const name = path.basename(file);
      const relDir = category === "maps"
        ? ["Maps", author, sanitize(groups.get(name) ?? stem(name))]
        : [CATEGORIES[category], author, title];
      try {
        await place(file, relDir, name);
      } catch (err) {
        warn(`${name}: не скопирован (${err.message})`);
      }
      if (++j % 50 === 0 || j === loose.length) log(`  файлы ${j}/${loose.length}`);
    });
  }
  await state.save(true);
  log(`\nГотово${stopping ? " (остановлено, запустите run ещё раз, чтобы продолжить)" : ""}.`);
  log(`Сцен: ${stats.scenes} новых, ${stats.scenesSkipped} уже были. Файлов: ${stats.files} новых, ${stats.filesSkipped} уже были.`);
  if (stats.files) log(`Было ${fmtBytes(stats.inBytes)}, стало ${fmtBytes(stats.outBytes)} (${Math.round(100 - (100 * stats.outBytes) / Math.max(1, stats.inBytes))}% экономии).`);
  if (stats.skipped4k) log(`Пропущено 4K-видео: ${stats.skipped4k}.`);
  if (stats.missing) log(`Не найдено файлов, на которые ссылаются сцены: ${stats.missing} (подробно в ${LOG_FILE}).`);
  log("Когда Google Drive догрузит файлы, нажмите в Foundry «Обновить индекс» в окне Akella Search.");
  logStream.end();
}

/* -------------------------------------------- */

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const commands = { scan, run };
if (!commands[command]) {
  console.log(`Akella Export

  node index.mjs scan --data "<папка Data Foundry>" --out "<папка библиотеки на Google Drive>"
      найти модули с картами и записать список в akella-export.config.json

  node index.mjs run [--modules id1,id2] [--jobs 4] [--dry-run] [--no-convert]
      перенести выбранные модули (можно прервать Ctrl+C и запустить снова)

По умолчанию --data = ${defaultDataDir()}`);
} else {
  commands[command](args).catch(err => {
    console.error(`\nОшибка: ${err.message}`);
    process.exitCode = 1;
  });
}
