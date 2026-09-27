// Host half of dsh-app-launcher: serves the operator's app list over a plain HTTP
// route, so the client half has something to render.
//
// WHY A ROUTE AND NOT A CLIENT-SIDE CONSTANT. A third-party client plugin cannot
// call Typert remotes (the client only mounts compiled descriptor contributions),
// so a host route plus a fetch is the pattern — the same one `dsh-cost-bubble` uses.
// It also means the app list is CONFIG, not code: a deployment names its own pages
// in its profile's patch layer and this package stays generic.

const ROUTE = "/app-launcher";

// Only loopback authorities may read this. The list is not secret, but an
// unauthenticated route that a page on another origin could read is how a local
// surface becomes a fingerprinting surface — and this one names the operator's own
// apps and ports.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * One configured app, or null when the entry is not usable.
 *
 * A RELATIVE path (starting with "/") is resolved by the client against the
 * harness origin; an absolute http(s) URL is allowed for an app on another local
 * port. Everything else is REFUSED rather than passed through — `javascript:` and
 * `data:` URLs in particular: the client hands `url` to `window.open`, so a value
 * that survives here is a value that can execute in the shell's origin.
 */
function normalizeApp(entry) {
  if (!entry || typeof entry !== "object") return null;
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (label.length === 0 || url.length === 0) return null;
  if (label.length > 40 || url.length > 300) return null;
  let ok = false;
  if (url.startsWith("/") && !url.startsWith("//")) {
    ok = true; // same-origin path
  } else {
    try {
      const parsed = new URL(url);
      ok = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      ok = false;
    }
  }
  if (!ok) return null;
  return { label, url };
}

/** The configured apps, cleaned: unusable entries are dropped, never rendered as blanks. */
export function normalizeApps(config) {
  const raw = config && Array.isArray(config.apps) ? config.apps : [];
  const apps = [];
  for (const entry of raw) {
    const app = normalizeApp(entry);
    if (app) apps.push(app);
  }
  return apps;
}

const plugin = {
  inject: ["webServer"],
  apply(ctx, config) {
    const { webServer } = ctx;
    const apps = normalizeApps(config);
    ctx.effect(() => webServer.register({
      kind: "prefix",
      path: ROUTE,
      handler: (req, res) => {
        try {
          if (!LOOPBACK.test(String(req.headers.host ?? ""))) {
            res.writeHead(403);
            res.end("forbidden");
            return;
          }
          if (req.method !== "GET") {
            res.writeHead(405);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-cache",
          });
          res.end(JSON.stringify({ ok: true, apps }));
        } catch (error) {
          res.writeHead(500);
          res.end(String(error && error.message ? error.message : error));
        }
      },
    }), "app-launcher: apps route");
  },
};

export default plugin;
export const inject = plugin.inject;
export const apply = plugin.apply;
