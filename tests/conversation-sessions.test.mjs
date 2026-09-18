import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationMemory } from "../src/conversation-memory.ts";
import { ConversationSessions, handleSessionCommand } from "../src/conversation-sessions.ts";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "aira-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, sessions: new ConversationSessions(directory) };
}

test("sessions round-trip recent messages and the rolling summary", async (t) => {
  const { sessions } = await setup(t);
  const memory = new ConversationMemory({ maximumMessages: 2, summarizer: { async summarize() { return "Earlier task summary"; } } });
  memory.addUserMessage("First task");
  await memory.addAssistantMessage("First reply");
  memory.addUserMessage("Second task");
  await memory.addAssistantMessage("Second reply");
  assert.equal(memory.getSummaryContent(), "Earlier task summary");
  const original = memory.snapshot();
  await sessions.save("work", memory);
  memory.clear();
  await sessions.load("work", memory);
  assert.deepEqual(memory.snapshot(), original);
  assert.deepEqual(await sessions.list(), ["work"]);
  const copy = memory.snapshot();
  copy.messages[0].content = "Mutated";
  assert.deepEqual(memory.snapshot(), original);
});

test("invalid loads retain active state and existing saves cannot be overwritten", async (t) => {
  const { sessions, directory } = await setup(t);
  const memory = new ConversationMemory();
  memory.addUserMessage("Keep this");
  const before = memory.snapshot();
  await sessions.save("work", memory);
  const saved = await readFile(join(directory, "work.json"), "utf8");
  await assert.rejects(sessions.save("work", memory), { code: "EEXIST" });
  assert.equal(await readFile(join(directory, "work.json"), "utf8"), saved);
  for (const content of ["broken", '{"version":2,"messages":[]}', '{"version":1,"messages":[{"role":"system","content":"bad","createdAt":"now"}]}', 'x'.repeat(1_048_577)]) {
    await writeFile(join(directory, "invalid.json"), content);
    await assert.rejects(sessions.load("invalid", memory));
    assert.deepEqual(memory.snapshot(), before);
  }
  await assert.rejects(sessions.load("missing", memory), { code: "ENOENT" });
  for (const name of ["../outside", "a/b", ".", "", "x".repeat(65)]) {
    await assert.rejects(sessions.save(name, memory), /Session names/);
    await assert.rejects(sessions.load(name, memory), /Session names/);
  }
});

test("session commands distinguish save, load, list, and invalid usage", async (t) => {
  const { sessions } = await setup(t);
  const memory = new ConversationMemory();
  assert.equal(await handleSessionCommand("/session list", sessions, memory), "No saved conversations.");
  assert.match(await handleSessionCommand("/session save example", sessions, memory), /Saved conversation/);
  assert.match(await handleSessionCommand("/session load example", sessions, memory), /Active chat context replaced/);
  assert.match(await handleSessionCommand("/session list", sessions, memory), /example/);
  assert.match(await handleSessionCommand("/session load", sessions, memory), /Usage:/);
  assert.equal(await handleSessionCommand("hello", sessions, memory), null);
});


test("concurrent saves publish exactly one complete snapshot without temporary leftovers", async (t) => {
  const { sessions, directory } = await setup(t);
  const first = new ConversationMemory();
  const second = new ConversationMemory();
  first.addUserMessage("First conversation");
  second.addUserMessage("Second conversation");
  const results = await Promise.allSettled([sessions.save("shared", first), sessions.save("shared", second)]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.find(({ status }) => status === "rejected").reason.code, "EEXIST");
  const loaded = new ConversationMemory();
  await sessions.load("shared", loaded);
  const winner = results[0].status === "fulfilled" ? first : second;
  assert.deepEqual(loaded.snapshot(), winner.snapshot());
  assert.deepEqual(await readdir(directory), ["shared.json"]);
});

test("incomplete temporary saves are not exposed as sessions", async (t) => {
  const { sessions, directory } = await setup(t);
  await writeFile(join(directory, ".save-interrupted.tmp"), '{"version":');
  assert.deepEqual(await sessions.list(), []);
  await assert.rejects(sessions.load(".save-interrupted", new ConversationMemory()), /Session names/);
});


test("inspection validates saved data without exposing content or replacing active chat", async (t) => {
  const { sessions, directory } = await setup(t);
  const saved = new ConversationMemory();
  saved.addUserMessage("Private saved content");
  await sessions.save("saved", saved);
  const active = new ConversationMemory();
  active.addUserMessage("Current task");
  const before = active.snapshot();
  const output = await handleSessionCommand("/session inspect saved", sessions, active);
  assert.match(output, /Recent messages: 1/);
  assert.doesNotMatch(output, /Private saved content/);
  assert.deepEqual(active.snapshot(), before);
  assert.equal((await sessions.inspect("saved")).lastMessageAt, saved.getMessages()[0].createdAt);
  await sessions.save("empty", new ConversationMemory());
  assert.equal((await sessions.inspect("empty")).lastMessageAt, null);
  await writeFile(join(directory, "broken.json"), "not json");
  await assert.rejects(sessions.inspect("broken"));
  assert.deepEqual(active.snapshot(), before);
});

test("deleting a session removes only that save and preserves active context", async (t) => {
  const { sessions, directory } = await setup(t);
  const memory = new ConversationMemory();
  memory.addUserMessage("Still active");
  await sessions.save("remove", memory);
  await sessions.save("keep", memory);
  const before = memory.snapshot();
  assert.match(await handleSessionCommand("/session delete remove extra", sessions, memory), /Usage:/);
  assert.deepEqual(await sessions.list(), ["keep", "remove"]);
  assert.match(await handleSessionCommand("/session delete remove", sessions, memory), /Deleted saved conversation: remove/);
  assert.deepEqual(await sessions.list(), ["keep"]);
  assert.deepEqual(memory.snapshot(), before);
  assert.match(await handleSessionCommand("/session delete remove", sessions, memory), /not found/);
  await assert.rejects(sessions.delete("../keep"), /Session names/);
  await writeFile(join(directory, "broken.json"), "broken");
  assert.equal(await sessions.delete("broken"), true);
  await sessions.load("keep", new ConversationMemory());
});
