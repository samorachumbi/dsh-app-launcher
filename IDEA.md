# IDEA — `dsh-app-launcher` (a persistent button for host-rendered pages)

**Status: logged for a later build, and it is the answer to "how do we open the planner?"**
**Source: the operator's own question, 2026-09-27/28 — and the cost-bubble pill, which already proves
the mechanism on this machine.**

## The problem

The daily-progress planner ships **no client half on purpose** (host-rendered page, no bundle for
`dsh-client-modules` to compose), so the only way in is a URL in a browser tab. After a reboot the
instance may not even be running, and the bookmark silently dies — which is exactly what happened on
2026-09-27 when the machine rebooted at 23:50 and nothing restarted it.

## What it does

A small **client-half-only** plugin: a pill or bar in the shell listing the operator's own
host-rendered apps, each one click away.

- buttons configured per profile: `{ label, url }`, e.g. *Planner → /daily-progress-tab/ui*
- opens a **real OS window** (`window.open(url, name, 'width=…,height=…')`), so it can be dragged to a
  second screen — the requirement the operator stated. A named window is reused, not duplicated.
- draggable + position-persistent overlay, following the pattern the cost-bubble pill already uses
  (`position: fixed`, its own z-index, click to expand)
- shows a **liveness dot** per app: green when the URL answers, grey when it does not, so a dead
  instance is visible in the shell instead of discovered in a browser tab
- keeps the planner's "no client half" property intact by living in its own package

## Why it is the right shape

The planner's README promises "no dock widget, no composer strip, and no harness UI footprint at all".
A separate launcher plugin honours that promise for the planner while giving the operator the button
they asked for — and it is a **generic, publishable plugin** (any DSH user with a host-rendered page
wants this).

## Effort / dependencies

~2 days. The client-half machinery (bundle, slots, overlay) is proven by `dsh-cost-bubble`; this is a
smaller client than that one. Not a replacement for the systemd unit — the unit keeps the app RUNNING,
the launcher makes it one click away.
