// The LTI client-side storage fallback (1EdTech "LTI Client Side postMessages" and "OIDC Login with
// LTI Client Side postMessages"). When a browser blocks the tool's cookies inside the platform's
// iframe, the login state cookie never reaches `/lti/launch`, so the browser binding is carried
// instead by a secret the tool stores in the platform's frame with `lti.put_data` and reads back
// with `lti.get_data`. The platform keys that storage by the tool's origin in that browser, so a
// secret put in an attacker's browser cannot be read back in a victim's.
import { z } from "zod";

/**
 * The `lti_storage_target` a platform names: `_parent`, or the name of a frame in the parent
 * window (Canvas uses `post_message_forwarding`).
 */
export const StorageTarget = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "expected a frame name");

/** What the login page puts in the platform's storage before it follows the redirect. */
export interface PlatformStorageRequest {
  /** The platform frame to message. */
  readonly target: string;
  /** The origin of the platform's OIDC endpoint: messages go only to it and are only read from it. */
  readonly platformOrigin: string;
  /** The storage key, unique to the login's state. */
  readonly key: string;
  /** The secret whose digest the login state keeps. */
  readonly value: string;
}

/** The platform-storage key a login's secret is kept under. */
export const platformStorageKey = (state: string): string => `schoolos_lti_${state}`;

/** How long the client script waits for the platform to answer, in milliseconds. */
export const PLATFORM_STORAGE_TIMEOUT_MS = 5_000;

/**
 * The page script. It is a fixed string, so pages admit it by hash and no inline data runs: each
 * page passes its settings in a JSON `<script type="application/json">` element, which a browser
 * never executes.
 *
 * - `put`: sends `lti.put_data` with the secret, then follows `next` (the platform's OIDC URL)
 *   once the platform answers, or when it does not answer in time, so a browser that does accept
 *   the cookie still launches.
 * - `get`: sends `lti.get_data`, and submits the page's form with the value read back. Without an
 *   answer it shows the page's "open in a new window" notice instead.
 *
 * A reply counts only if it comes from the target frame, from the platform's origin, for this
 * request's message ID and key.
 */
export const PLATFORM_STORAGE_SCRIPT = `(function () {
  "use strict";
  var config = JSON.parse(document.getElementById("lti-storage-config").textContent);
  var parentWindow = window.parent;
  var target = config.target === "_parent" ? parentWindow : parentWindow && parentWindow.frames[config.target];
  var subject = config.mode === "put" ? "lti.put_data" : "lti.get_data";
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  var messageId = Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join("");
  var settled = false;
  function finish(value) {
    if (settled) return;
    settled = true;
    if (config.mode === "put") {
      window.location.replace(config.next);
    } else if (typeof value === "string") {
      var form = document.getElementById("lti-storage-form");
      form.elements.namedItem("lti_storage_value").value = value;
      form.submit();
    } else {
      document.getElementById("lti-storage-failed").hidden = false;
    }
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.origin !== config.origin || event.source !== target) return;
    if (data === null || typeof data !== "object" || data.message_id !== messageId) return;
    if (data.subject !== subject + ".response" || data.key !== config.key) return;
    finish(data.error === undefined ? data.value : undefined);
  });
  if (!target || target === window) return finish(undefined);
  var message = { subject: subject, message_id: messageId, key: config.key };
  if (config.mode === "put") message.value = config.value;
  target.postMessage(message, config.origin);
  setTimeout(function () { finish(undefined); }, ${PLATFORM_STORAGE_TIMEOUT_MS});
})();`;

/**
 * The CSP source admitting {@link PLATFORM_STORAGE_SCRIPT}. A test recomputes it from the script, so
 * an edit to one without the other fails there.
 */
export const PLATFORM_STORAGE_SCRIPT_HASH = "'sha256-jSIToJfzD7pj7hQ+V3Had+FkhuacQd5ycwOda51/Xls='";

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** JSON that is safe inside a `<script>` element: nothing in it can close the element. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");

/**
 * The response headers for a storage page: no caching, and only the page script may run. Forms may
 * post only to the tool itself. The page runs in the platform's iframe, so `frame-ancestors`
 * cannot be `'none'`; a page framed by anyone else reaches no platform storage, because its
 * messages go only to, and are only read from, the platform's origin.
 */
export function platformStoragePageHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // Not `no-referrer`: with it a browser sends `Origin: null` on the page's own form post, and the
    // launch accepts a storage value only from a post whose origin is the tool's.
    "referrer-policy": "same-origin",
    "content-security-policy": `default-src 'none'; script-src ${PLATFORM_STORAGE_SCRIPT_HASH}; form-action 'self'; base-uri 'none'`,
  };
}

const page = (title: string, config: unknown, body: string): string =>
  [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main>`,
    body,
    `<script type="application/json" id="lti-storage-config">${scriptJson(config)}</script>`,
    `<script>${PLATFORM_STORAGE_SCRIPT}</script>`,
    "</main></body></html>",
  ].join("");

/**
 * The login page used when the platform offers client-side storage: it puts the login's secret in
 * the platform's frame, then follows the redirect. The link covers browsers with scripts disabled.
 */
export function platformStorageLoginPage(redirectUrl: string, storage: PlatformStorageRequest): string {
  return page(
    "Opening your course",
    { mode: "put", target: storage.target, origin: storage.platformOrigin, key: storage.key, value: storage.value, next: redirectUrl },
    `<p><a href="${escapeHtml(redirectUrl)}">Continue</a></p>`,
  );
}

/** What the launch page re-posts once it has read the login's secret back. */
export interface PlatformStorageLaunch {
  /** The tool's launch URL. */
  readonly launchUrl: string;
  readonly idToken: string;
  readonly state: string;
  readonly target: string;
  readonly platformOrigin: string;
}

/**
 * The page answering a launch that arrived without the state cookie: it reads the login's secret
 * back from the platform's storage and posts the launch again with it. If the platform does not
 * answer, it asks the person to open the tool in a new window, where cookies work.
 */
export function platformStorageLaunchPage(launch: PlatformStorageLaunch): string {
  return page(
    "Opening your course",
    { mode: "get", target: launch.target, origin: launch.platformOrigin, key: platformStorageKey(launch.state) },
    [
      `<form id="lti-storage-form" method="post" action="${escapeHtml(launch.launchUrl)}">`,
      `<input type="hidden" name="id_token" value="${escapeHtml(launch.idToken)}">`,
      `<input type="hidden" name="state" value="${escapeHtml(launch.state)}">`,
      `<input type="hidden" name="lti_storage_target" value="${escapeHtml(launch.target)}">`,
      '<input type="hidden" name="lti_storage_value" value="">',
      "</form>",
      '<p id="lti-storage-failed" role="alert" hidden>Your browser blocked this course tool inside the page. ',
      "Go back to your course and open the tool in a new window.</p>",
    ].join(""),
  );
}
