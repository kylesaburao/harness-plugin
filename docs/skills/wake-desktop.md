# Wake Desktop

[Documentation](../README.md) / Using the plugin

Save named computers and wake them on the same LAN with `wake-desktop`.

## Requirements

Use Node.js 26 or newer. No npm packages are required. Waking runs on macOS or Linux and needs UDP broadcast access to the target's LAN or VLAN. Waiting for a response also requires system `ping` and ICMP permission.

Enable Wake-on-LAN in the target's firmware and operating system network settings. The adapter needs standby power and wake support, normally through wired Ethernet. Wi-Fi requires explicit hardware support. Internet routing, ordinary VPNs, WSL2 NAT, and container networking can prevent broadcast delivery.

## Ask the agent

After [installing the plugin](../../README.md#install), use requests such as:

- “Use wake-desktop to register my desktop: IP 192.168.1.91, MAC 34:5a:60:37:3e:21.”
- “Wake my desktop.”
- “List my saved wake targets.”
- “Update desktop's IP to 192.168.1.92.”
- “Rename desktop to office desktop.”
- “Remove office desktop from my saved wake targets.”

Registration saves addresses without waking anything. Ask to “register and wake” for both operations. A wake request does not implicitly register a computer.

## Direct CLI quick start

Set `wake_skill` to the absolute installed skill directory shown by your harness. In a repository checkout, you can use the absolute path to `dist/harness/skills/wake-desktop`. Resolve the installed path again after upgrades.

```sh
wake_skill="/absolute/path/to/skills/wake-desktop"
node "$wake_skill/scripts/manage-targets.js" register --name desktop --ip 192.168.1.91 --mac 34:5a:60:37:3e:21 --json
node "$wake_skill/scripts/manage-targets.js" list --json
node "$wake_skill/scripts/wake-desktop.js" --target desktop --timeout 120 --json
```

The wake command sends a packet and waits up to 120 seconds for a ping response. Add `--no-wait` to send without polling. To wake without saving a target, supply `--mac` and `--ip` instead of `--target`.

Run maintenance commands individually as needed:

```sh
node "$wake_skill/scripts/manage-targets.js" update --name desktop --ip 192.168.1.92 --json
node "$wake_skill/scripts/manage-targets.js" rename --name desktop --new-name "office desktop" --json
node "$wake_skill/scripts/manage-targets.js" remove --name "office desktop" --json
```

## Configuration and troubleshooting

Saved targets live in `~/.harness-plugin/wake-desktop/config.json`, shared by both harnesses and retained across upgrades. Manage them through the CLI instead of editing JSON. Names are case-sensitive.

Use `--help` for options or `--preflight` for an explicit readiness check without sending a packet or changing configuration. Preflight cannot prove delivery.

A ping response proves network reachability, not desktop or application readiness. A timeout does not prove the computer stayed asleep: it may still be booting or blocking ICMP. Check LAN access, firmware/adapter settings, and ICMP filtering when investigating. Command errors include a diagnosis and remedy.

The [complete skill contract](../../dist/harness/skills/wake-desktop/SKILL.md) defines validation, address precedence, result fields, and stopping behavior.

## Configuration mutation locks

Register, update, rename, and remove hold an exclusive sibling `config.json.lock`
directory from the fresh read through atomic publication. No-op mutations also lock
but do not rewrite the registry. Help, list, and preflight remain lock-free.
Contention returns `target_config_busy` (exit 2), without saving. Retry explicitly
after the other mutation finishes. Locks are never retried, expired, or stolen.

Acquisition failures return `target_config_lock_failed` (exit 2). Release or ownership
failures return `target_config_lock_cleanup_failed` (exit 1), with the absolute lock
path and a quoted recovery command. The diagnostic says when configuration was
saved and retains any operation failure. An abruptly terminated writer can leave a
lock. Confirm no target configuration mutation is running before executing the
reported recovery command. Relay failure code, condition, and remedy verbatim.
