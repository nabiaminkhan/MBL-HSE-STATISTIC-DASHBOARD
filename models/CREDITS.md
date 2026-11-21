# Human body model — credits & licence notes

**File:** `human_body.glb` (used by the 3D Body Map on the OUR CLINIC and INCIDENT TRACKER pages)

**Original asset:** male avatar by AvatarSDK / Metaperson (photo-scanned face, skin, clothing and
normal-map textures), found through a web search and hosted in the open-source TalkingHead project:
https://github.com/met4citizen/TalkingHead/blob/main/avatars/avatarsdk.glb

**Changes made for this dashboard:** re-posed from T-pose to A-pose, skeleton and facial morph
targets removed (12 MB -> 3.3 MB), scaled to 1.82 m with feet on the floor, brand logo removed
from the shirt texture. No part of the body was modelled by hand.

**Licence:** not confirmed. Before using the dashboard commercially, check the AvatarSDK / Metaperson
terms (and the TalkingHead repository notice). If they do not allow it, replace `human_body.glb` with
a free avatar you generate yourself (Avaturn, Ready Player Me, MakeHuman) and adjust the region
anchors in `bodymap-model.json`.

**Third-party code:** three.js r128, OrbitControls and GLTFLoader (MIT) in `vendor/`.
