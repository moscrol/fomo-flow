"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const tools = require("../vendor/外接api/core/local_workspace_tools");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dao-local-workspace-"));
const nested = path.join(root, "Assets", "Scripts");
fs.mkdirSync(nested, { recursive: true });
fs.writeFileSync(
  path.join(nested, "HomeUI.cs"),
  "public class HomeUI {\n  void RegisterEnglishComposition() {}\n}\n",
  "utf8",
);
fs.writeFileSync(path.join(nested, "Video.uxml"), "<ui:VisualElement name=\"VideoRoot\" />", "utf8");

try {
  assert.deepEqual(
    tools.workspaceRootsFromText(`项目根目录：${root}\n项目类型：Unity`),
    [root],
  );
  assert.deepEqual(
    tools.workspaceRootsFromText(`<workspace_information>${root}</workspace_information>`),
    [root],
  );
  assert.deepEqual(
    tools.workspaceRootsFromText(`\u9879\u76ee\u6839\u76ee\u5f55\uff1a${root}\n\u9879\u76ee\u7c7b\u578b\uff1aUnity`),
    [root],
    "normal Chinese workspace labels must be recognized",
  );

  const recentMessages = [
    {
      role: "assistant",
      tool_calls: [
        {
          function: {
            name: "grep_search",
            arguments: JSON.stringify({ SearchPath: path.join(root, "Assets"), Query: "HomeUI" }),
          },
        },
      ],
    },
  ];
  const repairedFromRecent = tools.normalizeToolCall(
    "grep_search",
    JSON.stringify({ SearchPath: "Scripts", Query: "HomeUI" }),
    { workspaceRoots: [root], messages: recentMessages },
  );
  assert.equal(repairedFromRecent.changed, true);
  assert.equal(JSON.parse(repairedFromRecent.argumentsJson).SearchPath, nested);
  assert.equal(repairedFromRecent.reason, "relative-to-recent");

  const repairedFromWorkspaceChild = tools.normalizeToolCall(
    "grep_search",
    JSON.stringify({ SearchPath: "Scripts", Query: "HomeUI" }),
    { workspaceRoots: [root], messages: [], env: {} },
  );
  assert.equal(repairedFromWorkspaceChild.changed, true);
  assert.equal(
    JSON.parse(repairedFromWorkspaceChild.argumentsJson).SearchPath,
    nested,
  );
  assert.equal(repairedFromWorkspaceChild.reason, "relative-to-workspace-child");

  if (process.platform === "win32") {
    for (const rootRelative of ["/Scripts", "\\Scripts"]) {
      const repairedRootRelative = tools.normalizeToolCall(
        "find_by_name",
        JSON.stringify({ SearchDirectory: rootRelative, Pattern: "*.cs" }),
        { workspaceRoots: [root], messages: [], env: {} },
      );
      assert.equal(repairedRootRelative.changed, true, `${rootRelative} must be workspace-relative`);
      assert.equal(
        JSON.parse(repairedRootRelative.argumentsJson).SearchDirectory,
        nested,
      );
    }
  }

  const missingWorkspace = tools.normalizeToolCall(
    "grep_search",
    JSON.stringify({ SearchPath: "Scripts", Query: "HomeUI" }),
    { workspaceRoots: [], messages: [], env: {} },
  );
  assert.equal(missingWorkspace.changed, false);
  assert.equal(missingWorkspace.reason, "no-workspace-root");

  const multiRootA = path.join(root, "MultiRootA");
  const multiRootB = path.join(root, "MultiRootB");
  fs.mkdirSync(path.join(multiRootA, "Scripts"), { recursive: true });
  fs.mkdirSync(path.join(multiRootB, "Scripts"), { recursive: true });
  const multiRootArgs = JSON.stringify({ SearchPath: "Scripts", Query: "HomeUI" });
  const multiRootUnresolved = tools.normalizeToolCall("grep_search", multiRootArgs, {
    workspaceRoots: [multiRootA, multiRootB],
    env: {},
  });
  assert.equal(multiRootUnresolved.changed, false);
  assert.equal(multiRootUnresolved.argumentsJson, multiRootArgs);
  assert.equal(multiRootUnresolved.reason, "ambiguous-workspace-path");
  const multiRootRecent = tools.normalizeToolCall("grep_search", multiRootArgs, {
    workspaceRoots: [multiRootA, multiRootB],
    recentDirectories: [multiRootB],
    env: {},
  });
  assert.equal(multiRootRecent.changed, true);
  assert.equal(
    JSON.parse(multiRootRecent.argumentsJson).SearchPath,
    path.join(multiRootB, "Scripts"),
    "the most recent valid project directory must disambiguate a multi-root workspace",
  );

  const uniqueFolder = path.join(root, "Packages", "RuntimeOnly");
  fs.mkdirSync(uniqueFolder, { recursive: true });
  const repairedByDiscovery = tools.normalizeToolCall(
    "find_by_name",
    JSON.stringify({ SearchDirectory: "RuntimeOnly", Pattern: "*.cs" }),
    { workspaceRoots: [root] },
  );
  assert.equal(repairedByDiscovery.changed, true);
  assert.equal(JSON.parse(repairedByDiscovery.argumentsJson).SearchDirectory, uniqueFolder);
  assert.equal(repairedByDiscovery.reason, "relative-to-workspace-child");

  const absoluteArgs = JSON.stringify({ SearchPath: nested, Query: "HomeUI" });
  const unchangedAbsolute = tools.normalizeToolCall(
    "grep_search",
    absoluteArgs,
    { workspaceRoots: [root] },
  );
  assert.equal(unchangedAbsolute.changed, false);
  assert.equal(unchangedAbsolute.argumentsJson, absoluteArgs);
  assert.equal(unchangedAbsolute.reason, "valid-absolute");
  const readArgs = JSON.stringify({ path: "Scripts/HomeUI.cs" });
  assert.deepEqual(
    tools.normalizeToolCall("read_file", readArgs, { workspaceRoots: [root] }),
    { changed: false, argumentsJson: readArgs },
    "non-search tools must never be rewritten",
  );

  const duplicateRoot = path.join(root, "Duplicate");
  fs.mkdirSync(path.join(duplicateRoot, "Scripts"), { recursive: true });
  const ambiguousArgs = JSON.stringify({ SearchPath: "Scripts", Query: "x" });
  const ambiguousResult = tools.normalizeToolCall(
    "grep_search",
    ambiguousArgs,
    { workspaceRoots: [root] },
  );
  assert.equal(ambiguousResult.changed, false);
  assert.equal(ambiguousResult.argumentsJson, ambiguousArgs);
  assert.equal(ambiguousResult.reason, "ambiguous-workspace-path");

  const uriResult = tools.normalizeToolCall(
    "CodeSearch",
    JSON.stringify({ search_folder_absolute_uri: "Assets", search_term: "HomeUI" }),
    { workspaceRoots: [root] },
  );
  assert.equal(uriResult.changed, true);
  assert.equal(
    JSON.parse(uriResult.argumentsJson).search_folder_absolute_uri,
    path.join(root, "Assets").replace(/\\/g, "/"),
  );

  const absoluteUriResult = tools.normalizeToolCall(
    "code_search",
    JSON.stringify({
      search_folder_absolute_uri: nested,
      search_term: "定位作文专项范文页面与跳转关系",
    }),
    { workspaceRoots: [root] },
  );
  if (process.platform === "win32") {
    assert.equal(absoluteUriResult.changed, true);
    assert.equal(
      absoluteUriResult.reason,
      "absolute-path-forward-slashes",
    );
    assert.equal(
      JSON.parse(absoluteUriResult.argumentsJson).search_folder_absolute_uri,
      nested.replace(/\\/g, "/"),
      "native Fast Context must receive a Windows absolute path without JSON-escape-prone backslashes",
    );
    assert.equal(
      JSON.parse(absoluteUriResult.argumentsJson).search_term,
      "定位作文专项范文页面与跳转关系",
      "native Fast Context Chinese search terms must pass through unchanged",
    );
  } else {
    assert.equal(absoluteUriResult.changed, false);
    assert.equal(absoluteUriResult.reason, "valid-absolute");
  }

  const grepArgs = JSON.stringify({ SearchPath: root, Query: "RegisterEnglishComposition" });
  assert.equal(tools.canHandle("Grep", grepArgs), true);
  const grep = JSON.parse(tools.execute("Grep", grepArgs));
  assert.equal(grep.ok, true);
  assert.equal(grep.source, "dao-local-workspace");
  assert.equal(grep.results[0].line, 2);

  const find = JSON.parse(
    tools.execute("FindByName", JSON.stringify({ SearchDirectory: root, Pattern: "*.uxml" })),
  );
  assert.equal(find.results.length, 1);
  assert.match(find.results[0].path, /Video\.uxml$/);

  const code = JSON.parse(
    tools.execute(
      "CodeSearch",
      JSON.stringify({
        search_folder_absolute_uri: pathToFileURL(root).href,
        search_term: "find where EnglishComposition is registered in HomeUI",
      }),
    ),
  );
  assert.equal(code.results[0].path.endsWith("HomeUI.cs"), true);

  assert.equal(
    tools.canHandle("Grep", JSON.stringify({ SearchPath: path.join(root, "missing"), Query: "x" })),
    false,
  );

  const router = require("../vendor/外接api/core/dao_router");
  assert.equal(router._test.isLocalWorkspaceTool("Grep", grepArgs), true);
  assert.equal(
    router._test.shouldInterceptLocalWorkspaceTool("Grep", grepArgs, false),
    false,
    "native workspace tools should run first in a healthy session",
  );
  assert.equal(
    router._test.shouldInterceptLocalWorkspaceTool("Grep", grepArgs, true),
    true,
    "proxy-local search should intercept only after native workspace failure",
  );
  assert.equal(
    router._test.shouldInterceptLocalWorkspaceTool(
      "Grep",
      grepArgs,
      "grep-only",
      [root],
    ),
    true,
    "empty official workspace metadata should proactively intercept Grep",
  );
  assert.equal(
    router._test.shouldInterceptLocalWorkspaceTool(
      "grep_search",
      grepArgs,
      "grep-only",
      [root],
    ),
    true,
    "empty official workspace metadata should proactively intercept grep_search",
  );
  assert.equal(
    router._test.shouldInterceptLocalWorkspaceTool(
      "find_by_name",
      JSON.stringify({ SearchDirectory: root, Pattern: "*.cs" }),
      "grep-only",
      [root],
    ),
    false,
    "grep-only mode must preserve Devin native find_by_name",
  );
  assert.equal(
    router._test.shouldInterceptLocalWorkspaceTool(
      "code_search",
      JSON.stringify({ search_folder_absolute_uri: pathToFileURL(root).href, search_term: "HomeUI" }),
      "grep-only",
      [root],
    ),
    false,
    "grep-only mode must not enable Fast Context/code_search",
  );
  const officialEmptyWorkspace =
    "You are Devin.\nThe USER does not have any active workspace.\nFollow the tool contract.";
  assert.equal(
    router._test.hasOfficialEmptyWorkspaceMetadata(officialEmptyWorkspace),
    true,
  );
  assert.equal(
    router._test.localWorkspaceFallbackMode(officialEmptyWorkspace, [root], {}),
    "grep-only",
    "a validated root plus official empty metadata should activate the narrow fallback",
  );
  assert.equal(
    router._test.localWorkspaceFallbackMode(
      "The USER has an active workspace.",
      [root],
      {},
    ),
    "grep-only",
    "validated roots must protect Grep even when Cortex omits empty metadata",
  );
  assert.equal(
    router._test.localWorkspaceFallbackMode(officialEmptyWorkspace, [], {}),
    false,
    "empty metadata without a validated root must not activate local search",
  );
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dao-outside-workspace-"));
  try {
    assert.equal(
      router._test.shouldInterceptLocalWorkspaceTool(
        "grep_search",
        JSON.stringify({ SearchPath: outsideRoot, Query: "HomeUI" }),
        "grep-only",
        [root],
      ),
      false,
      "grep-only mode must never execute outside the validated workspace roots",
    );
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
  assert.equal(
    router._test.localWorkspaceFallbackMode("", [], { degraded: true }),
    true,
    "the existing observed-failure fallback must retain full local mode",
  );
  assert.deepEqual(
    router._test.requestWorkspaceRoots(
      `\u9879\u76ee\u6839\u76ee\u5f55\uff1a${root}`,
      { DAO_WORKSPACE_ROOT: root, DAO_WORKSPACE_ROOTS: JSON.stringify([root]) },
    ),
    [root],
    "prompt and environment roots should be combined without duplicates",
  );
  const routedRepair = JSON.parse(
    router._test.normalizeWorkspaceToolCall(
      "grep_search",
      JSON.stringify({ SearchPath: "Scripts", Query: "HomeUI" }),
      { messages: recentMessages },
    ),
  );
  assert.equal(routedRepair.SearchPath, nested);
  const routedFromPromptRoot = JSON.parse(
    router._test.normalizeWorkspaceToolCall(
      "grep_search",
      JSON.stringify({ SearchPath: "Assets", Query: "HomeUI" }),
      { messages: [], _workspaceRoots: tools.workspaceRootsFromText(`项目根目录：${root}`) },
    ),
  );
  assert.equal(routedFromPromptRoot.SearchPath, path.join(root, "Assets"));
  const routed = JSON.parse(router._test.executeServerTool("Grep", grepArgs, {}));
  assert.equal(routed.source, "dao-local-workspace");
  assert.equal(routed.results[0].line, 2);
  console.log("local workspace tools selftest: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
