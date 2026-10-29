/**
 * Google sign-in dialog. Works in a normal browser (the code comes back by itself) and in the
 * Foundry desktop app, where Google opens in the system browser and the GM pastes the code once.
 */
import { MODULE_ID, DialogV2, esc, localize, notify } from "./compat.js";
import { getSetting } from "./settings.js";
import * as drive from "./drive.js";

const CHANNEL = "akella-search-oauth";
const STORAGE_KEY = "akella-search.oauth";

export async function openAuthDialog() {
  if (!getSetting("oauthClientId") || !getSetting("oauthClientSecret")) {
    notify("warn", "Auth.MissingClient");
    return false;
  }
  const { url, state } = await drive.beginAuth();
  let done = false;
  let dialogRef = null;
  const cleanup = [];

  const finish = async (code, gotState) => {
    if (done || !code) return;
    try {
      await drive.completeAuth(code, gotState);
      done = true;
      notify("info", "Auth.Done");
      dialogRef?.close();
    } catch (err) {
      ui.notifications.error(err.message);
    }
  };

  // The redirect page tells us the code when it runs in the same browser.
  const onPayload = data => {
    if (data?.state !== state) return;
    if (data.error) return ui.notifications.error(`Google: ${data.error}`);
    finish(data.code, data.state);
  };
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = ev => onPayload(ev.data);
    cleanup.push(() => channel.close());
  } catch (err) { /* old browser */ }
  const onStorage = ev => {
    if (ev.key !== STORAGE_KEY || !ev.newValue) return;
    try {
      onPayload(JSON.parse(ev.newValue));
    } catch (err) { /* ignore */ }
  };
  const onMessage = ev => {
    if (ev.origin === window.location.origin && ev.data?.type === CHANNEL) onPayload(ev.data);
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("message", onMessage);
  cleanup.push(() => window.removeEventListener("storage", onStorage), () => window.removeEventListener("message", onMessage));

  const content = `<form class="gdms-dialog gdms-auth">
    <ol>
      <li>${localize("Auth.Step1")}</li>
      <li>${localize("Auth.Step2")}</li>
      <li>${localize("Auth.Step3")}</li>
    </ol>
    <p><button type="button" class="gdms-auth-open"><i class="fa-brands fa-google"></i> ${localize("Auth.Open")}</button></p>
    <div class="form-group"><label>${localize("Auth.Code")}</label><input type="text" name="code" placeholder="4/0A…" autocomplete="off"></div>
    <p class="hint">${localize("Auth.RedirectHint")}<br><code class="gdms-select">${esc(drive.redirectUri())}</code></p>
  </form>`;

  try {
    await DialogV2().wait({
      window: { title: localize("Auth.Title"), icon: "fa-brands fa-google" },
      position: { width: 520 },
      content,
      render: (event, dialog) => {
        dialogRef = dialog?.close ? dialog : event?.target;
        const el = dialogRef?.element ?? dialog?.element;
        el?.querySelector(".gdms-auth-open")?.addEventListener("click", () => window.open(url, "_blank"));
      },
      buttons: [{
        action: "ok", label: localize("Auth.Finish"), icon: "fa-solid fa-check", default: true,
        callback: async (ev, button) => {
          const code = button.form.elements.code.value;
          if (code) await finish(code);
        }
      }, { action: "cancel", label: localize("Cancel") }],
      rejectClose: false
    });
  } finally {
    cleanup.forEach(fn => fn());
  }
  if (!done && drive.isSignedIn()) done = true;
  Hooks.callAll(`${MODULE_ID}.authChanged`, done);
  return done;
}
