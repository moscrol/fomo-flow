# Codex Config Takeover Guard Design

Date: 2026-07-31  
Status: Approved by the user's instruction to execute the recommended repair

## Problem

Dao can patch Codex's active provider Base URL to
`http://127.0.0.1:8955/codex-hot/v1`, but Codex/Cockpit rewrites the same
provider connection back to `http://localhost:57244/v1` during application
startup. The Web HUD then correctly reports `BYPASSED`: rollout telemetry is
still visible, but model traffic, TTFT, provider timing, and network cache
samples no longer cross Dao.

## Approaches considered

1. **Known-value reconciliation guard (selected).** While the Codex hot route
   is enabled, periodically compare only the managed provider's Base URL and
   bearer token with the saved handoff. Repair the file only when every changed
   value is either Dao's managed value or the exact Cockpit value saved during
   takeover.
2. **Make `config.toml` immutable.** This would stop Cockpit's rewrite, but it
   would also block legitimate Codex settings and model changes and complicate
   restore. Rejected.
3. **Launch wrapper or second proxy layer.** This couples Dao to Codex process
   startup and duplicates routing already owned by Dao. Rejected.

## Architecture

### One-shot reconciler

`codex_hot_route.js` gains a one-shot reconciliation function. It reads the
hot-route state, handoff, current Codex provider connection, and current Dao
loopback key.

The reconciler has four safe outcomes:

- `disabled`: the hot route is not enabled; no write.
- `managed`: Base URL and token already match Dao; no write.
- `repaired`: the current fields are a known mixture of the saved Cockpit
  values and Dao values; atomically restore only those two managed fields.
- `drift`: provider or managed fields contain an unknown value; fail closed
  and do not write.

Unreadable or partially written TOML is treated as a transient failure and is
never overwritten.

### Lifecycle guard

The Dao Origin process starts one unref'd guard timer after port binding and
stops it with the server. The timer runs at a bounded interval, prevents
overlapping ticks, logs only state transitions or repairs, and calls the
one-shot reconciler with the reverse proxy's current loopback key.

The guard is active only while Dao's Codex hot route is enabled. Closing Dao or
disabling the integration stops all config mutation.

### Routing truth

After a repair, route state becomes `restart-required` and the previous
network acknowledgement is cleared. A later committed Codex request through
`/codex-hot/v1` calls the existing `markObserved()` path and changes the state
to `routed`.

The HUD therefore distinguishes:

- `BYPASSED`: file is not managed or drifted.
- `RESTART-REQUIRED`: the guard repaired a startup rewrite but no post-repair
  request has crossed Dao yet.
- `ROUTED`: a committed post-repair Codex request has crossed Dao.

## Safety and privacy

- Never change model, provider name, reasoning, projects, MCP, auth cache, or
  history.
- Never emit raw bearer tokens, handoff contents, task ids, prompts, or paths
  through status or logs.
- Repair only exact known values; unknown drift always wins over automation.
- Keep all writes atomic and the handoff file mode private.
- Restore/disable semantics remain unchanged and remove the handoff normally.

## Testing

1. Activate takeover against a temporary Codex config.
2. Simulate Cockpit writing back the exact saved upstream Base URL and token.
3. Verify one reconciliation restores Dao fields, preserves unrelated TOML,
   and marks restart required.
4. Verify repeated reconciliation is a no-op.
5. Verify mixed known values are repaired.
6. Verify unknown Base URL, unknown token, provider change, malformed TOML,
   disabled route, and missing handoff never write.
7. Verify the Origin lifecycle starts and stops the guard exactly once.
8. Deploy to the installed extension, simulate a safe known-value reset, and
   confirm the real config returns to Dao without exposing secrets.

## Success criteria

- Codex/Cockpit startup cannot leave an enabled Dao takeover pointed at 57244.
- Unknown user or external changes are never overwritten.
- HUD does not claim `ROUTED` until a real post-repair request is observed.
- Existing Codex hot-route, HUD, cache, and reverse-proxy tests remain green.
