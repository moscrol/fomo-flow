"use strict";

(function bootstrapWebHud() {
  const STORAGE_KEY = "dao.webHud.selectedSession.v1";
  const state = {
    snapshot: null,
    selectedSessionId: "",
    surfaceFilter: "all",
    source: null,
    failures: 0,
    pollTimer: null,
    retryTimer: null,
    ageTimer: null,
    connection: "connecting",
  };

  try {
    state.selectedSessionId = localStorage.getItem(STORAGE_KEY) || "";
  } catch {}

  const elements = {};
  for (const id of [
    "connectionState",
    "runtimeMode",
    "runtimePort",
    "refreshAge",
    "codexToolSurface",
    "kpiSessions",
    "kpiSessionsNote",
    "kpiHitRate",
    "kpiCached",
    "kpiCacheWrite",
    "kpiWarnings",
    "kpiTokens",
    "kpiCalls",
    "kpiCircuits",
    "kpiWarmups",
    "sessionCount",
    "sessionList",
    "sessionListEmpty",
    "detailBadges",
    "emptyState",
    "detailContent",
    "detailGoal",
    "detailSurface",
    "detailWorkspace",
    "detailSessionId",
    "detailPhase",
    "detailProgressText",
    "detailProgress",
    "detailCurrentTodo",
    "detailUid",
    "detailProvider",
    "detailModel",
    "detailVerification",
    "detailBlocking",
    "detailFailures",
    "detailToolState",
    "detailCacheRate",
    "detailCacheTokens",
    "detailFreshness",
    "detailMode",
    "detailReasoningTokens",
    "detailTtft",
    "detailDuration",
    "detailCompactions",
    "detailModelPath",
    "detailLoopSource",
    "detailProviderP50",
    "detailProviderP95",
    "detailCacheHitP95",
    "detailCacheMissP95",
    "providerCount",
    "providerList",
    "providerListEmpty",
    "taskCount",
    "taskRunning",
    "taskAttention",
    "taskEnded",
    "taskList",
    "taskListEmpty",
    "requestRows",
    "requestListEmpty",
    "componentWarnings",
  ])
    elements[id] = document.getElementById(id);

  const compactNumber = new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const integerNumber = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  });
  const timeNumber = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function copy(value, fallback = "—") {
    return typeof value === "string" && value ? value : fallback;
  }

  function setText(target, value) {
    if (target) target.textContent = String(value == null ? "" : value);
  }

  function clear(target) {
    if (!target) return;
    while (target.firstChild) target.removeChild(target.firstChild);
  }

  function create(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }

  function formatTokens(value) {
    return compactNumber.format(finite(value));
  }

  function formatPercent(value) {
    const number = finite(value);
    return `${number.toFixed(number % 1 ? 1 : 0)}%`;
  }

  function formatAge(value) {
    const milliseconds = finite(value);
    if (milliseconds < 1_000) return "刚刚";
    if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)}s`;
    if (milliseconds < 3_600_000)
      return `${Math.floor(milliseconds / 60_000)}m`;
    return `${Math.floor(milliseconds / 3_600_000)}h`;
  }

  function formatTime(value) {
    const timestamp = finite(value);
    return timestamp ? timeNumber.format(new Date(timestamp)) : "—";
  }

  function formatLatency(value) {
    if (value == null || typeof value === "boolean") return "—";
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? `${integerNumber.format(number)} ms`
      : "—";
  }

  function persistSelection() {
    try {
      localStorage.setItem(STORAGE_KEY, state.selectedSessionId);
    } catch {}
  }

  function setConnection(kind, label) {
    state.connection = kind;
    if (!elements.connectionState) return;
    elements.connectionState.className = `connection is-${kind}`;
    const labelNode =
      elements.connectionState.querySelector(".connection-copy");
    setText(labelNode, label);
  }

  function markKpi(target, kind) {
    if (!target || !target.parentElement) return;
    target.parentElement.classList.toggle("has-warning", kind === "warning");
    target.parentElement.classList.toggle("has-error", kind === "error");
  }

  function renderKpis(snapshot) {
    const totals = (snapshot && snapshot.totals) || {};
    const sessions = list(snapshot && snapshot.sessions);
    const policy = (snapshot && snapshot.cachePolicy) || {};
    setText(
      elements.kpiSessions,
      integerNumber.format(finite(totals.activeSessions)),
    );
    setText(
      elements.kpiSessionsNote,
      `${sessions.length} 个已观测 · 每会话隔离`,
    );
    setText(elements.kpiHitRate, formatPercent(totals.hitRate));
    setText(elements.kpiCached, formatTokens(totals.cached));
    setText(elements.kpiCacheWrite, `写入 ${formatTokens(totals.cacheWrite)}`);
    setText(
      elements.kpiWarnings,
      integerNumber.format(finite(totals.warnings)),
    );
    setText(
      elements.kpiTokens,
      formatTokens(finite(totals.input) + finite(totals.output)),
    );
    setText(
      elements.kpiCalls,
      `调用 ${integerNumber.format(finite(totals.calls))}`,
    );
    setText(
      elements.kpiCircuits,
      integerNumber.format(finite(totals.openCircuits)),
    );
    setText(
      elements.kpiWarmups,
      `Warmup ${integerNumber.format(finite(policy.activeWarmups))} · 成功 ${integerNumber.format(finite(policy.warmupSent))}`,
    );
    markKpi(
      elements.kpiWarnings,
      finite(totals.warnings) > 0 ? "warning" : "clean",
    );
    markKpi(
      elements.kpiCircuits,
      finite(totals.openCircuits) > 0 ? "error" : "clean",
    );
  }

  function stateClass(session) {
    if (session.warning) return "is-error";
    if (session.active) return "is-live";
    if (session.lifecycle === "recently-ended" || session.stale)
      return "is-warning";
    return "";
  }

  function chooseSession(sessions) {
    let selected = sessions.find(
      (session) => session.id === state.selectedSessionId,
    );
    if (!selected)
      selected =
        sessions.find((session) => session.active) || sessions[0] || null;
    const nextId = selected ? selected.id : "";
    if (nextId !== state.selectedSessionId) {
      state.selectedSessionId = nextId;
      persistSelection();
    }
    return selected;
  }

  function selectSession(id) {
    state.selectedSessionId = id;
    persistSelection();
    if (state.snapshot) render(state.snapshot);
  }

  function visibleSessions(snapshot) {
    return list(snapshot && snapshot.sessions).filter(
      (session) =>
        state.surfaceFilter === "all" ||
        session.surface === state.surfaceFilter,
    );
  }

  function requestSurface(request) {
    return request && request.source === "codex" ? "codex" : "devin";
  }

  function visibleRequests(snapshot) {
    return list(snapshot && snapshot.recentRequests).filter(
      (request) =>
        state.surfaceFilter === "all" ||
        requestSurface(request) === state.surfaceFilter,
    );
  }

  function renderSessions(snapshot) {
    const sessions = visibleSessions(snapshot);
    const selected = chooseSession(sessions);
    clear(elements.sessionList);
    setText(elements.sessionCount, sessions.length);
    if (elements.sessionListEmpty)
      elements.sessionListEmpty.hidden = sessions.length > 0;

    const fragment = document.createDocumentFragment();
    for (const session of sessions) {
      const button = create("button", "session-item");
      button.type = "button";
      button.setAttribute("role", "listitem");
      button.setAttribute(
        "aria-pressed",
        String(selected && selected.id === session.id),
      );
      if (selected && selected.id === session.id)
        button.classList.add("is-selected");

      const top = create("div", "session-item-top");
      top.appendChild(
        create("span", "session-surface", copy(session.surface, "agent")),
      );
      const dot = create("span", `state-dot ${stateClass(session)}`.trim());
      dot.setAttribute(
        "aria-label",
        session.warning
          ? "告警"
          : session.active
            ? "活跃"
            : session.lifecycle === "recently-ended"
              ? "最近结束"
              : "非活跃",
      );
      top.appendChild(dot);
      button.appendChild(top);
      button.appendChild(
        create("h2", "", copy(session.goal, "未识别任务目标")),
      );

      const meta = create("div", "session-item-meta");
      meta.appendChild(create("span", "", copy(session.phase, "unknown")));
      meta.appendChild(
        create("span", "", copy(session.workspace, "workspace?")),
      );
      meta.appendChild(
        create(
          "span",
          "",
          formatAge(Date.now() - finite(session.latestActivityAt)),
        ),
      );
      button.appendChild(meta);

      const progressRow = create("div", "session-item-progress");
      const total = finite(session.todo && session.todo.total);
      const completed = finite(session.todo && session.todo.completed);
      const progress = create("progress", "mini-progress");
      progress.max = total || 1;
      progress.value = Math.min(completed, total || 1);
      progressRow.appendChild(progress);
      progressRow.appendChild(
        create("strong", "", total ? `${completed}/${total}` : "—"),
      );
      button.appendChild(progressRow);
      button.addEventListener("click", () => selectSession(session.id));
      fragment.appendChild(button);
    }
    elements.sessionList.appendChild(fragment);
    return selected;
  }

  function badge(label, className) {
    return create("span", `status-badge ${className || ""}`.trim(), label);
  }

  function renderDetail(snapshot, session) {
    clear(elements.detailBadges);
    if (!session) {
      if (elements.emptyState) elements.emptyState.hidden = false;
      if (elements.detailContent) elements.detailContent.hidden = true;
      return;
    }
    if (elements.emptyState) elements.emptyState.hidden = true;
    if (elements.detailContent) elements.detailContent.hidden = false;

    if (session.active)
      elements.detailBadges.appendChild(badge("LIVE", "is-live"));
    else if (session.lifecycle === "recently-ended") {
      elements.detailBadges.appendChild(badge("RECENT", "is-warning"));
    }
    if (session.warning)
      elements.detailBadges.appendChild(badge("WARNING", "is-error"));
    else if (session.stale && session.lifecycle !== "recently-ended") {
      elements.detailBadges.appendChild(badge("STALE", "is-warning"));
    }
    elements.detailBadges.appendChild(
      badge(copy(session.mode, "auto"), "is-blue"),
    );

    setText(elements.detailGoal, copy(session.goal, "未识别任务目标"));
    setText(
      elements.detailSurface,
      copy(session.surface, "agent").toUpperCase(),
    );
    setText(elements.detailWorkspace, copy(session.workspace, "workspace?"));
    setText(elements.detailSessionId, `#${copy(session.id)}`);
    setText(elements.detailPhase, copy(session.phase, "unknown").toUpperCase());

    const todo = session.todo || {};
    const total = finite(todo.total);
    const completed = finite(todo.completed);
    setText(
      elements.detailProgressText,
      total ? `${completed} / ${total}` : "未提供计划",
    );
    if (elements.detailProgress) {
      elements.detailProgress.max = total || 1;
      elements.detailProgress.value = Math.min(completed, total || 1);
    }
    setText(elements.detailCurrentTodo, copy(todo.current, "没有结构化待办"));

    const route = session.route || {};
    setText(elements.detailUid, copy(route.modelUid));
    setText(
      elements.detailProvider,
      route.provisional ? "选择中" : copy(route.provider),
    );
    setText(elements.detailModel, copy(route.upstreamModel));

    const verification = session.verification || {};
    setText(
      elements.detailVerification,
      copy(verification.status, "unknown").toUpperCase(),
    );
    setText(
      elements.detailBlocking,
      verification.blocking ? "存在完成阻塞" : "无完成阻塞",
    );
    const failures = session.failures || {};
    setText(
      elements.detailFailures,
      `${integerNumber.format(finite(failures.maxConsecutive))} MAX · ${integerNumber.format(finite(failures.sameCallStreak))} REPEAT`,
    );
    setText(
      elements.detailToolState,
      failures.lastToolOk === true
        ? "最近工具成功"
        : failures.lastToolOk === false
          ? "最近工具失败"
          : "工具状态未知",
    );

    const cache = session.cache || {};
    setText(
      elements.detailCacheRate,
      cache.observed ? formatPercent(cache.hitRate) : "—",
    );
    setText(
      elements.detailCacheTokens,
      cache.observed
        ? `${integerNumber.format(finite(cache.calls))} 次 · 读 ${formatTokens(cache.cached)} · 写 ${formatTokens(cache.cacheWrite)}`
        : "暂无会话缓存样本",
    );
    setText(
      elements.detailFreshness,
      formatAge(Date.now() - finite(session.latestActivityAt)),
    );
    setText(
      elements.detailMode,
      `${copy(session.mode, "auto").toUpperCase()} · ${copy(session.identityKind, "derived")}`,
    );
    const telemetry = session.telemetry || {};
    setText(
      elements.detailReasoningTokens,
      formatTokens(telemetry.reasoningTokens),
    );
    setText(
      elements.detailTtft,
      telemetry.ttftMs == null ? "—" : `${finite(telemetry.ttftMs)} ms`,
    );
    setText(
      elements.detailDuration,
      telemetry.durationMs == null ? "—" : `${finite(telemetry.durationMs)} ms`,
    );
    setText(
      elements.detailCompactions,
      integerNumber.format(finite(telemetry.compactions)),
    );
    setText(
      elements.detailModelPath,
      copy(telemetry.modelPath, "unknown").toUpperCase(),
    );
    setText(
      elements.detailLoopSource,
      copy(telemetry.loopSource, "unknown").toUpperCase(),
    );
    const provider = list(snapshot.providers).find(
      (item) => item && item.id === route.provider,
    );
    const latency = (provider && provider.latency) || {};
    const overall = latency.overall || {};
    const cacheLatency = latency.cache || {};
    setText(elements.detailProviderP50, formatLatency(overall.p50TtftMs));
    setText(elements.detailProviderP95, formatLatency(overall.p95TtftMs));
    setText(
      elements.detailCacheHitP95,
      formatLatency(cacheLatency.hit && cacheLatency.hit.p95TtftMs),
    );
    setText(
      elements.detailCacheMissP95,
      formatLatency(cacheLatency.miss && cacheLatency.miss.p95TtftMs),
    );
  }

  function providerStateLabel(provider) {
    if (provider.state === "circuit-open") return "CIRCUIT";
    if (provider.state === "degraded") return "DEGRADED";
    if (provider.state === "alive") return "ALIVE";
    return "UNKNOWN";
  }

  function providerStateClass(provider) {
    if (provider.state === "circuit-open") return "is-error";
    if (provider.state === "degraded") return "is-warning";
    if (provider.state === "alive") return "is-live";
    return "";
  }

  function metric(label, value) {
    const wrapper = create("span");
    wrapper.appendChild(create("small", "", label));
    wrapper.appendChild(create("strong", "", value));
    return wrapper;
  }

  function renderProviders(snapshot) {
    const providers = list(snapshot.providers);
    clear(elements.providerList);
    setText(elements.providerCount, providers.length);
    if (elements.providerListEmpty)
      elements.providerListEmpty.hidden = providers.length > 0;
    const fragment = document.createDocumentFragment();
    for (const provider of providers) {
      const item = create("article", "provider-item");
      item.setAttribute("role", "listitem");
      const title = create("div", "provider-title");
      const titleMain = create("div", "provider-title-main");
      titleMain.appendChild(
        create("span", `state-dot ${providerStateClass(provider)}`.trim()),
      );
      titleMain.appendChild(create("strong", "", copy(provider.id)));
      title.appendChild(titleMain);
      title.appendChild(create("small", "", providerStateLabel(provider)));
      item.appendChild(title);
      item.appendChild(
        create(
          "div",
          "provider-model",
          copy(provider.model, "尚无实际模型样本"),
        ),
      );

      const metrics = create("div", "provider-metrics");
      if (finite(provider.recentCalls) > 0) {
        metrics.appendChild(
          metric("近期 HIT", formatPercent(provider.recentHitRate)),
        );
      }
      metrics.appendChild(
        metric(
          "累计 HIT",
          finite(provider.calls) > 0 ? formatPercent(provider.hitRate) : "—",
        ),
      );
      metrics.appendChild(
        metric("CALLS", integerNumber.format(finite(provider.calls))),
      );
      metrics.appendChild(
        metric("AGE", provider.ageMs ? formatAge(provider.ageMs) : "—"),
      );
      const latency = provider.latency || {};
      const overall = latency.overall || {};
      const cacheLatency = latency.cache || {};
      metrics.appendChild(metric("P50", formatLatency(overall.p50TtftMs)));
      metrics.appendChild(metric("P95", formatLatency(overall.p95TtftMs)));
      metrics.appendChild(
        metric(
          "HIT/MISS P95",
          `${formatLatency(cacheLatency.hit && cacheLatency.hit.p95TtftMs)} / ${formatLatency(cacheLatency.miss && cacheLatency.miss.p95TtftMs)}`,
        ),
      );
      item.appendChild(metrics);
      if (provider.circuit) {
        item.appendChild(
          create(
            "div",
            "provider-circuit",
            `${copy(provider.circuit.category, "upstream")} · ${formatAge(provider.circuit.remainingMs)} remaining`,
          ),
        );
      }
      fragment.appendChild(item);
    }
    elements.providerList.appendChild(fragment);
  }

  function cacheStatus(request) {
    if (
      request.cacheStatus === "hit" ||
      request.cacheStatus === "miss" ||
      request.cacheStatus === "unknown"
    ) {
      return request.cacheStatus;
    }
    if (request.usageObserved !== true) return "unknown";
    return finite(request.cached) > 0 ? "hit" : "miss";
  }

  function requestStatus(request) {
    if (request.cacheDowngrade)
      return { label: "DOWNGRADE", className: "is-downgraded" };
    if (request.warmup) return { label: "WARMUP", className: "is-warmup" };
    const status = cacheStatus(request);
    if (status === "hit") return { label: "HIT", className: "" };
    if (status === "miss") return { label: "MISS", className: "" };
    return { label: "UNKNOWN", className: "is-warning" };
  }

  function prefixContinuity(request) {
    const labels = {
      "append-only": ["仅追加", "前缀连续，可复用"],
      rewritten: ["已重排", "上下文被重排，上游无法复用前缀"],
      "family-changed": ["新缓存族", "缓存族刚切换，需要重新建立缓存"],
      cold: ["首次请求", "正在建立缓存"],
      unknown: ["待观测", "还没有足够的前缀证据"],
    };
    const result =
      labels[copy(request && request.prefixState, "unknown")] || labels.unknown;
    const facts = [];
    const observed = request && request.prefixState !== "unknown";
    if (observed && finite(request.stablePrefixChars) > 2) {
      facts.push(`${formatTokens(request.stablePrefixChars)} ch`);
    }
    if (observed && finite(request.prefixGeneration) > 0) {
      facts.push(`第 ${finite(request.prefixGeneration)} 代`);
    }
    return { label: result[0], detail: result[1], facts: facts.join(" · ") };
  }

  function taskStatus(task) {
    const labels = {
      queued: "排队",
      running: "运行",
      detached: "已脱离",
      succeeded: "成功",
      failed: "失败",
      timed_out: "超时",
      transport_lost: "传输中断",
      cancelled: "已取消",
      unknown: "未知",
    };
    const classes = {
      running: "is-live",
      succeeded: "is-live",
      detached: "is-warning",
      transport_lost: "is-warning",
      queued: "is-warning",
      failed: "is-error",
      timed_out: "is-error",
      cancelled: "is-error",
      unknown: "is-error",
    };
    const status = copy(task && task.status, "unknown");
    return {
      label: labels[status] || status.toUpperCase(),
      className: classes[status] || "is-warning",
    };
  }

  function renderTasks(snapshot) {
    const tasks = list(snapshot && snapshot.tasks);
    const counts = taskSummaryCounts(tasks);
    clear(elements.taskList);
    setText(elements.taskCount, tasks.length);
    setText(elements.taskRunning, `运行中 ${counts.running}`);
    setText(elements.taskAttention, `需要处理 ${counts.attention}`);
    setText(elements.taskEnded, `已结束 ${counts.ended}`);
    if (elements.taskListEmpty)
      elements.taskListEmpty.hidden = tasks.length > 0;
    const fragment = document.createDocumentFragment();
    for (const task of tasks) {
      const item = create("article", "task-item");
      item.setAttribute("role", "listitem");
      const header = create("div", "task-item-header");
      const identity = create("div", "task-item-identity");
      identity.appendChild(
        create("strong", "", copy(task.taskType, "未命名任务")),
      );
      header.appendChild(identity);
      const status = taskStatus(task);
      header.appendChild(
        create("span", `task-status ${status.className}`.trim(), status.label),
      );
      item.appendChild(header);

      const meta = create("div", "task-item-meta");
      meta.appendChild(
        create("span", "", copy(task.source, "unknown").toUpperCase()),
      );
      meta.appendChild(create("span", "", copy(task.phase, "等待阶段")));
      meta.appendChild(
        create("span", "", `心跳 ${formatAge(task.freshnessMs)}`),
      );
      item.appendChild(meta);

      const progress = create("div", "task-item-progress");
      progress.appendChild(
        create("span", "task-progress-copy", copy(task.progress, "未提供进度")),
      );
      progress.appendChild(
        create(
          "span",
          "",
          `尝试 ${integerNumber.format(finite(task.attemptCount))}`,
        ),
      );
      if (finite(task.fallbackCount) > 0) {
        progress.appendChild(
          create(
            "span",
            "task-fallback",
            `备用渠道 ${integerNumber.format(finite(task.fallbackCount))} 次`,
          ),
        );
      }
      item.appendChild(progress);

      const result = task.result || {};
      const resultText = result.errorCategory
        ? `${copy(result.status, "未知")} · ${copy(result.errorCategory)}`
        : copy(result.status, "尚未结束");
      item.appendChild(create("small", "task-item-result", resultText));
      fragment.appendChild(item);
    }
    elements.taskList.appendChild(fragment);
  }

  function taskSummaryCounts(tasks) {
    const running = new Set(["queued", "running"]);
    const attention = new Set([
      "failed",
      "timed_out",
      "detached",
      "transport_lost",
    ]);
    const result = { running: 0, attention: 0, ended: 0 };
    for (const task of list(tasks)) {
      const status = copy(task && task.status, "unknown").toLowerCase();
      if (running.has(status)) result.running += 1;
      else if (attention.has(status)) result.attention += 1;
      else result.ended += 1;
    }
    return result;
  }

  function tableCell(value, className) {
    return create("td", className || "", value);
  }

  function renderRequests(snapshot) {
    const requests = visibleRequests(snapshot);
    clear(elements.requestRows);
    if (elements.requestListEmpty)
      elements.requestListEmpty.hidden = requests.length > 0;
    const fragment = document.createDocumentFragment();
    for (const request of requests) {
      const row = create("tr");
      row.appendChild(tableCell(formatTime(request.at)));
      row.appendChild(
        tableCell(
          copy(request.source, "external").toUpperCase(),
          "request-source",
        ),
      );
      const channelCell = create("td");
      const channel = create("div", "request-channel");
      channel.appendChild(create("strong", "", copy(request.provider)));
      channel.appendChild(create("small", "", copy(request.model)));
      channelCell.appendChild(channel);
      row.appendChild(channelCell);
      const cacheMeasured = cacheStatus(request) !== "unknown";
      row.appendChild(
        tableCell(
          `${copy(request.cacheMode, "off")} · ${copy(request.cacheTtl, "default")}`,
        ),
      );
      row.appendChild(
        tableCell(copy(request.cacheName, "—"), "request-cache-name"),
      );
      row.appendChild(
        tableCell(
          cacheMeasured ? formatPercent(request.hitRate) : "—",
          cacheMeasured && finite(request.cached)
            ? "metric-read"
            : "metric-miss",
        ),
      );
      row.appendChild(
        tableCell(
          cacheMeasured ? formatTokens(request.cached) : "—",
          cacheMeasured && finite(request.cached)
            ? "metric-read"
            : "metric-miss",
        ),
      );
      row.appendChild(
        tableCell(
          cacheMeasured ? formatTokens(request.cacheWrite) : "—",
          cacheMeasured && finite(request.cacheWrite)
            ? "metric-write"
            : "metric-miss",
        ),
      );
      const prefix = prefixContinuity(request);
      const prefixCell = create("td");
      const prefixView = create("div", "request-prefix-continuity");
      prefixView.appendChild(create("strong", "", prefix.label));
      prefixView.appendChild(create("small", "", prefix.detail));
      if (prefix.facts)
        prefixView.appendChild(create("span", "", prefix.facts));
      prefixCell.appendChild(prefixView);
      row.appendChild(prefixCell);
      row.appendChild(
        tableCell(
          request.ttftObserved ? formatLatency(request.ttftMs) : "—",
          "metric-latency",
        ),
      );
      row.appendChild(
        tableCell(formatLatency(request.upstreamSemanticMs), "metric-latency"),
      );
      row.appendChild(
        tableCell(
          formatLatency(request.retryOverheadMs),
          finite(request.retryOverheadMs) > 0
            ? "metric-retry"
            : "metric-latency",
        ),
      );
      const status = requestStatus(request);
      const statusCell = create("td");
      statusCell.appendChild(
        create(
          "span",
          `request-state ${status.className}`.trim(),
          status.label,
        ),
      );
      row.appendChild(statusCell);
      fragment.appendChild(row);
    }
    elements.requestRows.appendChild(fragment);
  }

  function renderWarnings(snapshot) {
    const warnings = list(
      snapshot.runtime && snapshot.runtime.componentWarnings,
    ).slice();
    const codex =
      (snapshot.runtime &&
        snapshot.runtime.sources &&
        snapshot.runtime.sources.codex) ||
      {};
    if (codex.zeroToolRisk === true) {
      warnings.unshift(
        "CODEX ZERO-TOOL RISK: code_mode without host (" +
          copy(codex.diskToolMode, "unknown") +
          ")",
      );
    } else if (copy(codex.toolSurfaceState, "") === "critical") {
      warnings.unshift(
        "CODEX TOOL SURFACE CRITICAL: " +
          copy(codex.toolSurfaceReason, "unknown"),
      );
    } else if (copy(codex.toolSurfaceState, "") === "warn") {
      warnings.unshift(
        "CODEX TOOL SURFACE WARN: " + copy(codex.toolSurfaceReason, "unknown"),
      );
    }
    if (!warnings.length) {
      setText(elements.componentWarnings, "RUNTIME CLEAN");
      elements.componentWarnings.classList.remove("has-warning");
      return;
    }
    setText(elements.componentWarnings, warnings.join(" · "));
    elements.componentWarnings.classList.add("has-warning");
  }

  function renderCodexToolSurface(snapshot) {
    if (!elements.codexToolSurface) return;
    const codex =
      (snapshot.runtime &&
        snapshot.runtime.sources &&
        snapshot.runtime.sources.codex) ||
      {};
    const surface = copy(codex.toolSurface, "classic-forced");
    const st = copy(codex.toolSurfaceState, "unknown").toUpperCase();
    const mode = copy(codex.diskToolMode, "—");
    let label = st + " · " + surface;
    if (mode && mode !== "—") label += " · " + mode;
    if (codex.zeroToolRisk === true) label = "CRITICAL · ZERO TOOLS";
    setText(elements.codexToolSurface, label);
    elements.codexToolSurface.classList.toggle(
      "is-critical",
      codex.zeroToolRisk === true || st === "CRITICAL",
    );
    elements.codexToolSurface.classList.toggle(
      "is-warn",
      st === "WARN" && codex.zeroToolRisk !== true,
    );
  }

  function render(snapshot) {
    if (!snapshot || snapshot.version !== 1) return;
    state.snapshot = snapshot;
    const runtime = snapshot.runtime || {};
    setText(elements.runtimeMode, copy(runtime.mode, "unknown").toUpperCase());
    setText(elements.runtimePort, `本机 :${finite(runtime.port) || 8955}`);
    renderCodexToolSurface(snapshot);
    renderKpis(snapshot);
    const selected = renderSessions(snapshot);
    renderDetail(snapshot, selected);
    renderProviders(snapshot);
    renderTasks(snapshot);
    renderRequests(snapshot);
    renderWarnings(snapshot);
    updateAges();
  }

  function selectSurface(surface) {
    state.surfaceFilter = ["devin", "codex"].includes(surface)
      ? surface
      : "all";
    for (const button of document.querySelectorAll("[data-surface-filter]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.surfaceFilter === state.surfaceFilter),
      );
    }
    if (state.snapshot) render(state.snapshot);
  }

  function updateAges() {
    if (!state.snapshot) return;
    setText(
      elements.refreshAge,
      formatAge(Date.now() - finite(state.snapshot.generatedAt)),
    );
    const selected = list(state.snapshot.sessions).find(
      (session) => session.id === state.selectedSessionId,
    );
    if (selected) {
      setText(
        elements.detailFreshness,
        formatAge(Date.now() - finite(selected.latestActivityAt)),
      );
    }
  }

  function stopPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function closeSource() {
    if (!state.source) return;
    try {
      state.source.close();
    } catch {}
    state.source = null;
  }

  async function fetchSnapshot() {
    try {
      const response = await fetch("/origin/hud/snapshot", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      render(snapshot);
      if (!state.source) setConnection("warning", "轮询在线");
      return true;
    } catch {
      if (!state.source) setConnection("offline", "连接中断");
      return false;
    }
  }

  function scheduleSseRetry() {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      connectSse();
    }, 30_000);
  }

  function startPolling() {
    closeSource();
    if (!state.pollTimer) {
      fetchSnapshot();
      state.pollTimer = setInterval(fetchSnapshot, 5_000);
    }
    scheduleSseRetry();
  }

  function connectSse() {
    if (!("EventSource" in window)) {
      startPolling();
      return;
    }
    closeSource();
    setConnection("connecting", "正在连接");
    const source = new EventSource("/origin/hud/events");
    state.source = source;
    source.addEventListener("open", () => {
      if (state.source !== source) return;
      state.failures = 0;
      stopPolling();
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      setConnection("live", "实时在线");
    });
    source.addEventListener("snapshot", (event) => {
      if (state.source !== source) return;
      try {
        render(JSON.parse(event.data));
        state.failures = 0;
      } catch {
        setConnection("warning", "数据异常");
      }
    });
    source.addEventListener("error", () => {
      if (state.source !== source) return;
      state.failures += 1;
      if (state.failures >= 3) {
        setConnection("warning", "切换轮询");
        startPolling();
      } else {
        setConnection("warning", "正在重连");
      }
    });
  }

  function cleanup() {
    closeSource();
    stopPolling();
    if (state.retryTimer) clearTimeout(state.retryTimer);
    if (state.ageTimer) clearInterval(state.ageTimer);
  }

  window.addEventListener("beforeunload", cleanup, { once: true });
  for (const button of document.querySelectorAll("[data-surface-filter]")) {
    button.addEventListener("click", () =>
      selectSurface(button.dataset.surfaceFilter),
    );
  }
  state.ageTimer = setInterval(updateAges, 1_000);
  fetchSnapshot().finally(connectSse);
})();
