/**
 * The media search window, in the spirit of Moulinette Media Search.
 */
import { MODULE_ID, DialogV2, ImagePopoutClass, esc, localize, notify } from "./compat.js";
import { getSetting } from "./settings.js";
import * as drive from "./drive.js";
import { cachedPath, ensureLocal } from "./cache.js";
import { KINDS, mediaIndex } from "./media-index.js";
import { createSceneFromMedia, importPack } from "./scene-packs.js";
import { convertExisting, filesFromDrop, regroupFolders, uploadWithDialog } from "./uploader.js";
import { openTransfer } from "./transfer.js";
import { DRAG_TYPE, placeMedia, viewCenter } from "./placement.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const PAGE = 120;
const ICONS = { image: "fa-image", video: "fa-film", audio: "fa-music", scene: "fa-map", other: "fa-file" };

export class MediaBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "gdms-browser",
    classes: ["gdms"],
    window: { title: "GDMS.Title", icon: "fa-brands fa-google-drive", resizable: true },
    position: { width: 960, height: 720 },
    actions: {
      refreshIndex: MediaBrowser.#onRefreshIndex,
      signIn: MediaBrowser.#onSignIn,
      signOut: MediaBrowser.#onSignOut,
      upload: MediaBrowser.#onUpload,
      settings: MediaBrowser.#onSettings,
      loadMore: MediaBrowser.#onLoadMore,
      setFolder: MediaBrowser.#onSetFolder,
      preview: MediaBrowser.#onPreview,
      play: MediaBrowser.#onPlay,
      place: MediaBrowser.#onPlace,
      copyPath: MediaBrowser.#onCopyPath,
      createScene: MediaBrowser.#onCreateScene,
      importPack: MediaBrowser.#onImportPack,
      addToPlaylist: MediaBrowser.#onAddToPlaylist,
      openDrive: MediaBrowser.#onOpenDrive,
      transfer: MediaBrowser.#onTransfer,
      convertDrive: MediaBrowser.#onConvertDrive,
      regroup: MediaBrowser.#onRegroup
    }
  };

  static PARTS = {
    header: { template: `modules/${MODULE_ID}/templates/browser-header.hbs` },
    results: { template: `modules/${MODULE_ID}/templates/browser-results.hbs`, scrollable: [""] }
  };

  static #instance;

  static open() {
    this.#instance ??= new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  static refresh() {
    if (this.#instance?.rendered) this.#instance.render();
  }

  state = { query: "", kind: "all", folder: "", limit: PAGE };
  #progress = "";
  #sound = null;

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const results = mediaIndex.search(this.state);
    const items = results.slice(0, this.state.limit).map(e => this.#card(e));
    const builtAt = getSetting("indexBuiltAt");
    return {
      state: this.state,
      isGM: game.user.isGM,
      signedIn: drive.isSignedIn(),
      canSignIn: drive.canSignIn(),
      canUpload: game.user.isGM && drive.isSignedIn(),
      kinds: [{ value: "all", label: localize("Kind.all") }, ...KINDS.map(k => ({ value: k, label: localize(`Kind.${k}`) }))],
      folders: mediaIndex.folders,
      loaded: mediaIndex.loaded,
      building: mediaIndex.building,
      progress: this.#progress,
      status: mediaIndex.loaded
        ? localize("Status.Indexed", { count: mediaIndex.entries.filter(e => e.kind !== "folder").length, date: builtAt ? new Date(builtAt).toLocaleString() : "—" })
        : localize("Status.NoIndex"),
      items,
      total: results.length,
      hasMore: results.length > items.length
    };
  }

  #card(entry) {
    const local = cachedPath(entry);
    const pack = mediaIndex.packFor(entry);
    let thumb = null;
    if (entry.kind === "image") thumb = local ?? drive.thumbnailUrl(entry.id);
    else if (entry.kind === "video") thumb = drive.thumbnailUrl(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      icon: ICONS[entry.kind] ?? ICONS.other,
      thumb,
      cached: !!local,
      hasPack: !!pack,
      isVisual: entry.kind === "image" || entry.kind === "video",
      isAudio: entry.kind === "audio",
      isScene: entry.kind === "scene",
      isGM: game.user.isGM
    };
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const html = this.element;
    if (options.parts?.includes("header")) {
      const search = html.querySelector("input[name=query]");
      const run = foundry.utils.debounce(() => {
        this.state.query = search.value;
        this.state.limit = PAGE;
        this.render({ parts: ["results"] });
      }, 250);
      search?.addEventListener("input", run);
      for (const name of ["kind", "folder"]) {
        html.querySelector(`select[name=${name}]`)?.addEventListener("change", ev => {
          this.state[name] = ev.currentTarget.value;
          this.state.limit = PAGE;
          this.render({ parts: ["results"] });
        });
      }
      html.querySelector("input[name=files]")?.addEventListener("change", ev => {
        this.#uploadFiles([...ev.currentTarget.files]);
        ev.currentTarget.value = "";
      });
    }
    if (options.parts?.includes("results")) {
      for (const card of html.querySelectorAll(".gdms-card[draggable=true]")) {
        card.addEventListener("dragstart", ev => {
          ev.dataTransfer.setData("text/plain", JSON.stringify({ type: DRAG_TYPE, id: card.dataset.id }));
        });
      }
    }
    if (!this._dropBound) {
      this._dropBound = true;
      html.addEventListener("dragover", ev => {
        if (ev.dataTransfer?.types?.includes("Files") && game.user.isGM) {
          ev.preventDefault();
          html.classList.add("gdms-dropping");
        }
      });
      html.addEventListener("dragleave", ev => {
        if (ev.target === html || !html.contains(ev.relatedTarget)) html.classList.remove("gdms-dropping");
      });
      html.addEventListener("drop", ev => {
        html.classList.remove("gdms-dropping");
        if (!ev.dataTransfer?.files?.length || !game.user.isGM) return;
        ev.preventDefault();
        // Read the entries now: the DataTransfer is emptied once the event returns.
        const pending = filesFromDrop(ev.dataTransfer);
        this.#run(async () => this.#uploadFiles(await pending));
      });
    }
  }

  _onClose(options) {
    super._onClose?.(options);
    this.#sound?.stop();
    this.#sound = null;
  }

  #entry(target) {
    const id = target.closest("[data-id]")?.dataset.id;
    return mediaIndex.get(id);
  }

  async #run(fn) {
    try {
      return await fn();
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(err.message);
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onRefreshIndex() {
    await this.#run(async () => {
      const work = mediaIndex.rebuild(({ scanned, found }) => {
        this.#progress = localize("Status.Scanning", { scanned, found });
        this.element?.querySelector(".gdms-status")?.replaceChildren(document.createTextNode(this.#progress));
      });
      this.render();
      await work;
    });
    this.#progress = "";
    this.render();
  }

  static async #onSignIn() {
    await this.#run(() => drive.signIn());
    this.render();
  }

  static async #onSignOut() {
    await this.#run(() => drive.signOut());
    this.render();
  }

  static #onUpload() {
    this.element.querySelector("input[name=files]")?.click();
  }

  static #onSettings() {
    const app = game.settings.sheet;
    app.render({ force: true });
    Hooks.once("renderSettingsConfig", (cfg, html) => {
      const el = html instanceof HTMLElement ? html : html[0];
      el?.querySelector(`[data-tab="${MODULE_ID}"], [data-category="${MODULE_ID}"]`)?.click();
    });
  }

  static #onLoadMore() {
    this.state.limit += PAGE;
    this.render({ parts: ["results"] });
  }

  static #onSetFolder(event, target) {
    this.state.folder = target.dataset.folder ?? "";
    this.state.limit = PAGE;
    this.render();
  }

  static async #onPreview(event, target) {
    const entry = this.#entry(target);
    if (!entry) return;
    await this.#run(async () => {
      const src = await ensureLocal(entry);
      const Popout = ImagePopoutClass();
      if (Popout.prototype instanceof ApplicationV2) new Popout({ src, window: { title: entry.name }, shareable: true }).render({ force: true });
      else new Popout(src, { title: entry.name, shareable: true }).render(true);
    });
    this.render({ parts: ["results"] });
  }

  static async #onPlay(event, target) {
    const entry = this.#entry(target);
    if (!entry) return;
    const wasPlaying = this.#sound?.gdmsId === entry.id;
    this.#sound?.stop();
    this.#sound = null;
    if (wasPlaying) return;
    await this.#run(async () => {
      const src = await ensureLocal(entry);
      const AudioHelper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      const sound = await AudioHelper.play({ src, volume: 0.6, loop: false }, false);
      if (sound) {
        sound.gdmsId = entry.id;
        this.#sound = sound;
      }
    });
  }

  static async #onPlace(event, target) {
    const entry = this.#entry(target);
    if (!entry) return;
    const { x, y } = viewCenter();
    await this.#run(() => placeMedia(entry, x, y));
  }

  static async #onCopyPath(event, target) {
    const entry = this.#entry(target);
    if (!entry) return;
    await this.#run(async () => {
      const path = await ensureLocal(entry);
      await game.clipboard.copyPlainText(path);
      notify("info", "Notify.Copied", { path });
    });
    this.render({ parts: ["results"] });
  }

  static async #onCreateScene(event, target) {
    const entry = this.#entry(target);
    if (entry) await this.#run(() => createSceneFromMedia(entry));
  }

  static async #onImportPack(event, target) {
    const entry = this.#entry(target);
    if (entry) await this.#run(() => importPack(entry));
  }

  static async #onAddToPlaylist(event, target) {
    const entry = this.#entry(target);
    if (!entry) return;
    const options = game.playlists.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    const content = `<form class="gdms-dialog"><div class="form-group"><label>${localize("Playlist.Choose")}</label>
      <select name="playlist">${options}<option value="__new">${localize("Playlist.New")}</option></select></div>
      <div class="form-group"><label><input type="checkbox" name="repeat"> ${localize("Playlist.Repeat")}</label></div></form>`;
    const choice = await DialogV2().wait({
      window: { title: localize("Playlist.Title") },
      content,
      buttons: [{
        action: "ok", label: localize("Playlist.Add"), default: true,
        callback: (ev, button) => ({ playlist: button.form.elements.playlist.value, repeat: button.form.elements.repeat.checked })
      }, { action: "cancel", label: localize("Cancel") }],
      rejectClose: false
    });
    if (!choice || choice === "cancel") return;
    await this.#run(async () => {
      const path = await ensureLocal(entry);
      let playlist = game.playlists.get(choice.playlist);
      playlist ??= await Playlist.implementation.create({ name: entry.path.split("/").pop() || "Google Drive" });
      const name = entry.name.replace(/\.[^.]+$/, "");
      await playlist.createEmbeddedDocuments("PlaylistSound", [{ name, path, repeat: choice.repeat, volume: 0.5 }]);
      notify("info", "Notify.AddedToPlaylist", { name, playlist: playlist.name });
    });
  }

  static async #onTransfer() {
    await this.#run(() => openTransfer());
  }

  static async #onRegroup() {
    await this.#run(() => regroupFolders(this.state.folder));
    this.render();
  }

  static async #onConvertDrive() {
    await this.#run(() => convertExisting(this.state.folder));
  }

  static #onOpenDrive(event, target) {
    const entry = this.#entry(target);
    if (entry) window.open(entry.webViewLink ?? `https://drive.google.com/file/d/${entry.id}/view`, "_blank", "noopener");
  }

  /* -------------------------------------------- */

  async #uploadFiles(files) {
    await this.#run(() => uploadWithDialog(files, this.state.folder));
    this.render();
  }
}
