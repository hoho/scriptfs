import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startModule } from "@scriptfs/testing";

const TOKEN = "inbox-token";
let inbox;

// Posts a message to the module's inbound port, as a host tool would.
async function post(message, token = TOKEN) {
  const response = await fetch(`${inbox.inbound("http").url}/messages`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(message),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  inbox = await startModule({
    module: new URL("..", import.meta.url),
    secrets: { token: TOKEN },
    settings: { maxMessages: 2 },
  });
});

after(() => inbox?.stop());

test("shows posted messages as files", async () => {
  assert.deepEqual(await inbox.list(), ["README.txt"]);
  assert.match(
    await inbox.readText("README.txt"),
    /POST messages to http:\/\/127\.0\.0\.1:\d+\/messages/,
  );

  const created = await post({ from: "ci", subject: "Build #12", body: "OK" });
  assert.deepEqual(created, {
    status: 201,
    body: { id: 1, file: "0001-Build-12.txt" },
  });
  assert.deepEqual(await inbox.list(), ["0001-Build-12.txt", "README.txt"]);
  assert.match(
    await inbox.readText("0001-Build-12.txt"),
    /^From: ci\nSubject: Build #12\nDate: .+\n\nOK\n$/,
  );
});

test("requires the token secret", async () => {
  assert.equal((await post({ body: "x" }, "wrong")).status, 401);
  assert.equal((await post({ body: "x" }, null)).status, 401);
  assert.equal((await post({ subject: "no body" })).status, 400);
});

test("keeps only maxMessages messages", async () => {
  await post({ subject: "Second", body: "2" });
  await post({ subject: "Third", body: "3" });
  assert.deepEqual(await inbox.list(), [
    "0002-Second.txt",
    "0003-Third.txt",
    "README.txt",
  ]);
});

test("deletes messages with rm", async () => {
  await rm(inbox.path("0002-Second.txt"));
  assert.deepEqual(await inbox.list(), ["0003-Third.txt", "README.txt"]);
});

test("keeps messages in state across restarts", async () => {
  assert.notDeepEqual(await readdir(inbox.stateDir), []);
  await inbox.restart();
  assert.deepEqual(await inbox.list(), ["0003-Third.txt", "README.txt"]);
  const created = await post({ subject: "After restart", body: "4" });
  assert.equal(created.body.id, 4);
});
