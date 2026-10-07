# TnL Build Reader

Drop a Throne and Liberty character screenshot and it identifies the equipped items
(2 weapons, 6 armor pieces, 7 accessories), then shows a loadout summary and a tooltip
for each.

Everything runs in the browser: the matcher runs in a Web Worker against precomputed
icon features, and the item data and icons are static files. `next build` produces
a fully static site in `out/`, with no server or Workers needed.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
```

## Refresh the data

The app's data lives in `public/` (`data/` and `icons/`) and is committed, so builds
don't need the scraper output. After re-scraping in the parent folder
(`scrape_weapons.py`, `scrape_armor.py`, `scrape_accessories.py`, then
`download_icons.py` for new icons), regenerate it with:

```bash
npm run data
```

`npm run test:match -- path/to/screenshot.png` prints the top matches for each slot
from the command line (add slot ids, e.g. `hands necklace`, to test just those).

## Deploy to Cloudflare Pages

Connect the repo in Cloudflare Pages with:

| Setting | Value |
|---|---|
| Framework preset | None |
| Root directory | `next` (if the repo root is the parent folder) |
| Build command | `npm run build` |
| Build output directory | `out` |
| Environment variable | `NODE_VERSION` = `22` |

Or upload a local build directly:

```bash
npm run deploy
```

This builds and runs `wrangler pages deploy out --project-name tnl-build-reader --branch main`.
The explicit `--branch main` matters: without it Wrangler labels the deploy with the current
git branch, and anything other than the Pages project's production branch becomes a
preview deployment.

## How matching works

- `lib/layout.ts` first finds the character screen in the screenshot. The game draws it at
  a size set by the window height and centres it, so a different resolution or aspect
  ratio moves every slot. It compares the screenshot's edges against an edge map of the
  reference screenshot (`../layout_reference.png`, fixed UI only: no character or
  inventory contents), searching scale and offset from coarse to fine, in about 0.3 s.
  If nothing fits well, the boxes fall back to a centred guess and the page says so.
  Rebuild the template with `npm run layout` if the reference changes, and check
  screenshots with `npm run test:layout -- a.png b.png`.
- `lib/slots.ts` holds each slot's position in the reference screenshot and which item
  types it can hold, so a ring slot is only compared against rings.
- `lib/matcher.ts` shrinks each slot region to a 40×40 brightness grid. It slides every
  candidate icon over it at five sizes and scores two correlations: one over just the
  icon's own pixels, which ignores the game's glow and background colours, and one over
  the whole slot, which stops thin icons from matching anything. It also nudges the box
  around its position and size, so a roughly placed box still lines up. The finalists
  are then compared on colour too, since some items differ only by colour (the same
  necklace with a pink or a cyan gem).
- `scripts/build-data.mjs` precomputes each icon's transparency and brightness (40×40)
  and colour (20×20) into `public/data/features.bin`. The other sizes are derived in
  the browser.
