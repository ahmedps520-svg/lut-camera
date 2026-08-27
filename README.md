# LUMA — LUT Camera

A premium camera that grades the **live viewfinder** through 3D LUTs, imports your own
`.cube` files, and exports straight to your photo album. iPhone-first, no build step,
no backend — every frame is processed on-device in WebGL2.

<img src="assets/icon-192.png" width="72" alt="">

---

## What it does

| | |
|---|---|
| **Live LUT preview** | The look is applied to the viewfinder in real time, not after the shutter. What you see is exactly what gets written to the JPEG. |
| **33 built-in looks** | Film stocks, cinema grades and mono emulsions, generated on-device from grading specs (`src/lut/presets.js`) — no LUT binaries to ship. |
| **Import your own LUTs** | Drop in any `.cube` file (3D up to 96³, or 1D — auto-expanded). From Resolve, Lightroom, or your colourist. |
| **Look intensity** | Blend any LUT from 0–100%, live. |
| **Press-and-hold compare** | Hold the viewfinder to see the ungraded frame. |
| **Adjustments** | Exposure, contrast, fade, saturation, temperature, tint, clarity, grain, halation, vignette — all in the same shader pass. |
| **Export to Photos** | The native share sheet (`navigator.share` with files) → **Save Image** on iOS. Falls back to a download elsewhere. |
| **Subscription** | Free tier + LUMA Pro, with a real entitlement flow behind a swappable billing adapter. |
| **Offline / installable** | PWA with a service worker. Add to Home Screen for a full-screen, chrome-free camera. |

Camera extras: 3:4 / 1:1 / 9:16 / 2.39 framing, pinch and rail zoom, tap to focus,
grid, 3s/10s timer, torch (where the platform exposes it), front/rear with optional
selfie mirroring.

---

## Run it

The camera API requires a secure context — `localhost` or HTTPS.

```bash
npx http-server . -p 8080 -c-1      # or: python3 -m http.server 8080
open http://localhost:8080
```

On an iPhone, serve it over HTTPS (or use a tunnel), open it in Safari, then
**Share → Add to Home Screen**. Launched from the Home Screen it runs standalone,
full-bleed into the safe areas, with no browser chrome.

### Tests

```bash
node test/smoke.mjs
```

Drives the real app in Chromium with a synthetic camera: boot, capture, look
switching, LUT import, the free-tier limits, purchase, unlock, and the adjust /
settings panels. Writes screenshots to `test/shot-*.png`.

---

## How it works

```
camera.js ──▶ <video> ──▶ gl/renderer.js ──▶ <canvas> (viewfinder)
                                │
lut/presets.js ─ bake ─┐        └──▶ capture.js ─▶ JPEG ─▶ IndexedDB ─▶ share sheet
lut/cube.js  ─ parse ──┴──▶ 3D texture (RGBA8, trilinear)
```

* **`src/lut/grade.js`** — the colour science. A preset is a data spec (exposure, white
  balance, filmic toe/shoulder, lift/gamma/gain, split toning, curves, mono weights…)
  compiled into a pure function and baked into a lattice. 33³ for the active look,
  17³ for thumbnails.
* **`src/lut/cube.js`** — `.cube` parser (3D + 1D, `DOMAIN_MIN/MAX`, comments, odd
  keywords), plus a serialiser so any look can be exported back out as a `.cube`.
* **`src/gl/shaders.js`** — one fragment shader does the lot: unsharp clarity, linear-light
  exposure and white balance, halation, contrast, the LUT lookup with half-texel
  inset, saturation, fade, vignette and film grain.
* **`src/gl/renderer.js`** — WebGL2 pipeline. Textures are cached per LUT id; `draw()`
  takes a viewport so thumbnails can be tiled into one surface and read back once
  (readback is the expensive part — batching it is what keeps the strip smooth).
* **`src/capture.js`** — renders the still at full sensor resolution through the same
  shader, then hands it to the OS.
* **`src/store.js`** — IndexedDB for shots and imported LUTs. Nothing leaves the device;
  there is no server in this app.

### Performance notes

* Device pixel ratio is capped at 2 for the viewfinder.
* Thumbnails only re-render for canvases actually on screen (IntersectionObserver),
  batched 8-per-pass into a single readback, at most every 2s.
* The render loop stops entirely behind the paywall, the photo viewer, or when the
  tab is hidden — and the camera track is released on background.

---

## Subscriptions

`src/billing.js` owns everything about money. The rest of the app only ever asks
questions like `billing.canUseLook(look)`, `billing.watermark`, `billing.maxLongEdge`.

**Free**: 4 looks, 1 imported LUT, 1600px exports with a small watermark.
**Pro** (`$4.99/mo`, `$29.99/yr` with a 7-day trial, or `$79.99` lifetime): everything —
all looks, unlimited imports, full-resolution clean exports, the pro adjustment set,
`.cube` export, batch export.

> The web build ships `LocalBillingAdapter`, which **simulates** the purchase in
> `localStorage` and takes no payment. The paywall says so on screen.

To go live, implement `BillingAdapter` and assign it:

```js
class StripeAdapter extends BillingAdapter {
  async status()      { /* GET /entitlement for the signed-in account */ }
  async purchase(plan){ /* redirect to Checkout for plan.productId, then re-read */ }
  async restore()     { /* re-read the account's entitlement */ }
  async manage()      { /* open the Stripe billing portal */ }
}
billing.adapter = new StripeAdapter();
```

On iOS, the same three methods map onto StoreKit 2 — `Product.products(for:)`,
`product.purchase()`, and `Transaction.currentEntitlements` — with `plan.productId`
already carrying the App Store product identifiers.

---

## Taking it to the App Store

This build is deliberately structured so the port is mechanical rather than a rewrite:

| Web (today) | iOS (in Xcode) |
|---|---|
| `getUserMedia` + `<video>` | `AVCaptureSession` + `AVCaptureVideoDataOutput` |
| WebGL2 fragment shader | The same maths as a Metal shader or `CIColorCube` filter |
| `.cube` parser | Ports as-is; it is plain arithmetic on text |
| Preset specs | Ports as-is; they are data, not pixels |
| `navigator.share` → Save Image | `PHPhotoLibrary.shared().performChanges` |
| IndexedDB | Core Data / files in the app container |
| `LocalBillingAdapter` | StoreKit 2, same three method shapes |
| Paywall UI | SwiftUI, same copy and plan structure |

Ship the web version first: it validates the looks, the pricing and the flow with
real users, and it stays useful as the marketing site and Android story.

---

## Browser support

WebGL2 with 3D textures is required: Safari 15+ (iOS 15+), Chrome/Edge 56+, Firefox 51+.
The app tells you plainly if the browser can't run the colour engine.

## Licence

Copyright © the repository owner. All rights reserved.

---

## Deploying

The app is static, so GitHub Pages serves it as-is (and Pages gives you HTTPS,
which the camera API requires).

**One-time setup** — <https://github.com/ahmedps520-svg/lut-camera/settings/pages>:

1. **Source** → *Deploy from a branch*
2. **Branch** → `claude/camera-app-lut-presets-zli0pn`, folder `/ (root)` → **Save**

The site goes live a minute later at
**<https://ahmedps520-svg.github.io/lut-camera/>** and republishes on every push.

Prefer CI instead? Set **Source** → *GitHub Actions* and run the
`Deploy to GitHub Pages` workflow in the Actions tab — `.github/workflows/pages.yml`
is already there.
