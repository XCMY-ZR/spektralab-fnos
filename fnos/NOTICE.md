SpektraLab — fnOS application package
=====================================

The application code, the C++ render engine and the interface are licensed
under the GNU General Public License, version 3 or later. The full text is in
`LICENSE`.

The film and paper profiles under `app/host/engine/profiles/`, and the LUTs
derived from them (including the tables in `app/host/engine/print_luts.json`),
are licensed under Creative Commons Attribution-ShareAlike 4.0 by Andrea
Volpato — see `SPEKTRAFILM_LICENSE.txt` and
`app/host/engine/PRODUCT_PROFILES_NOTICE.md`.

SpektraLab is built on the spektrafilm engine:
https://github.com/andreavolpato/spektrafilm

The interface's About panel reads the licence texts from
`app/server/web/assets/licenses/`, which are the same files the desktop build
carries.

The engine binary bundles the following third-party components:

- LibRaw (LGPL-2.1 / CDDL-1.0), for camera RAW decoding.
- Volk and the Vulkan headers (Apache-2.0 / MIT), for the Vulkan loader.
- The baked spectral data and profiles listed in
  `app/host/engine/profiles/` (CC BY-SA 4.0, see above).

"Kodak", "Portra", "Ektachrome", "Fujifilm", "Ilford" and the other stock names
are their owners' trademarks; the profiles describe published measured data and
are not endorsed by those companies.
