# Caching

These instructions are for the executor. The Advisor must not retrieve this file.

Caching is opportunistic, not memory. Preserve stable, relevant instructions,
baseline, and serialization where practical. The cache profile is host, exact
model, reasoning configuration, tool-free policy, policy version (4), and epoch.
A model or effort change changes the cache profile, not the semantic epoch.
Retain valid task facts and all budgets. Use cache controls only when the actual
host exposes them; do not import native Advisor controls into fallback execution.
Report reachable input/cached/write token metrics or their unavailability. Never
warm a cache, preserve misleading context for a hit, or request Advisor tools to
measure usage.
