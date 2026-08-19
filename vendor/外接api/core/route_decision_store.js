"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sanitizeRouteText } = require("./route_planner");

const PREFLIGHT_TTL_MS = 5 * 60 * 1000;
const MAX_RESERVATIONS = 100;
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE = 200;
const MAX_EVENTS = 30;
const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INBOX = 200;
const INBOX_CLASSIFICATIONS = [
  "budget_rejected",
  "all_unavailable",
  "exhausted",
  "repeated_fallback",
  "advisory_divergence",
  "budget_unverified",
  "plan_drift",
];

function _now(source) {
  return typeof source === "function" ? Number(source()) : Date.now();
}

function _enum(value, allowed, fallback = null) {
  return allowed.includes(value) ? value : fallback;
}

function _metadata(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const numberOrNull = (candidate) => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    model: String(input.model || "").slice(0, 120),
    profile: _enum(input.profile, ["balanced", "coding", "fast", "cheap", "reliable", "offline"], "balanced"),
    budgetUsd: numberOrNull(input.budgetUsd),
    budgetFallback: _enum(input.budgetFallback, ["strict", "cheapest"]),
    stream: input.stream !== false,
    usesTools: input.usesTools === true,
    thinkingEnabled: input.thinkingEnabled === true,
    reasoningEffort: _enum(input.reasoningEffort, ["low", "medium", "high", "xhigh"]),
  };
}

function _metadataFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(_metadata(value))).digest("hex");
}

function _hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function _clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _safeCandidate(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = Number(input.actualPriority);
  const rank = Number(input.advisoryRank);
  return {
    provider: sanitizeRouteText(input.provider, 100),
    model: sanitizeRouteText(input.model, 100),
    source: sanitizeRouteText(input.source, 40),
    actualPriority: Number.isInteger(number) && number > 0 ? number : null,
    advisoryRank: Number.isInteger(rank) && rank > 0 ? rank : null,
  };
}

function _safePlan(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const candidates = (items) => (Array.isArray(items) ? items : []).slice(0, 20).map(_safeCandidate);
  const budget = input.budget && typeof input.budget === "object" ? input.budget : {};
  return {
    planId: sanitizeRouteText(input.planId, 96),
    model: sanitizeRouteText(input.model, 120),
    profile: _enum(input.profile, ["balanced", "coding", "fast", "cheap", "reliable", "offline"], "balanced"),
    strategy: input.strategy === "random" ? "random" : "priority",
    configuredOrder: candidates(input.configuredOrder),
    dispatchOrder: candidates(input.dispatchOrder),
    excluded: (Array.isArray(input.excluded) ? input.excluded : []).slice(0, 20).map((item) => ({
      ..._safeCandidate(item),
      reason: _enum(item && item.reason, ["missing_provider", "disabled", "circuit_open", "incompatible"], "incompatible"),
    })),
    advisoryOrder: candidates(input.advisoryOrder),
    budget: {
      status: _enum(
        budget.status,
        ["not_requested", "unverified", "within_cap", "strict_rejected", "cheapest_override"],
        "not_requested",
      ),
      capUsd: Number.isFinite(Number(budget.capUsd)) ? Number(budget.capUsd) : null,
      fallback: _enum(budget.fallback, ["strict", "cheapest"]),
      overBudgetFallback: budget.overBudgetFallback === true,
    },
  };
}

function _planSignature(value) {
  const plan = _safePlan(value);
  return _hash(
    JSON.stringify({
      model: plan.model,
      profile: plan.profile,
      strategy: plan.strategy,
      configuredOrder: plan.configuredOrder.map((item) => [item.provider, item.model, item.actualPriority]),
      dispatchOrder: plan.dispatchOrder.map((item) => [item.provider, item.model, item.actualPriority]),
      excluded: plan.excluded.map((item) => [item.provider, item.model, item.actualPriority, item.reason]),
      budget: plan.budget,
    }),
  );
}

function _safeEvent(value, atMs) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = _enum(input.kind, ["attempt", "skip", "fallback"], "attempt");
  const status = Number(input.status);
  const durationMs = Number(input.durationMs);
  return {
    kind,
    at: new Date(atMs).toISOString(),
    provider: sanitizeRouteText(input.provider, 100),
    model: sanitizeRouteText(input.model, 100),
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
    reason: _enum(input.reason, ["missing_provider", "disabled", "circuit_open", "incompatible", "upstream", "transport", "auth", "quota", "request", "not_found"]),
  };
}

function _safeOutcome(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    status: _enum(input.status, ["selected", "budget_rejected", "exhausted"], "exhausted"),
    provider: sanitizeRouteText(input.provider, 100),
    model: sanitizeRouteText(input.model, 100),
    actualPriority:
      Number.isInteger(Number(input.actualPriority)) && Number(input.actualPriority) > 0
        ? Number(input.actualPriority)
        : null,
    failureClass: _enum(input.failureClass, ["auth", "not_found", "quota", "request", "transport", "upstream", "unavailable", "unknown", "budget"], "unknown"),
  };
}

function _decisionTemplate(classification) {
  return {
    budget_rejected: {
      severity: "urgent",
      title: "本次预算不够",
      message: "所有已知渠道都超过严格预算，需要提高预算或手动调整配置。",
    },
    all_unavailable: {
      severity: "urgent",
      title: "当前没有可用渠道",
      message: "配置里的渠道都被停用、缺失、不兼容或暂时熔断。",
    },
    exhausted: {
      severity: "urgent",
      title: "这次所有渠道都失败了",
      message: "请查看路由证据，再决定是否修改渠道或预算。",
    },
    repeated_fallback: {
      severity: "warning",
      title: "首选渠道没有接住请求",
      message: "请求使用了后备渠道，规定优先级没有被自动修改。",
    },
    advisory_divergence: {
      severity: "review",
      title: "参考建议与规定顺序不同",
      message: "建议只供比较；是否调整优先级仍由你决定。",
    },
    budget_unverified: {
      severity: "review",
      title: "预算暂时无法核实",
      message: "至少一个候选缺少价格信息，FOMO FLOW 没有猜测成本。",
    },
    plan_drift: {
      severity: "warning",
      title: "预演后路由事实发生变化",
      message: "实际发送时的渠道资格与预演不同，请查看证据。",
    },
  }[classification];
}

function _loadInbox(statePath) {
  if (!statePath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
    return items.slice(0, MAX_INBOX).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const classification = _enum(item.classification, INBOX_CLASSIFICATIONS);
      const status = _enum(item.status, ["open", "acknowledged", "snoozed"], "open");
      const fingerprint = String(item.fingerprint || "");
      const id = String(item.id || "");
      if (!classification || !/^[a-f0-9]{64}$/.test(fingerprint) || !/^decision-[a-f0-9]{24}$/.test(id)) return [];
      return [{
        id,
        fingerprint,
        classification,
        status,
        count: Math.max(1, Math.floor(Number(item.count) || 1)),
        firstSeenAtMs: Math.max(0, Number(item.firstSeenAtMs) || 0),
        lastSeenAtMs: Math.max(0, Number(item.lastSeenAtMs) || 0),
        snoozedUntilMs: Math.max(0, Number(item.snoozedUntilMs) || 0),
        evidenceId: /^evidence-[a-f0-9]{24}$/.test(String(item.evidenceId || ""))
          ? String(item.evidenceId)
          : null,
      }];
    });
  } catch (_) {
    return [];
  }
}

function _persistInbox(statePath, inbox) {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const body = JSON.stringify({
    version: 1,
    items: inbox.map((item) => ({
      id: item.id,
      fingerprint: item.fingerprint,
      classification: item.classification,
      status: item.status,
      count: item.count,
      firstSeenAtMs: item.firstSeenAtMs,
      lastSeenAtMs: item.lastSeenAtMs,
      snoozedUntilMs: item.snoozedUntilMs,
      evidenceId: item.evidenceId,
    })),
  });
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function createRouteDecisionStore(options = {}) {
  const reservations = [];
  const evidence = [];
  const inbox = _loadInbox(options.statePath);
  const nowSource = options.now || Date.now;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const statePath = options.statePath || null;

  function mergeDecision(classification, context, evidenceId = null) {
    if (!INBOX_CLASSIFICATIONS.includes(classification)) return null;
    const current = _now(nowSource);
    const fingerprint = _hash(`${classification}|${String(context || "")}`);
    let item = inbox.find((candidate) => candidate.fingerprint === fingerprint);
    if (!item) {
      item = {
        id: `decision-${fingerprint.slice(0, 24)}`,
        fingerprint,
        classification,
        status: "open",
        count: 0,
        firstSeenAtMs: current,
        lastSeenAtMs: current,
        snoozedUntilMs: 0,
        evidenceId: null,
      };
      inbox.push(item);
    }
    item.count += 1;
    item.lastSeenAtMs = current;
    if (evidenceId) item.evidenceId = evidenceId;
    return item;
  }

  function mergePlanRules(plan) {
    const safePlan = _safePlan(plan);
    const context = _hash(`${safePlan.model}|${safePlan.profile}`);
    if (safePlan.budget.status === "strict_rejected") mergeDecision("budget_rejected", context);
    if (safePlan.budget.status === "unverified") mergeDecision("budget_unverified", context);
    if (safePlan.dispatchOrder.length === 0 && safePlan.budget.status !== "strict_rejected") {
      mergeDecision("all_unavailable", context);
    }
    if (safePlan.advisoryOrder[0] && safePlan.advisoryOrder[0].actualPriority !== 1) {
      mergeDecision("advisory_divergence", context);
    }
  }

  function prune() {
    const current = _now(nowSource);
    for (let index = reservations.length - 1; index >= 0; index -= 1) {
      if (reservations[index].expiresAtMs <= current || reservations[index].consumed) {
        reservations.splice(index, 1);
      }
    }
    if (reservations.length > MAX_RESERVATIONS) {
      reservations.splice(0, reservations.length - MAX_RESERVATIONS);
    }
    while (evidence.length && evidence[0].createdAtMs <= current - EVIDENCE_TTL_MS) {
      evidence.shift();
    }
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
    for (let index = inbox.length - 1; index >= 0; index -= 1) {
      if (inbox[index].lastSeenAtMs <= current - INBOX_TTL_MS) inbox.splice(index, 1);
    }
    if (inbox.length > MAX_INBOX) {
      inbox.sort((left, right) => left.lastSeenAtMs - right.lastSeenAtMs);
      inbox.splice(0, inbox.length - MAX_INBOX);
    }
  }

  return {
    reservePreflight(plan, metadata) {
      prune();
      const current = _now(nowSource);
      const record = {
        planId: String((plan && plan.planId) || "").slice(0, 96),
        fingerprint: _metadataFingerprint(metadata),
        planSignature: _planSignature(plan),
        createdAt: new Date(current).toISOString(),
        expiresAt: new Date(current + PREFLIGHT_TTL_MS).toISOString(),
        expiresAtMs: current + PREFLIGHT_TTL_MS,
        consumed: false,
      };
      reservations.push(record);
      mergePlanRules(plan);
      prune();
      _persistInbox(statePath, inbox);
      return _clone(record);
    },

    consumeMatchingPreflight(metadata) {
      prune();
      const fingerprint = _metadataFingerprint(metadata);
      for (let index = reservations.length - 1; index >= 0; index -= 1) {
        const record = reservations[index];
        if (record.fingerprint !== fingerprint || record.consumed) continue;
        record.consumed = true;
        const result = _clone(record);
        prune();
        return result;
      }
      return null;
    },

    beginEvidence(plan, link) {
      prune();
      const current = _now(nowSource);
      const safePlan = _safePlan(plan);
      const drifted = Boolean(
        link && link.planSignature && link.planSignature !== _planSignature(safePlan),
      );
      const record = {
        id: `evidence-${randomBytes(12).toString("hex")}`,
        planId: safePlan.planId,
        linkedPreflightPlanId: sanitizeRouteText(link && link.planId, 96) || null,
        createdAt: new Date(current).toISOString(),
        createdAtMs: current,
        plan: safePlan,
        events: [
          { kind: "plan", at: new Date(current).toISOString() },
          ...(drifted ? [{ kind: "plan_drift", at: new Date(current).toISOString() }] : []),
        ],
        outcome: null,
      };
      evidence.push(record);
      if (drifted) {
        mergeDecision("plan_drift", _hash(`${safePlan.model}|${safePlan.profile}`), record.id);
        _persistInbox(statePath, inbox);
      }
      prune();
      return _clone(record);
    },

    appendEvidence(evidenceId, event) {
      prune();
      const record = evidence.find((item) => item.id === evidenceId);
      if (!record || record.outcome) return null;
      record.events.push(_safeEvent(event, _now(nowSource)));
      if (record.events.length > MAX_EVENTS) {
        record.events.splice(1, record.events.length - MAX_EVENTS);
      }
      return _clone(record);
    },

    finishEvidence(evidenceId, outcome) {
      prune();
      const record = evidence.find((item) => item.id === evidenceId);
      if (!record || record.outcome) return null;
      record.outcome = _safeOutcome(outcome);
      record.events.push({
        kind: "outcome",
        at: new Date(_now(nowSource)).toISOString(),
        ...record.outcome,
      });
      if (record.events.length > MAX_EVENTS) {
        record.events.splice(1, record.events.length - MAX_EVENTS);
      }
      const context = _hash(`${record.plan.model}|${record.plan.profile}`);
      if (record.outcome.status === "budget_rejected") {
        mergeDecision("budget_rejected", context, record.id);
      } else if (record.outcome.status === "exhausted") {
        mergeDecision("exhausted", context, record.id);
      } else if (record.outcome.actualPriority && record.outcome.actualPriority > 1) {
        mergeDecision("repeated_fallback", context, record.id);
      }
      _persistInbox(statePath, inbox);
      return _clone(record);
    },

    listEvidence(limit = 50) {
      prune();
      const bounded = Math.max(1, Math.min(MAX_EVIDENCE, Number.parseInt(limit, 10) || 50));
      return evidence.slice(-bounded).reverse().map(_clone);
    },

    listInbox(limit = 50) {
      prune();
      const bounded = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 50));
      return inbox
        .slice()
        .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)
        .slice(0, bounded)
        .map((item) => {
          const template = _decisionTemplate(item.classification);
          return {
            id: item.id,
            classification: item.classification,
            severity: template.severity,
            title: template.title,
            message: template.message,
            status: item.status,
            count: item.count,
            firstSeenAt: new Date(item.firstSeenAtMs).toISOString(),
            lastSeenAt: new Date(item.lastSeenAtMs).toISOString(),
            snoozedUntil:
              item.snoozedUntilMs > 0 ? new Date(item.snoozedUntilMs).toISOString() : null,
            evidenceId: item.evidenceId,
          };
        });
    },

    acknowledge(id) {
      prune();
      const item = inbox.find((candidate) => candidate.id === id);
      if (!item) return null;
      item.status = "acknowledged";
      item.snoozedUntilMs = 0;
      _persistInbox(statePath, inbox);
      return this.listInbox(MAX_INBOX).find((candidate) => candidate.id === id) || null;
    },

    snooze(id, untilMs) {
      prune();
      const item = inbox.find((candidate) => candidate.id === id);
      const until = Number(untilMs);
      if (!item || !Number.isFinite(until) || until <= _now(nowSource)) return null;
      item.status = "snoozed";
      item.snoozedUntilMs = until;
      _persistInbox(statePath, inbox);
      return this.listInbox(MAX_INBOX).find((candidate) => candidate.id === id) || null;
    },
  };
}

module.exports = {
  PREFLIGHT_TTL_MS,
  EVIDENCE_TTL_MS,
  INBOX_TTL_MS,
  createRouteDecisionStore,
};
