/**
 * Minimal Google Drive v3 client for the browser.
 *
 * Reading works with either an API key (the folder must be shared as "anyone with the link")
 * or an OAuth access token. Uploading needs OAuth: the GM signs in once (authorization code
 * flow with PKCE), the refresh token is kept in this browser, and access tokens are renewed
 * silently, so long uploads never stop after an hour and no popup has to talk back to Foundry.
 */
import { MODULE_ID, mapLimit } from "./compat.js";
import { getSetting, setSetting } from "./settings.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/drive";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,md5Checksum,parents,webViewLink";
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

let token = null; // { accessToken, expiresAt }
let refreshing = null;
let pendingAuth = null; // { state, verifier }

/** Accept a folder id or any Drive folder URL. */
export function parseFolderId(value) {
  const str = String(value ?? "").trim();
  const match = str.match(/folders\/([\w-]+)/) ?? str.match(/[?&]id=([\w-]+)/);
  return match ? match[1] : str;
}

export function rootFolderId() {
  return parseFolderId(getSetting("rootFolder"));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* -------------------------------------------- */
/*  Authentication                              */
/* -------------------------------------------- */

/** The page Google sends the sign-in code to. It must be listed in "Authorized redirect URIs". */
export function redirectUri() {
  const path = `modules/${MODULE_ID}/oauth.html`;
  return `${window.location.origin}${foundry.utils.getRoute?.(path) ?? `/${path}`}`;
}

export function isSignedIn() {
  return !!getSetting("refreshToken") || (!!token && token.expiresAt > Date.now());
}

export function canSignIn() {
  return !!getSetting("oauthClientId");
}

export async function signOut() {
  const refresh = getSetting("refreshToken");
  token = null;
  await setSetting("refreshToken", "");
  if (refresh) fetch(`${REVOKE_URL}?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
  Hooks.callAll(`${MODULE_ID}.authChanged`, false);
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build the Google sign-in URL (PKCE). */
export async function beginAuth() {
  const clientId = getSetting("oauthClientId");
  if (!clientId) throw new Error(game.i18n.localize("GDMS.Errors.NoClientId"));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  let challenge = verifier;
  let method = "plain";
  if (crypto.subtle) {
    // Only available on https or localhost; elsewhere the plain method is used.
    challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    method = "S256";
  }
  pendingAuth = { state, verifier };
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: challenge,
    code_challenge_method: method,
    state
  }).toString();
  return { url: url.toString(), state };
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Google: ${json.error_description ?? json.error ?? response.status}`);
    error.code = json.error;
    throw error;
  }
  return json;
}

function storeAccessToken(json) {
  token = { accessToken: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) - 120) * 1000 };
}

/**
 * Finish sign-in with the code Google returned (pasted by the GM or picked up from the redirect page).
 * Accepts the bare code or the whole redirect URL.
 */
export async function completeAuth(input, state) {
  if (!pendingAuth) throw new Error("Sign-in was not started");
  let code = String(input ?? "").trim();
  if (code.includes("code=")) {
    const params = new URL(code, window.location.origin).searchParams;
    code = params.get("code") ?? "";
    state ??= params.get("state");
  }
  if (state && state !== pendingAuth.state) throw new Error("Google: state mismatch, start the sign-in again");
  const json = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: getSetting("oauthClientId"),
    client_secret: getSetting("oauthClientSecret"),
    redirect_uri: redirectUri(),
    code_verifier: pendingAuth.verifier
  });
  pendingAuth = null;
  storeAccessToken(json);
  if (json.refresh_token) await setSetting("refreshToken", json.refresh_token);
  Hooks.callAll(`${MODULE_ID}.authChanged`, true);
  return true;
}

/** A valid access token, renewed with the refresh token when needed. Null when not signed in. */
export async function accessToken({ force = false } = {}) {
  if (!force && token && token.expiresAt > Date.now()) return token.accessToken;
  const refresh = getSetting("refreshToken");
  if (!refresh) return null;
  refreshing ??= tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: getSetting("oauthClientId"),
    client_secret: getSetting("oauthClientSecret")
  }).then(json => {
    storeAccessToken(json);
    return token.accessToken;
  }).catch(async err => {
    if (err.code === "invalid_grant") {
      // Revoked, or expired (apps left in "Testing" lose refresh tokens after 7 days).
      await setSetting("refreshToken", "");
      Hooks.callAll(`${MODULE_ID}.authChanged`, false);
      throw new Error(game.i18n.localize("GDMS.Errors.SignInExpired"));
    }
    throw err;
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Open the sign-in dialog. */
export async function signIn() {
  const { openAuthDialog } = await import("./auth-dialog.js");
  return openAuthDialog();
}

/* -------------------------------------------- */
/*  Requests                                    */
/* -------------------------------------------- */

async function authorize(url, headers, { requireToken = false, force = false } = {}) {
  const access = await accessToken({ force });
  if (access) {
    headers.Authorization = `Bearer ${access}`;
    url.searchParams.delete("key");
    return;
  }
  const fail = key => Object.assign(new Error(game.i18n.localize(key)), { code: "auth" });
  if (requireToken) throw fail("GDMS.Errors.SignInRequired");
  const key = getSetting("apiKey");
  if (!key) throw fail("GDMS.Errors.NoCredentials");
  url.searchParams.set("key", key);
}

function backoff(attempt) {
  return Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 1000;
}

/** Fetch with retries for rate limits, server errors and dropped connections. */
async function fetchRetry(makeRequest) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await makeRequest(attempt);
    } catch (err) {
      if (attempt + 1 >= MAX_ATTEMPTS || err.code) throw err;
      await sleep(backoff(attempt));
      continue;
    }
    let retry = RETRY_STATUS.has(response.status);
    if (response.status === 403) {
      const text = await response.clone().text().catch(() => "");
      retry = /rateLimitExceeded|userRateLimitExceeded/.test(text);
    }
    if (!retry || attempt + 1 >= MAX_ATTEMPTS) return response;
    const after = Number(response.headers.get("Retry-After"));
    await sleep(after > 0 ? after * 1000 : backoff(attempt));
  }
}

async function request(path, { base = API, params = {}, method = "GET", body, headers = {}, requireToken = false, raw = false } = {}) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("supportsAllDrives", "true");
  let refreshed = false;
  const response = await fetchRetry(async () => {
    const h = { ...headers };
    await authorize(url, h, { requireToken });
    let res = await fetch(url, { method, body, headers: h });
    if (res.status === 401 && !refreshed && getSetting("refreshToken")) {
      refreshed = true;
      await authorize(url, h, { requireToken, force: true });
      res = await fetch(url, { method, body, headers: h });
    }
    return res;
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const json = await response.json();
      message = json.error?.message ?? message;
    } catch (err) { /* ignore */ }
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
export async function uploadFile(blob, name, parentId, { overwrite = true, existing } = {}) {
  const mimeType = blob.type || "application/octet-stream";
  // `existing` lets callers that already listed the folder skip the lookup (null = not there).
  if (existing === undefined) existing = overwrite ? await findChild(parentId, name) : null;
  const path = existing ? `/files/${existing.id}` : "/files";
  const metadata = existing ? { name } : { name, parents: [parentId] };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
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
    let response = null;
    try {
      response = await fetch(location, { method: "PUT", headers: { "Content-Type": mimeType }, body: blob });
    } catch (err) {
      lastError = err; // dropped connection: start a new upload session
    }
    if (response?.ok) return response.json();
    if (response) {
      lastError = new Error(`Google Drive: upload failed (${response.status})`);
      if (!RETRY_STATUS.has(response.status)) throw lastError;
    }
    await sleep(backoff(attempt + 1));
  }
  throw lastError;
}

/** Move a file or folder to another folder. */
export async function moveFile(fileId, toParentId, fromParentId) {
  return request(`/files/${fileId}`, {
    method: "PATCH",
    params: { addParents: toParentId, removeParents: fromParentId, fields: FILE_FIELDS },
    headers: { "Content-Type": "application/json" },
    body: "{}",
    requireToken: true
  });
}

/** Move a file to the Drive trash (recoverable for 30 days). */
export async function trashFile(fileId) {
  return request(`/files/${fileId}`, {
    method: "PATCH",
    params: { fields: "id" },
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
    requireToken: true
  });
}

/** Thumbnail URL that works for files shared by link (and for the signed-in owner). */
export function thumbnailUrl(fileId, size = 320) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}
