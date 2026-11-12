# SpektraLab for fnOS

The [fnOS](https://www.fnnas.com) (飞牛) application package of **SpektraLab** —
the film and print simulator: open a RAW, pick a film and a paper, and get a
physically modelled photograph in about a second.

This repository holds the **packaging project** for the fnOS build: the fnOS
manifest and lifecycle scripts, the small Node server that fronts the render
engine, the interface assets and the script that assembles the `.fpk`. The
engine and the interface are built from the
[SpektraLab](https://github.com/JamesQiu2005/SpektraLab) repository.

**Download:** see [Releases](../../releases) — `spektralab.fpk`, plus the
corresponding source archive for the exact commit the package was built from.

## What the package is

A native fnOS app, not a container. Installing it creates the package user
`spektralab` (in `video` and `render`, so it can reach the GPU), starts one
Node process that serves the interface through the fnOS gateway at
`/app/spektralab`, and lets that process spawn `host/spektralab-host`, the
C++/Vulkan render engine. The engine and its baked profiles and LUTs are
**data**: nothing is compiled at install or start time.

| | |
|---|---|
| Architecture | x86_64 |
| Requires | fnOS 1.1.3100 or later, the `nodejs_v22` runtime (declared as a dependency) |
| Graphics | any Vulkan device — Intel or AMD integrated or discrete. With no usable Vulkan device the engine falls back to Mesa's `lavapipe` (CPU), which is correct and slow |
| Interface | the same React interface the desktop build uses, served over HTTP |
| Licence | GPL-3.0-or-later; profiles and LUTs CC BY-SA 4.0 |

Five features of the desktop build are not available on Linux/Vulkan and the
interface greys them out with a reason: digital intermediate, scene latitude
mapping, contrast mask, overscan and date imprint. Everything else — all 25
films, 9 papers including the four black-and-white films and Ilford Multigrade
IV RC, grain, halation, the print LUT export — renders.

## Installing

1. Download `spektralab.fpk` from the release.
2. fnOS **App Center → Settings → Manual install**, choose the file, install.
   The `nodejs_v22` runtime is installed automatically if it is missing.
3. Open **SpektraLab** from the desktop. The first launch renders a preview and
   takes a few seconds while the shader cache is built; later launches reuse it.

The app creates the shared folder `spektralab/exports` for the files it writes.
It reads photographs from any folder the package user can see — use the file
browser inside the app, or copy files into that shared folder.

Check the download before installing:

```bash
sha256sum spektralab.fpk      # compare with the release notes
```

## Layout

```
build.sh                  assembles fnos/app/ and packs spektralab.fpk
fnos/                     the package tree (what fnpack packs)
  manifest                app id, version, dependency, changelog
  ICON.PNG ICON_256.PNG   app-centre icons
  cmd/main                start | stop | status — the fnOS lifecycle script
  cmd/*_init *_callback   install, upgrade, uninstall, config hooks
  config/privilege        run as user `spektralab`, groups video + render
  config/resource         declares the shared folder `spektralab/exports`
  wizard/install          the install-time notice
  app/ui/                 the fnOS desktop entry (gateway path /app/spektralab)
  app/server/server.mjs   HTTP, file browser, framed-protocol proxy
  app/server/web/         the built interface            (generated)
  app/host/spektralab-host the C++/Vulkan engine          (generated)
  app/host/engine/        baked profiles, LUTs, kernels  (generated)
  LICENSE NOTICE.md       GPL-3.0-or-later and attribution
docs/fnos-forum-post.md   the 飞牛论坛 announcement, ready to paste
```

The three `generated` trees are assembled by `build.sh`; they are not in the
repository, because they are build outputs of the SpektraLab checkout.

## Building the package

Two build outputs come from a SpektraLab checkout first:

```bash
git clone https://github.com/JamesQiu2005/SpektraLab.git
cd SpektraLab

engine/build-linux.sh                      # CMake + Ninja in build/linux,
                                           # stages build/host-linux-x64/
(cd desktop && npm ci && npm run build:web) # writes desktop/dist/
```

Then assemble and pack:

```bash
cd ..                    # beside the SpektraLab checkout
git clone https://github.com/JamesQiu2005/spektralab-fnos.git
cd spektralab-fnos
SRC=../SpektraLab ./build.sh
```

`SRC` is the checkout to take the engine, the kernels, the interface and the
baked data from; it defaults to `../SpektraLab`. `build.sh` writes
`spektralab.fpk` in this directory and prints its size and SHA-256. `fnpack`
(the fnOS packaging tool) must be on `PATH`.

What `build.sh` does that is easy to miss by hand:

- `install -m 755` on the engine binary — the compiler leaves it mode `000`,
  and a `000` file inside the package installs as a `000` file.
- copies the compiled kernels (`build/linux/engine/resources/vulkan/`) beside
  the baked data, and the product's four black-and-white profiles over
  spektrafilm's 28.
- **merges the silver paper's neutral pack** into
  `neutral_print_filters.json`. The base file is upstream's and has no row for
  `ilford_multigrade_iv_rc`; the product's row is the Multigrade grade-2 pack
  `(0, 0, 68)`. The macOS app sends those numbers on the wire
  (`Params.multigradeFilter2`); the web interface does not, so the engine's own
  table has to carry them. Without the row a black-and-white print comes out
  about 0.36 D light at roughly grade 3½ — that is the 1.3.6 fix.
- fails if any file in the tree is unreadable (`cp -a` of a build output is the
  usual cause).

## Testing a package without installing it

`cmd/main` is driven by four `TRIM_*` variables, so an extracted package can be
run from anywhere:

```bash
mkdir -p /tmp/v136 && tar xzf spektralab.fpk -C /tmp/v136 app.tgz
tar xzf /tmp/v136/app.tgz -C /tmp/v136
mkdir -p /tmp/v136/home

env TRIM_APPDEST=/tmp/v136 TRIM_PKGVAR=/tmp/v136/var \
    TRIM_PKGHOME=/tmp/v136/home TRIM_APPVER=1.3.6 \
    bash fnos/cmd/main start

curl --unix-socket /tmp/v136/app.sock http://localhost/app/spektralab/api/app-paths

env TRIM_APPDEST=/tmp/v136 TRIM_PKGVAR=/tmp/v136/var \
    TRIM_PKGHOME=/tmp/v136/home TRIM_APPVER=1.3.6 \
    bash fnos/cmd/main stop
```

Use `env` as a prefix rather than exporting the four variables one by one: the
script reads them at start, and a stray exported `TRIM_APPDEST` makes a later
`stop` target the wrong tree.

The engine's own end-to-end check runs against the packaged tree directly:

```bash
python3 engine/tests/host_smoke.py \
    --host fnos/app/host/spektralab-host \
    --resources fnos/app/host/engine
```

(that harness lives in the SpektraLab checkout). On a machine with no GPU the
host falls back to `lavapipe`; it renders correctly and slowly, which is what
the fallback is for.

## Releasing

1. Bump `version` in `fnos/manifest` **and** the `VERSION` fallback in
   `fnos/app/server/server.mjs`. Both, or the About panel and the package
   disagree.
2. Prefix the `changelog` line in `fnos/manifest` with the new version. Keep
   older entries: fnOS shows the whole line.
3. `SRC=../SpektraLab ./build.sh`
4. Check the result from a clean extract (above), including
   `/api/app-paths` reporting the new version.
5. Tag, then attach `spektralab.fpk` **and** a source archive of the SpektraLab
   commit it was built from (see "Licensing") to the release, with the SHA-256
   in the notes.

`fnpack` is not reproducible across runs (see the end of "Licensing"), so a
release records the SHA-256 of the exact file that was tested — re-packaging
the same tree produces a different one. Check a package by extracting it and
running the smoke test, not by comparing its hash with a rebuild.

## Licensing and corresponding source

The application, the engine and the interface are **GPL-3.0-or-later**. Film
and paper profiles and the LUTs derived from them are **CC BY-SA 4.0** by
Andrea Volpato. `fnos/NOTICE.md` lists the third-party components and the
trademark statement; `fnos/app/server/web/assets/licenses/` carries the full
texts and the About panel reads them through the same files.

The engine binary is GPL-3.0-or-later code, so every release attaches the
**corresponding source**: a tarball of the SpektraLab checkout the package was
built from (`engine/`, `desktop/`, and the `fnos/` tree that produced the
package), at the same version. That is the source you need in order to rebuild
this package.

Two builds from the same sources are **not byte-identical**: `fnpack` writes the
tar in directory order and stamps it at pack time, and the `checksum` line in
the manifest is its own, recomputed on every run. So the SHA-256 in the release
notes identifies the file that was tested — it is not a reproducibility claim.
To check that a rebuild matches, extract both packages and compare the trees;
only the manifest's `checksum` line differs.

