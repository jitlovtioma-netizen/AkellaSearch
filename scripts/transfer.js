/**
 * Bulk transfer to Drive: copy every scene of an installed map module (Scene or Adventure
 * compendiums), or of the current world, into Maps/<Author>/<Scene>/ as scene packs.
 * Optionally also copies the module's loose media files (maps, tokens, music without scenes).
 */
import { DialogV2, FilePickerClass, esc, localize, notify, notifyProgress } from "./compat.js";
import { getSetting, setSetting } from "./settings.js";
import * as drive from "./drive.js";
import { classify } from "./media-index.js";
import { UploadSession, authorDatalist, destination, guessCategory } from "./uploader.js";
import { exportSceneData } from "./scene-packs.js";

const WORLD = "__world";

function scenePacksOf(moduleId) {
  return game.packs.filter(p => p.metadata.packageType === "module" && p.metadata.packageName === moduleId
    && ["Scene", "Adventure"].includes(p.documentName));
}

function sources() {
  const list = [{ id: WORLD, title: localize("Transfer.World"), count: game.scenes.size }];
  for (const mod of game.modules) {
    if (!mod.active) continue;
    const packs = scenePacksOf(mod.id);
    if (packs.length) list.push({ id: mod.id, title: mod.title, packs });
  }
  return list;
}

/** Every scene of a source as { key, name, load() }. */
async function listScenes(sourceId) {
  if (sourceId === WORLD) return game.scenes.contents.map(s => ({ key: s.id, name: s.name, load: async () => s.toObject() }));
  const items = [];
  for (const pack of scenePacksOf(sourceId)) {
    if (pack.documentName === "Scene") {
      const index = await pack.getIndex();
      for (const e of index) items.push({ key: `${pack.collection}.${e._id}`, name: e.name, load: async () => (await pack.getDocument(e._id)).toObject() });
    } else {
      const adventures = await pack.getDocuments();
      for (const adv of adventures) {
        const scenes = adv.toObject().scenes ?? [];
        for (const s of scenes) items.push({ key: `${adv.uuid}.${s._id}`, name: `${s.name} (${adv.name})`, load: async () => s });
      }
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function browseAll(dir) {
  const FP = FilePickerClass();
  const files = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift();
    try {
      const result = await FP.browse("data", current);
      files.push(...result.files);
      queue.push(...result.dirs);
    } catch (err) {
      console.warn(`Cannot browse ${current}`, err);
    }
  }
  return files;
}

function moduleAuthor(mod) {
  const authors = [...(mod?.authors ?? [])].map(a => a.name).filter(Boolean);
  return authors[0] ?? mod?.title ?? "";
}

export async function openTransfer() {
  if (!drive.isSignedIn()) {
    try {
      await drive.signIn();
    } catch (err) {
      return ui.notifications.error(err.message);
    }
  }
  const list = sources();
  const options = list.map(s => `<option value="${esc(s.id)}">${esc(s.title)}${s.packs ? ` — ${s.packs.length} ${localize("Transfer.Packs")}` : ""}</option>`).join("");
  const step1 = await DialogV2().wait({
    window: { title: localize("Transfer.Title"), icon: "fa-solid fa-truck-ramp-box" },
    content: `<form class="gdms-dialog">
      <p class="hint">${localize("Transfer.Intro")}</p>
      <div class="form-group"><label>${localize("Transfer.Source")}</label><select name="source">${options}</select></div>
      <div class="form-group"><label>${localize("Upload.Author")}</label><input type="text" name="author" placeholder="${localize("Transfer.AuthorPlaceholder")}" list="gdms-transfer-authors"></div>
      <div class="form-group"><label><input type="checkbox" name="loose"> ${localize("Transfer.Loose")}</label></div>
      <div class="form-group"><label><input type="checkbox" name="convert" ${getSetting("convertImages") || getSetting("convertAudio") ? "checked" : ""}> ${localize("Upload.Convert")}</label></div>
      ${authorDatalist("gdms-transfer-authors")}
    </form>`,
    buttons: [{
      action: "next", label: localize("Transfer.Next"), icon: "fa-solid fa-arrow-right", default: true,
      callback: (ev, b) => {
        const f = b.form.elements;
        return { source: f.source.value, author: f.author.value.trim(), loose: f.loose.checked, convert: f.convert.checked };
      }
    }, { action: "cancel", label: localize("Cancel") }],
    rejectClose: false
  });
  if (!step1 || step1 === "cancel") return;

  const mod = step1.source === WORLD ? null : game.modules.get(step1.source);
  const author = step1.author || (mod ? moduleAuthor(mod) : game.world.title);
  const scenes = await listScenes(step1.source);
  if (!scenes.length && !step1.loose) return notify("warn", "Transfer.NoScenes");

  const rows = scenes.map((s, i) => `<label class="gdms-check"><input type="checkbox" name="s${i}" checked> ${esc(s.name)}</label>`).join("");
  const step2 = scenes.length ? await DialogV2().wait({
    window: { title: `${localize("Transfer.Title")}: ${mod?.title ?? game.world.title}`, icon: "fa-solid fa-truck-ramp-box" },
    position: { width: 520 },
    content: `<form class="gdms-dialog">
      <p>${localize("Transfer.Choose", { count: scenes.length, author: esc(author) })}</p>
      <p><a class="gdms-toggle-all">${localize("Transfer.ToggleAll")}</a></p>
      <div class="gdms-checklist">${rows}</div>
    </form>`,
    render: (event, dialog) => {
      const el = dialog.element ?? event?.target?.element;
      el?.querySelector(".gdms-toggle-all")?.addEventListener("click", () => {
        const boxes = [...el.querySelectorAll(".gdms-checklist input")];
        const all = boxes.every(b => b.checked);
        boxes.forEach(b => { b.checked = !all; });
      });
    },
    buttons: [{
      action: "go", label: localize("Transfer.Start"), icon: "fa-solid fa-cloud-arrow-up", default: true,
      callback: (ev, b) => scenes.filter((s, i) => b.form.elements[`s${i}`].checked)
    }, { action: "cancel", label: localize("Cancel") }],
    rejectClose: false
  }) : [];
  if (!Array.isArray(step2)) return;
  if (step1.author) await setSetting("lastAuthor", step1.author);

  const session = new UploadSession({ convert: step1.convert });
  const progress = notifyProgress(localize("Transfer.Running"));
  let exported = 0;
  const failed = [];
  try {
    for (const [i, item] of step2.entries()) {
      progress.update(`${localize("Transfer.Scene")} ${i + 1}/${step2.length}: ${item.name}`);
      try {
        await exportSceneData(await item.load(), { author, packName: item.name.replace(/\s*\([^)]*\)$/, ""), session });
        exported++;
      } catch (err) {
        console.error(err);
        failed.push(item.name);
      }
    }
    let loose = 0;
    if (step1.loose && mod) {
      const files = (await browseAll(`modules/${mod.id}`)).filter(p => ["image", "video", "audio"].includes(classify({ name: p })));
      for (const [i, path] of files.entries()) {
        progress.update(`${localize("Transfer.Files")} ${i + 1}/${files.length}`);
        if (session.sources.has(path)) continue; // already uploaded as part of a scene
        let response = await fetch(encodeURI(path)).catch(() => null);
        if (!response?.ok) response = await fetch(path).catch(() => null);
        if (!response?.ok) continue;
        const blob = await response.blob();
        const name = decodeURIComponent(path.split("/").pop());
        const category = await guessCategory(blob, name, path);
        const rel = path.split("/").slice(2, -1).join(" ").trim();
        const segments = destination(category, author, category === "maps" ? `${mod.title} ${rel}`.trim() : mod.title, name);
        await session.put(blob, name, segments, { sourceKey: path });
        loose++;
      }
    }
    await session.finish();
    notify("info", "Transfer.Done", { scenes: exported, files: session.uploaded, loose });
    if (failed.length) notify("warn", "Transfer.Failed", { count: failed.length, names: failed.join(", ") });
  } catch (err) {
    console.error(err);
    ui.notifications.error(err.message);
    await session.finish();
  } finally {
    progress.close();
  }
}
