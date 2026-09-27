// Client half of dsh-app-launcher: a draggable pill in the shell that opens the
// operator's host-rendered pages in their own OS window.
//
// WHY `window.open` AND NOT AN IFRAME. The requirement is "open it and move it to a
// second screen". An iframe lives inside the shell window, so a second screen would
// mean moving the whole harness. A named popup is a real window: the window manager
// moves it, sizes it and remembers where it was, and a stable name REUSES it rather
// than piling up tabs.
//
// The contract below is the one every DSH client plugin uses: the bundle calls
// `window.__ModuleLoader__.load({ id, factory })`, requires React from the host, and
// registers itself into a slot. It is hand-written rather than compiled because that
// is what the loader mounts; the CJS prologue (`var module`/`var exports`) is what
// makes `Object.defineProperty(exports, Symbol.toStringTag)` behave as ESM.

window.__ModuleLoader__.load({
  id: "dsh-app-launcher",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const inject = ["slots", "timer"];

    const LOOPBACK_FALLBACK = "http://127.0.0.1";

    /** An absolute URL for a configured entry: relative paths resolve against the shell's origin. */
    function absolute(url) {
      if (url.startsWith("/")) {
        try {
          return new URL(url, window.location.origin).toString();
        } catch (_err) {
          return url;
        }
      }
      return url;
    }

    /** True when this URL is on the harness's own origin, so a normal fetch may read its status. */
    function sameOrigin(url) {
      if (url.startsWith("/")) return true;
      try {
        return new URL(url).origin === window.location.origin;
      } catch (_err) {
        return false;
      }
    }

    /**
     * Does the host answer at all?
     *
     * ANY answer is liveness — a 404 or a 405 still means something is listening, and
     * calling that "down" would train the operator to ignore the dot. Only a network
     * failure (connection refused, DNS) counts as down, which is exactly the reboot
     * case this pill exists to make visible.
     */
    async function ping(url) {
      const target = absolute(url);
      try {
        if (sameOrigin(url)) {
          await fetch(target, { method: "HEAD", cache: "no-store" });
        } else {
          // Cross-origin: an opaque response still proves the host answered.
          await fetch(target, { method: "HEAD", cache: "no-store", mode: "no-cors" });
        }
        return true;
      } catch (_err) {
        return false;
      }
    }

    function AppRow(props) {
      const app = props.app;
      const alive = props.alive;
      const dot = {
        width: 7, height: 7, borderRadius: 999, flex: "none",
        background: alive === false ? "#6b7280" : "#22c55e",
        boxShadow: alive === false ? "none" : "0 0 6px rgba(34,197,94,0.55)",
      };
      return React.createElement("div", {
        onClick: props.onOpen,
        style: {
          display: "flex", alignItems: "center", gap: 9,
          padding: "7px 9px", borderRadius: 8, cursor: "pointer",
          fontSize: 12,
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))"; },
        onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        title: alive === false ? "not answering right now" : "open in its own window",
        "data-app": app.label,
        "data-app-url": app.url,
        "data-alive": alive === false ? "down" : "up",
      },
        React.createElement("span", { style: dot }),
        React.createElement("span", { style: { flex: 1 } }, app.label),
        React.createElement("span", { style: { opacity: 0.5, fontSize: 11 } }, "\u2197"),
      );
    }

    function Launcher(props) {
      const interval = props.interval;
      const [apps, setApps] = React.useState(null);
      const [alive, setAlive] = React.useState({});
      const [expanded, setExpanded] = React.useState(false);
      const [pos, setPos] = React.useState({ x: 0, y: 0 });
      const dragRef = React.useRef(null);
      const movedRef = React.useRef(false);

      React.useEffect(() => {
        let live = true;
        async function load() {
          try {
            const res = await fetch("/app-launcher/apps", { cache: "no-store" });
            if (!live || !res.ok) return;
            const payload = await res.json();
            if (live && payload && payload.ok === true && Array.isArray(payload.apps)) {
              setApps(payload.apps);
            }
          } catch (_err) { /* the pill stays hidden until the host answers */ }
        }
        load();
        return () => { live = false; };
      }, []);

      React.useEffect(() => {
        if (!apps || apps.length === 0) return;
        let live = true;
        async function check() {
          const next = {};
          for (const app of apps) next[app.label] = await ping(app.url);
          if (live) setAlive(next);
        }
        check();
        const dispose = interval(check, 15000);
        return () => { live = false; if (dispose) dispose(); };
      }, [apps, interval]);

      function open(app) {
        // A NAMED window is reused, so clicking the same app twice does not pile up
        // windows; `popup=yes` plus a size gives a real window the WM can move to
        // another screen. No `noopener`: the target is the operator's own local page,
        // and dropping the name would break the reuse that makes this feel like an app.
        const features = "popup=yes,width=1400,height=900,left=80,top=60";
        const opened = window.open(absolute(app.url), "dsh-app-" + app.label, features);
        if (opened) opened.focus();
        setExpanded(false);
      }

      function onPointerDown(e) {
        // A press that starts INSIDE the panel belongs to the panel. Capturing the
        // pointer for a drag would redirect the following click to the PILL — measured:
        // clicking an app row toggled the panel closed and `window.open` was called
        // zero times, so the feature looked broken while the handler was fine.
        if (e.target && e.target.closest && e.target.closest("[data-app],[data-panel]")) return;
        if (e.currentTarget && e.currentTarget.setPointerCapture) {
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        movedRef.current = false;
        dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY };
      }
      function onPointerMove(e) {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) movedRef.current = true;
        setPos((p) => ({ x: (p.x || 0) + dx, y: (p.y || 0) + dy }));
        dragRef.current = { id: d.id, sx: e.clientX, sy: e.clientY };
      }
      function onPointerUp(e) {
        if (dragRef.current && e.pointerId === dragRef.current.id) dragRef.current = null;
      }
      function onClick() {
        if (!movedRef.current) setExpanded((v) => !v);
      }

      // Nothing configured: no pill at all. An empty launcher is furniture.
      if (!apps || apps.length === 0) return null;

      const labels = apps.map((a) => a.label);
      const down = labels.filter((l) => alive[l] === false).length;
      const dot = {
        width: 7, height: 7, borderRadius: 999, flex: "none",
        background: down === 0 ? "#22c55e" : "#f59e0b",
        boxShadow: down === 0 ? "0 0 6px rgba(34,197,94,0.55)" : "none",
      };

      return React.createElement("div", {
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onClick: onClick,
        style: {
          position: "fixed",
          left: 16,
          bottom: 16,
          // Below the cost pill on purpose: two overlays that both claim the top of
          // the stack fight, and the pill that reports money should win a tie.
          zIndex: 2147482000,
          transform: "translate(" + (pos.x || 0) + "px," + (pos.y || 0) + "px)",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 12px",
          borderRadius: 999,
          background: "var(--dsw-alias-bg-overlay, rgba(22,22,27,0.92))",
          color: "var(--dsw-alias-label-primary, #e8e8ec)",
          border: "1px solid var(--dsw-alias-border-l1, #3a3a40)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
          fontSize: 12,
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          cursor: "grab",
          userSelect: "none",
          lineHeight: 1,
        },
        title: "Open an app (click for the list, drag to move)",
        "data-launcher": "pill",
      },
        React.createElement("span", { style: dot }),
        React.createElement("span", { style: { fontWeight: 700, letterSpacing: 0.2 } }, "Apps"),
        React.createElement("span", { style: { opacity: 0.6, fontSize: 11 } }, String(apps.length)),
        expanded ? React.createElement("div", {
          "data-panel": "apps",
          style: {
            position: "absolute",
            left: 0,
            bottom: "calc(100% + 8px)",
            minWidth: 220,
            padding: "6px",
            borderRadius: 10,
            background: "var(--dsw-alias-bg-overlay, rgba(22,22,27,0.97))",
            border: "1px solid var(--dsw-alias-border-l1, #3a3a40)",
            boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
            cursor: "default",
          },
        },
          apps.map((app, i) => React.createElement(AppRow, {
            key: app.label + i,
            app: app,
            alive: alive[app.label],
            onOpen: (e) => { if (e) e.stopPropagation(); open(app); },
          })),
        ) : null,
      );
    }

    function apply(ctx) {
      const slots = ctx.slots;
      const interval = ctx.interval;
      slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "app-launcher", order: 90, label: "Apps" },
        (props) => React.createElement(Launcher, { ...props, interval: interval }),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
