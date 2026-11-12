# The package tree

What `fnpack` packs. The build and release procedure is in the
[repository README](../README.md); this file is what the package does once it
is installed.

## Lifecycle

`cmd/main` is the only entry point fnOS calls, and it takes `start`, `stop` or
`status` (`0` running, `3` not). It is driven entirely by the `TRIM_*`
variables fnOS sets, so an extracted package can be run from anywhere — see
the README's "Testing a package without installing it".

| script | when | what it does |
|---|---|---|
| `cmd/install_init` | before unpacking | nothing to prepare |
| `cmd/install_callback` | after unpacking | creates `TRIM_PKGVAR` and `TRIM_PKGHOME` |
| `cmd/upgrade_init` | before an upgrade | stops the service, so the old process never serves from a half-written tree |
| `cmd/upgrade_callback` | after an upgrade | restores the modes the engine binary needs; leaves `TRIM_PKGVAR` alone |
| `cmd/uninstall_init` | before removal | stops the service and its engine child |
| `cmd/uninstall_callback` | after removal | removes a socket left by a hard kill |
| `cmd/config_init` | before a settings change | nothing to prepare |
| `cmd/config_callback` | after a settings change | restarts a *running* service so the file browser sees the new authorised roots; a stopped service stays stopped |

`start` waits up to ten seconds for the gateway socket before reporting
failure, so the first desktop click does not race startup. `stop` signals the
Node process and then also kills any `host/spektralab-host` left under this
install's path — node's own shutdown normally reaches it, but a `SIGKILL`ed or
crashed node would leave an engine holding a decoded frame and the GPU.

Two environment variables matter at start:

- `HOME` is pointed at `TRIM_PKGHOME` and `XDG_CACHE_HOME` at
  `TRIM_PKGVAR/cache`. fnOS does not create the package user's passwd home
  (`/home/spektralab`), so without this Mesa logs "Failed to create
  /home/spektralab for shader cache" and recompiles every pipeline on every
  start — that is the 1.3.2 fix.
- `PATH` gains `/var/apps/nodejs_v22/target/bin`, the declared dependency's
  runtime.

## Processes

```
cmd/main start
  └─ node app/server/server.mjs        serves the interface, owns the file browser
       └─ app/host/spektralab-host     the C++/Vulkan engine, one per install
```

The Node process writes `${TRIM_PKGVAR}/spektralab.log` and
`${TRIM_PKGVAR}/spektralab.pid`, and listens on `${TRIM_APPDEST}/app.sock` —
the socket `app/ui/config` declares as `gatewaySocket`, with
`gatewayPrefix: /app/spektralab`. The fnOS gateway forwards
`/app/spektralab/**` there; everything under `/api/host` is piped straight into
the engine's framed protocol (`<uint32 json length><uint32 payload length>`),
so the interface speaks to the engine exactly as the desktop build does.

The engine is an idle process between renders. When no interface has been
attached for 90 seconds the server restarts it, releasing the decoded frame and
the GPU allocations; the next request reopens. That is why the log shows a
start line after a period of inactivity — it is not a crash.

## Permissions

`config/privilege` runs the package as the user `spektralab` in the groups
`video` and `render`, which is what a Vulkan device needs. `config/resource`
declares the shared folder `spektralab/exports`, the default place exports are
written to. Photographs are read from the folders the user authorises in the
app's settings (`TRIM_DATA_ACCESSIBLE_PATHS`), which is why `config_callback`
restarts a running service after a change.
