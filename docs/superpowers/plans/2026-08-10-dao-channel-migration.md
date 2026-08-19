# Dao Channel Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, explicit Desktop workflow that imports the existing Dao providers, custom models, and exact route priority into the Electron-owned configuration, then execute and visibly verify one migration on the user's Mac.

**Status:** Completed and visibly accepted on macOS on 2026-08-10.

**Architecture:** A main-only `ChannelMigrationService` owns fixed source/destination discovery, pure merge planning, expiring confirmation tokens, private backups, atomic writes, and safe audit records. Two exact IPC capabilities expose only a redacted preview and confirmed apply result. A focused React card in `接入渠道` drives preview and confirmation, then refreshes the existing provider/overview data without probing providers or changing route priority.

**Tech Stack:** Electron 39, TypeScript, React 19, Vite, Vitest, Testing Library, Node `fs/promises` + `crypto`, existing Dao `fs.watch` configuration reload.

---

## File map

- Create `desktop/electron/services/channel-migration.ts`: pure merge contract plus main-only preview/apply service.
- Create `desktop/electron/services/channel-migration.test.ts`: merge, token, drift, backup, atomicity, permission, and redaction tests.
- Modify `desktop/electron/ipc/channels.ts`: add the two fixed migration channels.
- Modify `desktop/electron/ipc/capabilities.ts`: allow only undefined preview payload and exact token apply payload.
- Modify `desktop/electron/ipc/capabilities.test.ts`: prove safe acceptance and reject paths/config/secrets/arbitrary fields.
- Modify `desktop/electron/main.ts`: instantiate the migration service and register exact handlers.
- Modify `desktop/electron/preload.ts`: expose typed preview/apply calls only.
- Modify `desktop/src/lib/desktopHost/index.ts`: define safe DTOs and host methods with unavailable fallbacks.
- Create `desktop/src/components/control/ChannelMigrationCard.tsx`: explicit preview, confirmation, success/error UI.
- Create `desktop/src/components/control/ChannelMigrationCard.test.tsx`: zero-write, confirmation, redaction, retry, and stale-response tests.
- Modify `desktop/src/components/control/ProvidersControlView.tsx`: compose the card and refresh existing data after success.
- Modify `desktop/src/components/control/ProvidersControlView.test.tsx`: integration test for refresh after apply and no implicit probe/write.
- Modify `desktop/src/theme/globals.css`: scoped migration card/dialog styles.
- Modify `desktop/README.md` and `docs/DAO_DESKTOP_PARITY.md`: document one-shot import and boundaries.
- Modify the design and this plan only after final visible acceptance.

### Task 1: Pure merge contract and safe preview

**Files:**

- Create: `desktop/electron/services/channel-migration.ts`
- Test: `desktop/electron/services/channel-migration.test.ts`

- [x] **Step 1: Write failing pure merge tests**

Add fixtures containing fake values only. Assert that source conflicts win, Desktop-only providers/models remain, Desktop gateway remains byte-for-byte equivalent, source route objects remain exact, custom-model channel arrays retain exact order, and unlisted source fields do not copy:

```ts
const source = {
  gateway: { mode: "legacy" },
  providers: {
    shared: { baseUrl: "https://source.invalid", apiKey: "source-secret" },
    imported: { baseUrl: "https://imported.invalid", apiKey: "import-secret" },
  },
  customModels: {
    modelA: { channels: [{ provider: "imported" }, { provider: "shared" }] },
  },
  daoRoutes: {
    enabled: true,
    substituteEnabled: false,
    allowMcpTools: true,
    routes: { modelA: { provider: "imported", model: "upstream-a" } },
  },
  sourceOnlyPrivateField: "must-not-copy",
};

const target = {
  gateway: { mode: "desktop", port: 8955 },
  providers: {
    shared: { baseUrl: "https://desktop.invalid", apiKey: "desktop-secret" },
    desktopOnly: { baseUrl: "https://desktop-only.invalid" },
  },
  customModels: { desktopModel: { channels: [{ provider: "desktopOnly" }] } },
  daoRoutes: {
    _说明: "keep metadata",
    routes: { old: [{ provider: "desktopOnly" }] },
  },
};

const result = mergeDaoChannelConfig(source, target);
expect(result.gateway).toEqual(target.gateway);
expect(result.providers.shared).toEqual(source.providers.shared);
expect(result.providers.desktopOnly).toEqual(target.providers.desktopOnly);
expect(result.customModels.desktopModel).toEqual(
  target.customModels.desktopModel,
);
expect(result.customModels.modelA.channels).toEqual(
  source.customModels.modelA.channels,
);
expect(result.daoRoutes.routes.modelA).toEqual(source.daoRoutes.routes.modelA);
expect(result.daoRoutes._说明).toBe("keep metadata");
expect(result).not.toHaveProperty("sourceOnlyPrivateField");
```

- [x] **Step 2: Run the pure test and confirm RED**

Run:

```bash
cd desktop
npx vitest run electron/services/channel-migration.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement validation, merge, and safe summary**

Export these types and functions:

```ts
export type ChannelMigrationPreview = {
  available: boolean;
  sourceLabel: "现有 Dao 配置";
  providerNames: string[];
  providerCount: number;
  customModelCount: number;
  routeCount: number;
  newProviderCount: number;
  overwrittenProviderCount: number;
  preservedDesktopProviderCount: number;
  priorityPreserved: true;
  confirmationToken?: string;
  message: string;
};

export type ChannelMigrationApplyResult = {
  ok: true;
  providerCount: number;
  customModelCount: number;
  routeCount: number;
  backupCreated: true;
  priorityPreserved: true;
  message: string;
};

export function mergeDaoChannelConfig(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): Record<string, unknown>;

export function buildSafeChannelMigrationPreview(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): Omit<ChannelMigrationPreview, "confirmationToken">;
```

Validation must require record-shaped `providers`, `customModels`, `daoRoutes`, and `daoRoutes.routes`. Provider names returned to the renderer must be unique, at most 80 characters, control-character free, and match Unicode letters/numbers plus space, dot, underscore, and hyphen; unsafe keys become `未命名渠道` without exposing the original.

The merge implementation must construct a new target-root object, merge only `providers` and `customModels`, replace executable `daoRoutes` fields with source values, retain only target `daoRoutes` keys beginning with `_`, and never mutate source or target. Priority order is represented by each custom model's `channels` array; those arrays must pass through without sorting.

- [x] **Step 4: Run pure merge and redaction tests**

Add assertions that provider keys containing `Authorization`, `Bearer`, `sk-`, slash, backslash, or control characters do not appear in preview JSON. Run the focused test; expected PASS.

- [x] **Step 5: Commit the pure model**

```bash
git add desktop/electron/services/channel-migration.ts desktop/electron/services/channel-migration.test.ts
git commit -m "feat: model safe Dao channel migration"
```

### Task 2: Transactional main-only migration service

**Files:**

- Modify: `desktop/electron/services/channel-migration.ts`
- Modify: `desktop/electron/services/channel-migration.test.ts`

- [x] **Step 1: Write failing service tests with temporary directories**

Use `mkdtemp`, fake home/userData roots, and fake configs. Cover:

```ts
const service = createChannelMigrationService({
  homeDir,
  userDataDir,
  now: () => fixedNow,
  tokenBytes: () => Buffer.alloc(32, 7),
  tokenTtlMs: 60_000,
});

const preview = await service.preview();
expect(preview.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
expect(await readFile(destination, "utf8")).toBe(beforePreview);

const result = await service.apply({
  confirmationToken: preview.confirmationToken!,
});
expect(result).toMatchObject({
  ok: true,
  backupCreated: true,
  priorityPreserved: true,
});
```

Also test invalid JSON, missing source, fake token, expired token, source drift, target drift, backup failure, write failure, one-use token, `0600` files, `0700` directories, and absence of paths/secrets in errors/results/audit.

- [x] **Step 2: Run the service test and confirm RED**

Run the focused Vitest command. Expected: FAIL because `createChannelMigrationService` is not exported.

- [x] **Step 3: Implement fixed discovery and expiring preview state**

Use fixed paths derived only in main:

```ts
const sourcePath = join(homeDir, ".codeium", "dao-byok", "配置.json");
const destinationPath = join(userDataDir, "config", "配置.json");
```

Store pending previews only in a private `Map<string, PendingMigration>`. Each entry contains source hash, target hash, merged config, safe preview, and expiry. Hash the exact UTF-8 source/target contents with SHA-256. `preview()` must not mkdir, chmod, write, append audit, or modify the destination.

- [x] **Step 4: Implement backup, atomic apply, and safe audit**

On apply:

1. Validate token syntax and lookup.
2. Re-read both files and compare hashes.
3. Create `config/.config-backups` with `0700`.
4. Copy the target to `配置.json.<controlled timestamp>.bak`, then chmod `0600`.
5. Write formatted JSON plus newline through a same-directory `wx` temp file, `sync`, close, rename, and chmod `0600`.
6. Append one JSON line to `runtime/channel-migration-audit.jsonl` containing only version, timestamp, counts, result, and the first 16 hex characters of the source hash.
7. Remove the token only after successful apply; drift removes it immediately.

All thrown messages must be fixed Chinese categories. Raw filesystem errors pass through `redactDesktopError` only for main logs and never enter the DTO.

- [x] **Step 5: Run service tests, typecheck, and lint**

```bash
cd desktop
npx vitest run electron/services/channel-migration.test.ts
npm run typecheck
npx eslint --quiet electron/services/channel-migration.ts electron/services/channel-migration.test.ts
```

Expected: all exit 0.

- [x] **Step 6: Commit the transactional service**

```bash
git add desktop/electron/services/channel-migration.ts desktop/electron/services/channel-migration.test.ts
git commit -m "feat: apply Dao channel migration atomically"
```

### Task 3: Exact IPC, preload, and typed host boundary

**Files:**

- Modify: `desktop/electron/ipc/channels.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/ipc/capabilities.test.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/src/lib/desktopHost/index.ts`

- [x] **Step 1: Write failing IPC capability tests**

Add acceptance for preview with `undefined` and apply with exactly one 64-character lowercase hex token. Reject any payload containing `sourcePath`, `destinationPath`, `config`, `apiKey`, an extra field, uppercase/non-hex token, or missing token.

```ts
expect(
  validateDesktopIpcPayload(
    ELECTRON_IPC_CHANNELS.channelMigrationPreview,
    undefined,
  ),
).toBe(true);
expect(
  validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.channelMigrationApply, {
    confirmationToken: "07".repeat(32),
  }),
).toBe(true);
expect(
  validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.channelMigrationApply, {
    confirmationToken: "07".repeat(32),
    sourcePath: "/private/source",
  }),
).toBe(false);
```

- [x] **Step 2: Run capability tests and confirm RED**

Expected: TypeScript/Vitest failure because channels are absent.

- [x] **Step 3: Add channels and validators**

Add:

```ts
channelMigrationPreview: 'dao:channel-migration-preview',
channelMigrationApply: 'dao:channel-migration-apply'
```

Preview accepts only `undefined`; apply accepts exactly `{ confirmationToken }` with `/^[a-f0-9]{64}$/`.

- [x] **Step 4: Add main handlers and one service instance**

Create a lazy singleton using `app.getPath('userData')`. Register:

```ts
registerHandler(ELECTRON_IPC_CHANNELS.channelMigrationPreview, () =>
  channelMigration().preview(),
);
registerHandler(ELECTRON_IPC_CHANNELS.channelMigrationApply, (payload) =>
  channelMigration().apply(payload as { confirmationToken: string }),
);
```

Do not accept a path, config object, merge mode, priority input, or arbitrary write payload.

- [x] **Step 5: Expose typed host methods**

Add to `DesktopHost` and preload:

```ts
previewChannelMigration(): Promise<ChannelMigrationPreview>
applyChannelMigration(confirmationToken: string): Promise<ChannelMigrationApplyResult>
```

The unavailable host returns an unavailable safe preview and throws `现有 Dao 配置暂时不可迁移` on apply. Do not widen `requestControl` or create a loopback endpoint.

- [x] **Step 6: Run IPC, service, type, build-electron, and lint checks**

```bash
cd desktop
npx vitest run electron/ipc/capabilities.test.ts electron/services/channel-migration.test.ts
npm run typecheck
npm run build:electron
npx eslint --quiet electron/ipc/channels.ts electron/ipc/capabilities.ts electron/ipc/capabilities.test.ts electron/main.ts electron/preload.ts src/lib/desktopHost/index.ts
```

Expected: all exit 0.

- [x] **Step 7: Commit the host boundary**

```bash
git add desktop/electron/ipc/channels.ts desktop/electron/ipc/capabilities.ts desktop/electron/ipc/capabilities.test.ts desktop/electron/main.ts desktop/electron/preload.ts desktop/src/lib/desktopHost/index.ts
git commit -m "feat: expose safe channel migration IPC"
```

### Task 4: Explicit migration UI in 接入渠道

**Files:**

- Create: `desktop/src/components/control/ChannelMigrationCard.tsx`
- Create: `desktop/src/components/control/ChannelMigrationCard.test.tsx`
- Modify: `desktop/src/components/control/ProvidersControlView.tsx`
- Create or modify: `desktop/src/components/control/ProvidersControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write the migration card RED tests**

Install a typed mock `window.desktopHost`. Prove:

- mount performs zero preview/apply calls;
- “检查现有 Dao 配置” calls preview once;
- safe counts and provider names render, but token/path/URL/secret fixtures do not;
- clicking “导入渠道与路由” opens a dialog but does not call apply;
- cancel performs zero writes;
- explicit “确认导入” submits only the token once;
- busy state disables repeated confirmation;
- an older preview response cannot overwrite a newer response or unmounted component;
- apply drift/error keeps preview and allows re-check.

Use a preview fixture with `providerNames: ['glm', 'mimo', '鸡米花']` and assert the 64-route priority sentence.

- [x] **Step 2: Run UI tests and confirm RED**

Expected: FAIL because `ChannelMigrationCard` does not exist.

- [x] **Step 3: Implement the isolated card**

Use local React state only:

```ts
type Phase =
  | "idle"
  | "previewing"
  | "ready"
  | "confirming"
  | "applying"
  | "success"
  | "error";
```

Use a sequence ref and effect cleanup so stale preview/apply promises cannot mutate current state. Do not persist token in localStorage or render it. The card accepts `onMigrated(): Promise<void> | void`; it calls this only after successful apply.

The confirmation dialog must say:

- “将导入现有 Dao 的渠道、自定义模型和完整路由。”
- “同名配置以现有 Dao 为准；Desktop 独有渠道保留。”
- “原路由 priority 顺序不会被优化或重排。”
- “确认前不会写配置；写入前会创建私有备份。”

- [x] **Step 4: Compose into Providers and prove refresh behavior**

Render the card after runtime metrics and before manual provider editing:

```tsx
<ChannelMigrationCard onMigrated={refresh} />
```

The integration test must assert the successful apply triggers only the existing providers/overview/usage GET refresh. It must not call probe, provider POST/DELETE, model refresh, route save, or priority save endpoints.

- [x] **Step 5: Add scoped styles**

Add only `.channel-migration-*` selectors using existing theme tokens. Provide a compact counts grid, scroll-safe provider chips, visible confirmation backdrop, focus state, disabled state, and the existing mobile breakpoint. Do not alter global button behavior.

- [x] **Step 6: Run focused UI, full Desktop, type, and lint checks**

```bash
cd desktop
npx vitest run src/components/control/ChannelMigrationCard.test.tsx src/components/control/ProvidersControlView.test.tsx electron/services/channel-migration.test.ts electron/ipc/capabilities.test.ts
npm test
npm run typecheck
npm run lint
```

Expected: focused and full tests pass; lint has zero errors.

- [x] **Step 7: Commit the explicit UI**

```bash
git add desktop/src/components/control/ChannelMigrationCard.tsx desktop/src/components/control/ChannelMigrationCard.test.tsx desktop/src/components/control/ProvidersControlView.tsx desktop/src/components/control/ProvidersControlView.test.tsx desktop/src/theme/globals.css
git commit -m "feat: add explicit Dao channel import"
```

### Task 5: Execute migration and visible Mac acceptance

**Files:**

- Runtime data only through the App's confirmed UI action.
- Modify after acceptance: `desktop/README.md`
- Modify after acceptance: `docs/DAO_DESKTOP_PARITY.md`
- Modify after acceptance: `docs/superpowers/specs/2026-08-10-dao-channel-migration-design.md`
- Modify after acceptance: `docs/superpowers/plans/2026-08-10-dao-channel-migration.md`

- [x] **Step 1: Capture a safe pre-migration baseline**

Use a local script that prints only object keys and counts. Record Desktop gateway hash, provider names, custom model names, route count, and mode bits. Do not print URLs, keys, model payloads, route payloads, or source/destination contents.

Expected baseline at design time: source 25/9/64 and Desktop 2/1/3. If counts changed, use the live counts and verify the same invariants rather than forcing design-time numbers.

- [x] **Step 2: Run the full build/package matrix**

```bash
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
npm test
cd desktop
npm test
npm run typecheck
npm run lint
npm run build
npm run build:electron
npm run pack:mac
```

Expected: all commands exit 0; lint has zero errors; `release/mac-arm64/Dao Flow.app` exists.

- [x] **Step 3: Install the new App recoverably**

Fully quit the current App, wait for its process and runtime to exit, move the installed App to a timestamped backup, `ditto` the new package into `/Applications/Dao Flow.app`, preserve `/Users/a77/Desktop/Dao Flow.app`, and cold-launch it. Never delete either config file or an App backup.

- [x] **Step 4: Perform the migration through visible UI**

In `接入渠道`:

1. Verify the migration card is idle and no config changed on page load.
2. Click “检查现有 Dao 配置”.
3. Verify safe counts/names and absence of paths, URLs, keys, raw config, and token.
4. Open the confirmation dialog and verify the priority/backup wording.
5. Click “确认导入” once.
6. Verify success and provider/route metrics refresh without a probe request.

- [x] **Step 5: Verify exact data and security invariants**

With a safe local verifier, assert:

- every source provider/customModel exists in target and same-name JSON values deep-equal;
- every source route object deep-equals target, and every custom-model `channels` array deep-equals target in the same order;
- Desktop-only provider/customModel from the baseline remains;
- target gateway hash equals baseline;
- backup exists and config/backup/audit modes are `0600`;
- audit JSON contains only allowed keys;
- migration preview, IPC DTO, error text, and audit contain no source/destination path, base URL, API Key, Authorization, raw token, or raw config.

- [x] **Step 6: Cold-relaunch and verify persistence**

Quit completely, wait, relaunch, and verify the imported channel/model/route counts remain. Confirm a second preview is available but no background apply occurs. Confirm route priority/provider/model selection is unchanged from the source order.

- [x] **Step 7: Update docs and mark implemented**

Document the one-shot explicit import, merge rules, backup, no-auto-sync boundary, verification counts, and installed App. Change the design status to `已实现并验收` and tick completed plan steps.

- [x] **Step 8: Run final scope and secret scans**

```bash
git diff --check
git diff --name-only 6da0bb0..HEAD
rg -n "T[B]D|implement la[t]er|Authorization:|Bearer |/Users/|/home/|apiKey" \
  desktop/electron/services/channel-migration* \
  desktop/src/components/control/ChannelMigrationCard* \
  desktop/src/components/control/ProvidersControlView*
```

Expected: only planned files changed; scans find test fixtures, sanitizer/validation patterns, or existing provider form fields only—never shipped secrets, paths, placeholders, or a renderer payload leak.

- [x] **Step 9: Commit acceptance docs**

```bash
git add desktop/README.md docs/DAO_DESKTOP_PARITY.md docs/superpowers/specs/2026-08-10-dao-channel-migration-design.md docs/superpowers/plans/2026-08-10-dao-channel-migration.md
git commit -m "docs: complete Dao channel migration acceptance"
```

### Task 6: Close final review findings

- [x] Share migration DTO/count contracts between main and renderer.
- [x] Reject array-shaped provider/custom-model/route structures.
- [x] Add service-level apply mutual exclusion, bounded/expiring preview plans, and double-token concurrency coverage.
- [x] Recheck source and target after backup, then complete the default atomic write synchronously without an intervening event-loop yield.
- [x] Verify exact merged provider/model/route counts plus the runtime-loaded configuration fingerprint; return a restart instruction when they do not match.
- [x] Separate successful apply from a subsequent page-refresh failure and show conflict counts in the preview.
- [x] Re-run root 351/351, Desktop 48 files / 169 tests, typecheck, lint, builds, macOS packaging, cold launch, and installed runtime fingerprint verification; repeat the critical runtime suite and typecheck in an isolated clean worktree.
