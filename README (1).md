# 3D body model – how it works

`bodymap.js` (Incident Tracker + Our Clinic pages) reads **`human-config.json`** and uses the
first model that loads, in this order:

1. `human-realistic.glb` – optional drop-in (a scanned / MakeHuman-style body). Not shipped.
2. `human-body.json` – the baked human body mesh that ships with the dashboard.
3. If neither loads, the old simple built-in body is drawn, so the page never breaks.

Everything else stays the same: dashboard colours/lighting, pins, click-to-locate, filters, search.

## Using a downloaded realistic body (GLB)

A good free, no-attribution (CC0) base is the MakeHuman-derived full body on Fab
(neutral A-pose, ~1.7 m, `.glb` included):
https://www.fab.com/listings/1c2f2267-751c-47fc-98b5-879a1008d4a5

1. Download the full-body `.glb` and save it as `models/human-realistic.glb`.
2. Commit / redeploy. The viewer scales it to 1.82 m, stands it on the floor, centres it and
   paints it with the dashboard skin material automatically.
3. If it faces the wrong way, set `"rotateY": 180` on the glb candidate in `human-config.json`.
4. If it contains extra meshes (eyelashes, hair, clothes), list name fragments in
   `"excludeMeshNames": ["lash","hair","cloth"]`.
5. Pins use the anchors in `"regions"` (metres; model faces +Z; anatomical LEFT = +X). Pins snap to
   the nearest skin point, but arm/hand pose differs between models - to fine-tune, edit
   `pos` / `dir` of a region in `human-config.json` (or per model under the candidate's `"regions"`).

Notes: GLB must be uncompressed (no Draco / Meshopt). Skinning and animation are ignored
(the body is shown in its bind pose). Remember to bump the cache name in `sw.js` after changing models.

## Files

| File | Purpose |
|---|---|
| `human-config.json` | which model to load, height, skin material, pin anchors |
| `human-body.json` | baked body mesh (`mbl-body-mesh`, int16/uint16 base64, ~1.4 MB) |
