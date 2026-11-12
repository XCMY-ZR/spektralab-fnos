SpektraLab for fnOS — packaging project
=======================================

The packaging scripts in this repository (everything outside `fnos/app/`) are
part of SpektraLab and licensed under the **GNU General Public License, version
3 or later**; the full text is in `LICENSE`.

The application inside the package is licensed the same way. Its own notice,
which travels with the package, is `fnos/NOTICE.md` and covers:

- the film and paper profiles and the LUTs derived from them —
  **CC BY-SA 4.0**, by Andrea Volpato, with `fnos/SPEKTRAFILM_LICENSE.txt` and
  `fnos/app/host/engine/PRODUCT_PROFILES_NOTICE.md` (generated) recording what
  each profile is built from;
- LibRaw 0.22.2 (LGPL-2.1), statically linked into `spektralab-host`;
- volk (MIT) and the Vulkan headers (Apache-2.0 OR MIT);
- stb (public domain / MIT);
- the trademark statement for the film and paper names.

SpektraLab is built on the spektrafilm engine:
<https://github.com/andreavolpato/spektrafilm>

Corresponding source
--------------------

`spektralab-host` is GPL-3.0-or-later code, so each release attaches the source
it was built from: a tarball of the SpektraLab checkout named in the release
notes, containing `engine/`, `desktop/` and the `fnos/` tree that produced the
package. `engine/build-linux.sh` and `engine/stage-host.sh` in that checkout are
the scripts that built the binary and collected the licence texts the binary
and its data carry.
