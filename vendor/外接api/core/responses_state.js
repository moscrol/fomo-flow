"use strict";

// Stateless Responses requests must replay encrypted reasoning items before
// the function calls they belong to. Devin does not expose those provider
// items in its chat transcript, so keep the minimal opaque continuation state
// locally and merge it back without changing Devin's visible messages.
const MAX_CONVERSATIONS = 256;
const MAX_GROUPS_PER_CONVERSATION = 64;
const TTL_MS = 2 * 60 * 60 * 1000;

const conversations = new Map();

function _clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function _touch(key, state) {
  conversations.delete(key);
  conversations.set(key, state);
  while (conversations.size > MAX_CONVERSATIONS) {
    conversations.delete(conversations.keys().next().value);
  }
}

function _cleanup() {
  const now = Date.now();
  for (const [key, state] of conversations) {
    if (now - state.updatedAt > TTL_MS) conversations.delete(key);
  }
}

function _reasoningItem(item) {
  if (!item || item.type !== "reasoning" || !item.encrypted_content) return null;
  const output = {
    type: "reasoning",
    encrypted_content: item.encrypted_content,
  };
  if (item.id) output.id = item.id;
  if (Array.isArray(item.summary)) output.summary = _clone(item.summary);
  return output;
}

function commit(conversationKey, outputItems) {
  const key = String(conversationKey || "");
  if (!key || !Array.isArray(outputItems) || outputItems.length === 0) return false;
  _cleanup();
  const reasoning = outputItems.map(_reasoningItem).filter(Boolean);
  const callIds = outputItems
    .filter((item) => item && item.type === "function_call")
    .map((item) => String(item.call_id || item.id || ""))
    .filter(Boolean);
  if (reasoning.length === 0 || callIds.length === 0) return false;

  const state = conversations.get(key) || { groups: [], updatedAt: Date.now() };
  const signature = callIds.slice().sort().join("|");
  const group = {
    signature,
    callIds: Array.from(new Set(callIds)),
    reasoning,
  };
  const existing = state.groups.findIndex((entry) => entry.signature === signature);
  if (existing >= 0) state.groups.splice(existing, 1, group);
  else state.groups.push(group);
  if (state.groups.length > MAX_GROUPS_PER_CONVERSATION) {
    state.groups.splice(0, state.groups.length - MAX_GROUPS_PER_CONVERSATION);
  }
  state.updatedAt = Date.now();
  _touch(key, state);
  return true;
}

function inject(conversationKey, inputItems) {
  const key = String(conversationKey || "");
  if (!key || !Array.isArray(inputItems) || inputItems.length === 0) return inputItems;
  _cleanup();
  const state = conversations.get(key);
  if (!state) return inputItems;

  const callIndexes = new Map();
  const existingReasoningIds = new Set();
  inputItems.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    if (item.type === "function_call") {
      const callId = String(item.call_id || item.id || "");
      if (callId) callIndexes.set(callId, index);
    }
    if (item.type === "reasoning" && item.id) existingReasoningIds.add(item.id);
  });

  const insertions = [];
  for (const group of state.groups) {
    const indexes = group.callIds
      .map((callId) => callIndexes.get(callId))
      .filter((index) => Number.isInteger(index));
    if (indexes.length === 0) continue;
    const reasoning = group.reasoning.filter(
      (item) => !item.id || !existingReasoningIds.has(item.id),
    );
    if (reasoning.length === 0) continue;
    insertions.push({ index: Math.min(...indexes), items: reasoning.map(_clone) });
    reasoning.forEach((item) => {
      if (item.id) existingReasoningIds.add(item.id);
    });
  }
  if (insertions.length === 0) return inputItems;

  const output = inputItems.slice();
  insertions
    .sort((a, b) => b.index - a.index)
    .forEach((entry) => output.splice(entry.index, 0, ...entry.items));
  state.updatedAt = Date.now();
  _touch(key, state);
  return output;
}

function clear(conversationKey) {
  if (conversationKey) conversations.delete(String(conversationKey));
  else conversations.clear();
}

function status() {
  return {
    conversations: conversations.size,
    groups: Array.from(conversations.values()).reduce(
      (sum, state) => sum + state.groups.length,
      0,
    ),
  };
}

module.exports = { commit, inject, clear, status };
