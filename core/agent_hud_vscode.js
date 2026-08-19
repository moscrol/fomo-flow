"use strict";

const { createAgentHudController } = require("./agent_hud");

const PINNED_KEY = "dao.agentHud.pinnedKey";
const WARNING_COLOR = "statusBarItem.warningBackground";

function cleanText(value, limit) {
  const text = typeof value === "string"
    ? value.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return typeof limit === "number" ? text.slice(0, limit) : text;
}

function basename(value) {
  const clean = cleanText(value, 2_000).replace(/\\/g, "/");
  return clean ? clean.split("/").filter(Boolean).at(-1) || "" : "";
}

function nonnegativeNumber(value) {
  if (value == null || typeof value === "boolean" || value === "") return 0;
  let number;
  try { number = Number(value); } catch { return 0; }
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function safeMode(value) {
  return value === "on" || value === "off" || value === "auto" ? value : "auto";
}

function verificationStatus(value) {
  const verification = value && value.verification && typeof value.verification === "object"
    ? value.verification
    : {};
  if (verification.blocking === true) return "blocked";
  const status = cleanText(verification.latestTestStatus, 40).toLowerCase();
  if (status === "failed") return "failed";
  if (["passed", "pass", "success", "succeeded", "ok"].includes(status)) return "passed";
  if (["running", "pending", "skipped"].includes(status)) return status;
  return "test?";
}

function safeSessionPresentation(value = {}, goalLimit = 120) {
  const todo = value.todo && typeof value.todo === "object" ? value.todo : {};
  const activation = value.activation && typeof value.activation === "object" ? value.activation : {};
  return {
    goal: cleanText(value.goal, goalLimit) || "Untitled session",
    workspace: cleanText(basename(value.workspace), 120) || "workspace",
    phase: cleanText(value.phase, 60) || "start",
    completed: nonnegativeNumber(todo.completed),
    total: nonnegativeNumber(todo.total),
    verification: verificationStatus(value),
    mode: safeMode(value.mode),
    activationReason: cleanText(activation.reason, 40),
    updatedAt: nonnegativeNumber(value.updatedAt),
    identityKind: value.identity && value.identity.kind === "derived" ? "derived" : "native",
  };
}

function updatedAge(updatedAt, currentTime) {
  if (!updatedAt) return "unknown";
  const elapsed = Math.max(0, nonnegativeNumber(currentTime) - updatedAt);
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function sessionItem(value = {}, currentTime = Date.now()) {
  const presentation = safeSessionPresentation(value, 72);
  const derived = presentation.identityKind === "derived" ? " · derived" : "";
  const reason = presentation.activationReason ? `/${presentation.activationReason}` : "";
  return {
    label: presentation.goal,
    description: `${presentation.workspace} · ${presentation.mode}${reason}${derived}`,
    detail: `${presentation.phase} · ${presentation.completed}/${presentation.total} · ${presentation.verification} · updated ${updatedAge(presentation.updatedAt, currentTime)}`,
    _key: value.key,
  };
}

function createAgentHudVscode(vscode, context, options = {}) {
  const daoItem = options.daoItem;
  const commandId = options.commandId || "fomo.agentHud";
  const globalMode = typeof options.globalMode === "function" ? options.globalMode : () => "invert";
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setIntervalFn = typeof options.setIntervalFn === "function" ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === "function" ? options.clearIntervalFn : clearInterval;
  const renderLegacyDao = typeof options.renderLegacyDao === "function" ? options.renderLegacyDao : () => {};
  const workspaceState = context && context.workspaceState;
  const agentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  agentItem.command = commandId;
  agentItem.hide();

  let source = null;
  let subscription = null;
  let bindingHealthy = false;
  let bindingGeneration = 0;
  let disposed = false;

  function readInitialPinnedKey() {
    try {
      const key = workspaceState && typeof workspaceState.get === "function"
        ? workspaceState.get(PINNED_KEY, null)
        : null;
      return typeof key === "string" && key ? key : null;
    } catch {
      return null;
    }
  }

  let desiredPinnedKey = readInitialPinnedKey();
  let pendingPinnedKey = desiredPinnedKey;

  function makeController() {
    return createAgentHudController({
      now: options.now,
      activeTtlMs: options.activeTtlMs,
      staleTtlMs: options.staleTtlMs,
      readPinnedKey: () => null,
      writePinnedKey: (key) => {
        desiredPinnedKey = typeof key === "string" && key ? key : null;
        if (!desiredPinnedKey) pendingPinnedKey = null;
        return workspaceState && typeof workspaceState.update === "function"
          ? workspaceState.update(PINNED_KEY, desiredPinnedKey)
          : undefined;
      },
    });
  }

  let controller = makeController();

  function hideAgent() {
    try { agentItem.hide(); } catch { /* Activation must survive a UI disposal race. */ }
  }

  function inactive() {
    hideAgent();
    try { agentItem.backgroundColor = undefined; } catch { /* The item may already be disposed. */ }
    try { renderLegacyDao(); } catch { /* Legacy rendering must not break activation. */ }
    return false;
  }

  function disposeSubscription() {
    const current = subscription;
    subscription = null;
    if (!current || typeof current.dispose !== "function") return;
    try { current.dispose(); } catch { /* A source teardown cannot break activation. */ }
  }

  function restorePendingPin() {
    if (!pendingPinnedKey) return false;
    const key = pendingPinnedKey;
    if (!controller.list().some((value) => value.key === key)) return false;
    controller.setPinned(key);
    pendingPinnedKey = null;
    return true;
  }

  function refresh() {
    if (disposed || !source || !bindingHealthy) return inactive();
    try {
      const statusOptions = typeof source.agentStatusOptions === "function"
        ? source.agentStatusOptions()
        : { enabled: true, hud: { enabled: true } };
      const settings = statusOptions && typeof statusOptions === "object" ? statusOptions : {};
      const hudSettings = settings.hud && typeof settings.hud === "object" ? settings.hud : {};
      controller.configure(hudSettings);
      if (settings.enabled === false || hudSettings.enabled === false) {
        return inactive();
      }

      const view = controller.project({ globalMode: globalMode() });
      if (!view || view.kind === "idle" || !view.agent) {
        return inactive();
      }

      daoItem.text = view.dao.text;
      daoItem.tooltip = view.dao.tooltip;
      daoItem.show();
      agentItem.text = view.agent.text;
      agentItem.tooltip = view.agent.tooltip;
      agentItem.backgroundColor = view.agent.warning
        ? new vscode.ThemeColor(WARNING_COLOR)
        : undefined;
      agentItem.show();
      return true;
    } catch {
      return inactive();
    }
  }

  function bindSource(nextSource) {
    bindingGeneration += 1;
    if (disposed) return false;
    disposeSubscription();
    bindingHealthy = false;
    source = nextSource || null;
    pendingPinnedKey = desiredPinnedKey;
    controller = makeController();
    if (!source) {
      return inactive();
    }

    let failed = false;
    try {
      const values = source.agentStatusList();
      if (!Array.isArray(values)) throw new TypeError("agentStatusList must return an array");
      for (const value of values) controller.update(value);
      restorePendingPin();
    } catch {
      failed = true;
    }

    try {
      const subscribedSource = source;
      const subscribedGeneration = bindingGeneration;
      const nextSubscription = source.agentStatusSubscribe((value) => {
        if (source !== subscribedSource || bindingGeneration !== subscribedGeneration) return;
        try {
          controller.update(value);
          restorePendingPin();
          if (bindingHealthy) refresh();
        } catch {
          inactive();
        }
      });
      if (!nextSubscription || typeof nextSubscription.dispose !== "function") {
        throw new TypeError("agentStatusSubscribe must return a disposable");
      }
      subscription = nextSubscription;
    } catch {
      subscription = null;
      failed = true;
    }

    if (failed) {
      return inactive();
    }
    bindingHealthy = true;
    return refresh();
  }

  async function showInformation(message) {
    try { await vscode.window.showInformationMessage(message); } catch { /* UI cancellation is harmless. */ }
  }

  async function showModeWarning() {
    const message = "Unable to change this Agent HUD session mode.";
    try {
      if (typeof vscode.window.showWarningMessage === "function") {
        await vscode.window.showWarningMessage(message);
      } else if (typeof vscode.window.showErrorMessage === "function") {
        await vscode.window.showErrorMessage(message);
      }
    } catch {
      // Do not surface a secondary UI failure.
    }
  }

  async function open() {
    const openedSource = source;
    const openedController = controller;
    const openedGeneration = bindingGeneration;
    const isCurrent = () => !disposed && bindingHealthy &&
      source === openedSource && controller === openedController && bindingGeneration === openedGeneration;
    if (!openedSource) {
      await showInformation("Agent HUD is unavailable until Dao routing starts.");
      return;
    }
    if (!bindingHealthy) {
      await showInformation("Agent HUD updates are unavailable.");
      return;
    }

    let values;
    try {
      values = openedController.list().sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    } catch {
      hideAgent();
      return;
    }
    if (!values.length) {
      await showInformation("No Agent HUD sessions yet.");
      return;
    }

    let picked;
    try {
      picked = await vscode.window.showQuickPick(values.map((value) => sessionItem(value, now())), {
        placeHolder: "Agent HUD · select a conversation",
        matchOnDescription: true,
        matchOnDetail: true,
      });
    } catch {
      return;
    }
    if (!picked || !isCurrent()) return;
    const current = values.find((value) => value.key === picked._key);
    if (!current) return;

    let projection;
    try {
      projection = openedController.project({ globalMode: globalMode() });
    } catch {
      hideAgent();
      return;
    }
    const isPinned = projection.kind === "pinned" && projection.key === current.key;
    const actions = [
      { label: isPinned ? "Unpin" : "Pin to HUD", _action: isPinned ? "unpin" : "pin" },
      { label: "Set Auto", _action: "auto" },
      { label: "Set On", _action: "on" },
      { label: "Set Off", _action: "off" },
      { label: "Show details", _action: "details" },
    ];

    let action;
    try {
      action = await vscode.window.showQuickPick(actions, {
        placeHolder: `${cleanText(current.goal, 60) || "Agent session"} · choose action`,
      });
    } catch {
      return;
    }
    if (!action || !isCurrent()) return;

    if (action._action === "pin") {
      pendingPinnedKey = null;
      desiredPinnedKey = current.key;
      openedController.setPinned(current.key);
      refresh();
      return;
    }
    if (action._action === "unpin") {
      pendingPinnedKey = null;
      desiredPinnedKey = null;
      openedController.setPinned(null);
      refresh();
      return;
    }
    if (action._action === "details") {
      const presentation = safeSessionPresentation(current);
      await showInformation(
        `${presentation.goal} · ${presentation.workspace} · ` +
        `phase=${presentation.phase} · todo=${presentation.completed}/${presentation.total} · ` +
        `verification=${presentation.verification} · ` +
        `mode=${presentation.mode} · identity=${presentation.identityKind}`,
      );
      return;
    }

    try {
      const updated = await openedSource.agentStatusSetMode(current.key, action._action);
      if (!isCurrent()) return;
      if (!updated) {
        await showModeWarning();
        return;
      }
      openedController.update(updated);
      refresh();
    } catch {
      if (!isCurrent()) return;
      await showModeWarning();
    }
  }

  let timer = null;
  try {
    timer = setIntervalFn(refresh, 2_000);
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch {
    timer = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    bindingGeneration += 1;
    bindingHealthy = false;
    source = null;
    if (timer != null) {
      try { clearIntervalFn(timer); } catch { /* Timer cleanup is best effort. */ }
      timer = null;
    }
    disposeSubscription();
    try { agentItem.dispose(); } catch { /* VS Code may already be shutting down. */ }
  }

  const adapter = {
    refresh,
    bindSource,
    open,
    dispose,
    get controller() { return controller; },
  };
  bindSource(options.source || null);
  return adapter;
}

module.exports = { createAgentHudVscode, sessionItem };
