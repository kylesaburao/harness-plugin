---
name: wake-desktop
description: Wake a desktop, server, or NAS on the same LAN using Wake-on-LAN, optionally waiting for a ping response before connecting. Register, update, rename, remove, or list named wake targets. Use for waking or powering on a sleeping LAN host, not for rebooting, shutting down, or waking across the internet.
---

# Wake a desktop

## Requirements and limits

Both executables require Node.js 26.0.0 or newer, with no npm packages.
Configuration management uses only filesystem APIs on any platform. Waking requires macOS or Linux.
Waiting requires system `ping` on PATH and permission to send ICMP. `--no-wait`
requires neither ping nor ICMP. Both modes require the target MAC and IP or hostname.

The sender and target must share a LAN broadcast domain, normally the same LAN or
VLAN. The script broadcasts to `255.255.255.255` on UDP ports 9 and 7, once each.
Internet routing and ordinary VPN connections do not carry this broadcast.
The target needs Wake-on-LAN enabled in firmware and in its operating system's
network adapter settings, standby power, and a wake-capable interface, normally
wired Ethernet. Wi-Fi wake requires explicit hardware support.

WSL2 NAT and container network namespaces can isolate broadcasts from the physical
LAN even when socket preparation and sending succeed. Run from a host with access
to the target broadcast domain. Preflight cannot prove packet delivery.
ICMP filtering can hide an awake host, and a ping response proves reachability,
not that its desktop or application services are ready.

## Dispatch

Resolve both `scripts/wake-desktop.js` and `scripts/manage-targets.js` from the **loaded skill's absolute installed
path**, not the working directory or a hard-coded plugin version. For example,
a Codex cache path can be
`/Users/<user>/.codex/plugins/cache/<marketplace>/harness/<version>/skills/wake-desktop/scripts/wake-desktop.js`.
Use the actual path supplied for the loaded skill, including in Claude Code.

Collect only missing names or addresses. Interpret “my desktop” as the saved name
`desktop` when unambiguous. Use the manager's `list --json` to discover saved names
when necessary, and ask when multiple entries plausibly match. Names are exact,
case-sensitive, nonempty, and have no surrounding whitespace. Internal spaces and
Unicode are allowed.

Use `--target NAME` for a saved target. Explicit MAC/IP arguments override saved
addresses for that invocation. Named wakes ignore `MAC_ADDRESS` and `IP_ADDRESS`,
validate the saved entry before overrides, and fail for missing or unknown targets
even when explicit addresses are supplied. Unnamed wakes use explicit addresses,
then those environment variables, without reading saved configuration. Timeout
precedence is explicit `--timeout`, then `TIMEOUT`, then 120 seconds in both modes.
Explicit empty values fail. Timeouts must be positive whole seconds with safe
integer seconds and milliseconds. MACs accept six hex pairs with colons or hyphens.
Value options accept `--flag=value`. Wake aliases remain `-m`, `-i`, `-t`, and `-h`.

Dispatch the real command directly, which validates configuration and checks the
environment before sending:

```sh
node "<absolute-installed-skill-path>/scripts/wake-desktop.js" --mac "<target-mac>" --ip "<target-ip-or-hostname>" --timeout 120 --json
```

For a named wake:

```sh
node "<absolute-installed-skill-path>/scripts/wake-desktop.js" --target desktop --json
```

Add `--no-wait` when only sending is requested. Use `--preflight` for an explicit
readiness check: it prepares and closes the same broadcast socket without sending.
`--help` prints usage. There is no preliminary target probe. After sending, waiting
probes immediately, then starts probes one second apart without overlap. Each
probe is bounded by one second or the remaining deadline, whichever is shorter.

## Manage saved targets

The manager owns all reads and writes for configuration management at
`~/.harness-plugin/wake-desktop/config.json`, resolved from the user's home,
shared between harnesses and retained across plugin upgrades. Agents never edit
this JSON directly. Wake execution is read-only. The schema is
`{"schema_version":1,"targets":{"desktop":{"ip":"192.168.1.91","mac":"34:5a:60:37:3e:21"}}}`.
Only addresses are saved, not timeouts, credentials, or wake preferences.

Dispatch the requested command directly using the loaded skill's absolute path:

```sh
node "<absolute-installed-skill-path>/scripts/manage-targets.js" register --name desktop --ip 192.168.1.91 --mac 34:5a:60:37:3e:21 --json
node "<absolute-installed-skill-path>/scripts/manage-targets.js" update --name desktop --ip 192.168.1.92 --json
node "<absolute-installed-skill-path>/scripts/manage-targets.js" rename --name desktop --new-name "office desktop" --json
node "<absolute-installed-skill-path>/scripts/manage-targets.js" remove --name "office desktop" --json
node "<absolute-installed-skill-path>/scripts/manage-targets.js" list --json
```

Registration requires name and both addresses. Use `--replace` only when replacement
is explicitly requested or the user confirms a registration conflict. Identical
registration succeeds without writing. Update requires at least one address and
changes only supplied fields. Explicit update, rename, and removal requests authorize
those operations. They require an existing source name. Rename cannot overwrite
another name. Unchanged updates and same-name renames do not write.

Registration alone never wakes. “Register and wake” means successful registration
followed by a separate named wake. A wake request never implicitly registers.
Management commands ignore wake environment variables and use no networking.

All commands accept `--help`, `--json`, and `--preflight`, with no short aliases or
positional names. Help reads no configuration. Use preflight only for an explicit
readiness check. It validates arguments, runtime, the full existing registry, and
operation semantics without creating directories or writing. It cannot promise a
later write will succeed. Normal dispatch does those same checks directly.

Absent configuration is an empty registry for register and list. List never creates
files. Management validates every entry, while waking validates the root schema and
selected entry only. Unknown properties and address spelling are preserved. Writes
use a uniquely named sibling temporary file and atomic rename, two-space JSON and a
trailing newline. Failed staging or publication preserves the original file and
cleans up the temporary file. There are no locks, backups, or history. Concurrent
modifications use last-successful-write behavior.

Relay reported management fields: `status` (`registered`, `updated`, `renamed`,
`removed`, `listed`, or `ready`), absolute `configPath`, and `changed` for completed
mutations. Register/update include `name` and `target: {ip, mac}`, rename includes
`name` and `newName`, remove includes `name`, list includes `targets: [{name, ip, mac}]`
sorted by direct name comparison, and preflight includes `operation`.
Exit 0 is success, 2 is argument/runtime/configuration/read failure, and 1 is attempted
persistence failure. Relay errors verbatim using the diagnostic shape below, without
independent diagnosis or automatically deleting malformed configuration.

## Results and stopping

Relay the script's result fields without re-probing or independently diagnosing
its output. JSON success is on stdout. Named results also include `target`, the saved name:

| Status | Fields and meaning |
| --- | --- |
| `ready` | `mac`, `ip`, `timeoutSeconds`: standalone preflight passed |
| `packet-sent` | `mac`, `ip`, `waitedSeconds: 0`: at least one port's send succeeded |
| `online` | `mac`, `ip`, `waitedSeconds`: the target answered after sending and before the deadline |

Exit 0 indicates success. Exit 2 means no send succeeded (or preflight/arguments
failed). Exit 1 means a failure after at least one send succeeded, including timeout.
Failures go to stderr as `{"error":{"code":"...","condition":"...","remedy":"..."}}`
with `--json`, or `ERROR [code]: condition` followed by `Remedy: ...` otherwise.
Relay the diagnosis verbatim from the failing call. Stop after timeout, report
what was observed, and do not resend or restart polling. A timeout does not prove
that waking failed, since the target may block ICMP or still be booting.
