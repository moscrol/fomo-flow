"use strict";

const assert = require("node:assert");
const client = require("../scripts/mirasim-client.js");

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === "hello") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "welcome", host: { name: "mirasim" } }) }));
      return;
    }
    if (message.type === "prompt") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "accepted", clientRef: message.clientRef, sessionKey: "mira:test" }) }));
      return;
    }
    if (message.type === "listSessions") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "sessions", sessions: [{ sessionKey: "mira:test", token: "must-not-leak" }] }) }));
      return;
    }
    if (message.type === "getSnapshot") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "session", sessionKey: message.sessionKey, patch: { full: { phase: "done", text: "ok" } } }) }));
      return;
    }
    if (message.type === "subscribe") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "session", sessionKey: message.sessionKey, patch: { full: { phase: "running", text: "hel" } } }) }));
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "session", sessionKey: message.sessionKey, patch: { appendText: "lo", set: { phase: "completed" } } }) }));
      return;
    }
    if (message.type === "stop") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "accepted", sessionKey: message.sessionKey }) }));
    }
  }

  close() {}

  emit(name, event) {
    const listener = this.listeners.get(name);
    if (listener) listener(event);
  }
}

async function main() {
  const sockets = [];
  const socketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const options = { socketFactory, token: "mira-token", url: "ws://127.0.0.1:4970/mirachannel/ws", timeoutMs: 500 };

  const accepted = await client.submitTask({ prompt: "inspect this workspace", agent: "codex" }, options);
  assert.strictEqual(accepted.sessionKey, "mira:test");
  assert.strictEqual(sockets[0].sent[0].token, "mira-token");
  assert.deepStrictEqual(sockets[0].sent[1].prompt, "inspect this workspace");

  const sessions = await client.listSessions(options);
  assert.strictEqual(sessions.sessions.length, 1);
  assert.strictEqual("token" in sessions.sessions[0], false);

  const snapshot = await client.getSession({ sessionKey: "mira:test" }, options);
  assert.strictEqual(snapshot.patch.full.text, "ok");

  const updates = [];
  const completed = await client.runTask({ prompt: "complete this", agent: "codex" }, {
    ...options,
    onUpdate: (update) => updates.push(update),
  });
  assert.strictEqual(completed.phase, "completed");
  assert.strictEqual(completed.text, "hello");
  assert.deepStrictEqual(updates.map((update) => update.text), ["hel", "hello"]);

  const stopped = await client.stopSession({ sessionKey: "mira:test" }, options);
  assert.strictEqual(stopped.sessionKey, "mira:test");

  const original = process.env.MIRASIM_BASE_URL;
  process.env.MIRASIM_BASE_URL = "https://mira.example.test";
  assert.throws(() => client.baseUrl(), /loopback/);
  if (original === undefined) delete process.env.MIRASIM_BASE_URL;
  else process.env.MIRASIM_BASE_URL = original;

  assert.strictEqual(client.toWebsocketUrl("http://127.0.0.1:4970"), "ws://127.0.0.1:4970/mirachannel/ws");
  assert.strictEqual(client.toWebsocketUrl("ws://127.0.0.1:4970/mirachannel/ws"), "ws://127.0.0.1:4970/mirachannel/ws");
  assert.throws(() => client.toWebsocketUrl("wss://mira.example.test/mirachannel/ws"), /loopback/);

  let convertedUrl = "";
  await client.runTask({ prompt: "via http base" }, {
    ...options,
    url: "http://127.0.0.1:4970",
    socketFactory: (url) => {
      convertedUrl = url;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  assert.strictEqual(convertedUrl, "ws://127.0.0.1:4970/mirachannel/ws");

  assert.throws(() => client.submitTask({ prompt: "" }, options), /prompt is required/);
  console.log("mirasim client selftest: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
