---
name: wake-desktop
description: Wake a sleeping machine on the local network with a Wake-on-LAN magic packet, then wait until it answers a ping. Use when the user asks to wake, power on, or boot a desktop, server, or NAS before connecting to it, or when a task needs a LAN host that is currently asleep. Do not use to wake a machine over the internet or a VPN, since magic packets do not cross a broadcast domain, and do not use to reboot or shut down a machine that is already running.
---

# Wake a desktop

Sends a Wake-on-LAN magic packet to a MAC address, then polls the host with `ping` once a
second until it answers or the timeout expires.

The script has no npm dependencies. It uses `node:dgram` for the packet and the system
`ping` for the probe, so it runs straight from the installed plugin with no `npm install`.

## What this cannot do

Magic packets are broadcast frames. They reach the target only from inside the same
broadcast domain, so this works from a machine on the same LAN or VLAN as the target. It
does not work across the internet, and usually not across a VPN. If the user is remote,
say so instead of sending a packet that cannot arrive.

The target also has to be configured for it: Wake-on-LAN enabled in firmware, and the MAC
address must belong to the wake-capable interface, which is normally the wired one. A
laptop on Wi-Fi generally will not wake.

Running from inside WSL2 is riskier than the preflight can detect. WSL2's default NAT
networking gives the Linux side its own virtual network, so the broadcast socket opens
successfully and the preflight passes, but the magic packet may never reach the physical
LAN's broadcast domain. A preflight pass under WSL2 does not confirm the packet can arrive;
only a successful wake does. Windows 11's mirrored networking mode avoids this by sharing
the host's network directly.

## Workflow

1. Every path below is relative to the skill directory, not the current working directory.
   When they differ, prefix the script with the absolute skill directory path, for example
   `node /path/to/wake-desktop/scripts/wake-desktop.js --preflight --json`.

2. Collect the MAC address and the target host. Ask the user if you do not have both.
   `MAC_ADDRESS` and `IP_ADDRESS` in the environment are used only when the matching flag
   is absent, so pass them explicitly when you know them.

3. Check readiness, which also validates the arguments without sending anything:

   ```sh
   node scripts/wake-desktop.js --mac a1:b2:c3:d4:e5:f6 --ip 192.168.1.50 --preflight --json
   ```

4. Wake it:

   ```sh
   node scripts/wake-desktop.js --mac a1:b2:c3:d4:e5:f6 --ip 192.168.1.50 --timeout 120 --json
   ```

   Add `--no-wait` to send the packet and return immediately, when the user does not need
   the host to be reachable before the next step.

5. Read the exit status and the JSON. Do not infer the outcome from the log lines, which
   go to stderr and describe intent rather than result.

## Reading the result

| Exit | Meaning |
| --- | --- |
| `0` | stdout carries `{"status": ...}`: `already-online` (no packet was needed), `packet-sent` (`--no-wait`), or `online` with `waitedSeconds` |
| `2` | Could not start. `config_missing` or `config_invalid` means fix the arguments; `command_missing`, `probe_unusable`, or `broadcast_unavailable` means the machine cannot run this |
| `1` | `host_unreachable`. The packet went out and the host never answered within the timeout |

On exit 2, relay the `condition` and `remedy` as given. Arguments are validated before the
environment, so a `config_invalid` result is about what you passed, not about the machine.

Exit 1 is not necessarily a failure of the wake itself. The host may still be booting when
a short timeout expires, and a firewall that drops ICMP makes a machine look asleep when
it is not. Report what the script observed, offer a longer `--timeout`, and do not retry
in a loop.
