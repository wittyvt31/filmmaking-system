# Filmie External Asset Bridge — Blender 5.2.3

This is a **selection-based** bridge. It does not scrape Blendkit, log into an
asset marketplace, or download paid models. Import a licensed model into Blender
using your normal Blendkit workflow, inspect its geometry and select its objects.

## Install

1. In the Filmie repository, run `pnpm install --frozen-lockfile` and
   `pnpm web`. The Studio server must run at `http://127.0.0.1:4173`.
2. Zip the **`filmie_bridge` folder**, including its `__init__.py`:
   ```powershell
   Compress-Archive -Path .\tools\blender\filmie_bridge -DestinationPath .\filmie-bridge.zip -Force
   ```
3. In Blender **5.2.3**, use **Edit → Preferences → Add-ons →
   Install from Disk** and select `filmie-bridge.zip`. Enable the Filmie
   Asset Bridge add-on.
4. In the 3D viewport press **N**, then open the **Filmie** tab.

## Publish an asset

1. Use Blendkit to select and import a model into Blender. Save its editable
   `.blend` source separately; retain the provider URL and license.
2. Select **all model meshes**, plus the armature for a rigged character. Verify
   texture paths and material appearance. The bridge exports **only selected
   objects**. An unselected component will not magically appear in Filmie.
3. Fill in an immutable `assetId` and `version` (for example,
   `characters.daughter.horror`, `1.0.0`), type, universe
   `cinematic-horror`, tags, source provider, and the **actual license** for
   that particular download. Do not guess the license.
4. Click **Publish Selection to Filmie**. The add-on writes a self-contained
   GLB into Filmie's private inbox, then calls the local Filmie server.
   Publishing runs asynchronously after Blender finishes exporting, with its
   result shown in the panel. Larger exports may still pause Blender while
   GLB data is written.
5. In Filmie Studio open **Library & Worlds** and click **Refresh library**.
   The published GLB is versioned and content-addressed; don't publish
   altered geometry under an existing ID and version.

The bridge uses only the local Filmie server on port 4173. It does not upload
assets to GitHub or an external service.

## Character compatibility

Open **Library & Worlds** and stage/inspect a GLB to see the recognized
skeleton, bone names, possible FilmieHumanoid name mappings, and whether
morph targets exist. A suggested map is **not proof** that rest poses, skin
weights, face expressions, or source actions are compatible. Review and edit
the mapping before publishing a character. No facial expressions are inferred
from the mere presence of morph targets. Characters with incomplete maps may
still be published as geometry, but are not automatically animation-ready.

For a first shot, publish the **house**, **phone**, **father**, and **daughter**
as four separately versioned assets. Use a coherent visual universe and the
`horror` theme tag for all four. Keep interactive doors and important props
separate instead of baking the entire world into one uneditable mesh.

## Reuse in Filmie

Use **Library & Worlds → World assembly** to place published assets, assign
transforms, save an immutable world, and apply it to a Filmie project.
Applying a world creates a new project revision, references published asset
versions and attaches their GLBs to the project registry. It doesn't duplicate
the GLBs. The first World Assembly editor uses numeric transforms; it is not a
full interactive 3D world editor yet. Imported characters enter world
composition as static models until compatible character rigs are explicitly
authored into a shot.

### Licensing

Filmie stores models under `.filmie/asset-studio/`. Keep that library private.
A license permitting renders may **not** permit publishing source models or
making a publicly accessible asset library. Keep license provenance with each
asset. The importer rejects missing licenses but cannot verify that the
user-entered terms are legally accurate.
