/**
 * Minimal Google Drive v3 client for the browser.
 *
 * Reading works with either an API key (the folder must be shared as "anyone with the link")
 * or an OAuth access token. Uploading always needs an OAuth token, obtained with
 * Google Identity Services in a popup.
 */
import { MODULE_ID, mapLimit } from "./compat.js";
import { getSetting } from "./settings.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/drive";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,md5Checksum,parents,webViewLink";
const TOKEN_KEY = `${MODULE_ID}.token`;

let token = null;
let gisPromise = null;

/** Accept a folder id or any Drive folder URL. */
export function parseFolderId(value) {
  const str = String(value ?? "").trim();
  const match = str.match(/folders\/([\w-]+)/) ?? str.match(/[?&]id=([\w-]+)/);
  return match ? match[1] : str;
}

export function rootFolderId() {
  return parseFolderId(getSetting("rootFolder"));
}

/* -------------------------------------------- */
/*  Authentication                              */
/* -------------------------------------------- */

export function isSignedIn() {
  return !!token && token.expiresAt > Date.now();
}

export function canSignIn() {
  return !!getSetting("oauthClientId");
}

export function restoreToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    if (saved?.expiresAt > Date.now()) token = saved;
  } catch (err) { /* ignore */ }
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.accessToken, () => {});
  token = null;
  sessionStorage.removeItem(TOKEN_KEY);
  Hooks.callAll(`${MODULE_ID}.authChanged`, false);
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      gisPromise = null;
      reject(new Error("Failed to load Google Identity Services"));
    };
    document.head.append(script);
  });
  return gisPromise;
}

/** Load the Google sign-in library ahead of time, so the popup opens directly from the click. */
export function preload() {
  if (getSetting("oauthClientId")) loadGis().catch(err => console.warn(`${MODULE_ID} |`, err));
}

/** Open the Google sign-in popup. Must be called from a user gesture (a click). */
export async function signIn() {
  const clientId = getSetting("oauthClientId");
  if (!clientId) throw new Error(game.i18n.localize("GDMS.Errors.NoClientId"));
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: response => {
        if (response.error) return reject(new Error(response.error_description ?? response.error));
        token = { accessToken: response.access_token, expiresAt: Date.now() + ((response.expires_in ?? 3600) - 60) * 1000 };
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
        Hooks.callAll(`${MODULE_ID}.authChanged`, true);
        resolve(token);
      },
      error_callback: err => reject(new Error(err?.message ?? err?.type ?? "OAuth error"))
    });
    client.requestAccessToken();
  });
}

/* -------------------------------------------- */
/*  Requests                                    */
/* -------------------------------------------- */

function authorize(url, headers, { requireToken = false } = {}) {
  if (isSignedIn()) {
    headers.Authorization = `Bearer ${token.accessToken}`;
    return url;
  }
  if (requireToken) throw new Error(game.i18n.localize("GDMS.Errors.SignInRequired"));
  const key = getSetting("apiKey");
  if (!key) throw new Error(game.i18n.localize("GDMS.Errors.NoCredentials"));
  url.searchParams.set("key", key);
  return url;
}

async function request(path, { base = API, params = {}, method = "GET", body, headers = {}, requireToken = false, raw = false } = {}) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("supportsAllDrives", "true");
  authorize(url, headers, { requireToken });
  const response = await fetch(url, { method, body, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const json = await response.json();
      message = json.error?.message ?? message;
    } catch (err) { /* ignore */ }
    if (response.status === 401 && isSignedIn()) signOut();
    throw new Error(`Google Drive: ${message}`);
  }
  return raw ? response : response.json();
}

/** List the direct children of a folder. */
export async function listFolder(folderId) {
  const files = [];
  let pageToken;
  do {
    const params = {
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: "1000",
      includeItemsFromAllDrives: "true"
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await request("/files", { params });
    files.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Walk the whole folder tree.
 * @returns {Promise<object[]>} Files and folders, each with a `path` (parent folder path, "" for root).
 */
export async function crawl(rootId, onProgress) {
  const results = [];
  let queue = [{ id: rootId, path: "" }];
  let scanned = 0;
  while (queue.length) {
    const nextQueue = [];
    await mapLimit(queue, 4, async folder => {
      const children = await listFolder(folder.id);
      scanned++;
      for (const file of children) {
        const entry = { ...file, path: folder.path, folderId: folder.id };
        results.push(entry);
        if (file.mimeType === FOLDER_MIME) nextQueue.push({ id: file.id, path: folder.path ? `${folder.path}/${file.name}` : file.name });
      }
      onProgress?.({ scanned, found: results.length });
    });
    queue = nextQueue;
  }
  return results;
}

export async function download(fileId) {
  const response = await request(`/files/${fileId}`, { params: { alt: "media" }, raw: true });
  return response.blob();
}

export async function findChild(parentId, name, { folder = false } = {}) {
  const safe = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  let q = `'${parentId}' in parents and name = '${safe}' and trashed = false`;
  if (folder) q += ` and mimeType = '${FOLDER_MIME}'`;
  const data = await request("/files", { params: { q, fields: `files(${FILE_FIELDS})`, includeItemsFromAllDrives: "true" } });
  return data.files[0] ?? null;
}

export async function createFolder(name, parentId) {
  return request("/files", {
    method: "POST",
    params: { fields: FILE_FIELDS },
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    requireToken: true
  });
}

export async function ensureFolder(name, parentId) {
  return (await findChild(parentId, name, { folder: true })) ?? createFolder(name, parentId);
}

/**
 * Upload a file with the resumable protocol, so large maps (over 5 MB) work too.
 * When a file with the same name exists in the folder and `overwrite` is true, its content is replaced.
 */
export async function uploadFile(blob, name, parentId, { overwrite = true } = {}) {
  const mimeType = blob.type || "application/octet-stream";
  const existing = overwrite ? await findChild(parentId, name) : null;
  const path = existing ? `/files/${existing.id}` : "/files";
  const metadata = existing ? { name } : { name, parents: [parentId] };
  const init = await request(path, {
    base: UPLOAD_API,
    method: existing ? "PATCH" : "POST",
    params: { uploadType: "resumable", fields: FILE_FIELDS },
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mimeType },
    body: JSON.stringify(metadata),
    requireToken: true,
    raw: true
  });
  const location = init.headers.get("Location");
  if (!location) throw new Error("Google Drive: no upload session URL");
  const response = await fetch(location, { method: "PUT", headers: { "Content-Type": mimeType }, body: blob });
  if (!response.ok) throw new Error(`Google Drive: upload failed (${response.status})`);
  return response.json();
}

/** Thumbnail URL that works for files shared by link (and for the signed-in owner). */
export function thumbnailUrl(fileId, size = 320) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}
