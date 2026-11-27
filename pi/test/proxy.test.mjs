import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
// Resolve before HOME changes: the binary may live under the real home.
const PI_BIN = execFileSync("sh", ["-c", 'command -v "$0"', process.env.PI_BIN || "pi"], { encoding: "utf8" }).trim();
const REPLY = "mock-reply-42";
const CHAT_REPLY = "mock-chat-reply-7";
const FAILURE = "mock-upstream-refusal";

const requests = [];
let server;
let baseUrl;
let tmp;

function completedResponse(id) {
  return {
    id,
    object: "response",
    status: "completed",
    output: [
      { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: REPLY, annotations: [] }] },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
}

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
  res.end();
}

function handle(req, res, body) {
  const path = req.url.split("?")[0];
  if (req.method === "GET" && path === "/v1/models") {
    const ids = ["gpt-4.1", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-6.2-sol", "claude-sonnet-4.6", "gpt-35-turbo", "text-embedding-3"];
    return res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }));
  }
  if (path === "/model_group/info") {
    res.writeHead(403);
    return res.end(JSON.stringify({ error: "forbidden" }));
  }
  if (req.method === "POST" && path === "/v1/responses") {
    if (body?.model === "gpt-6.1-sol" && body?.reasoning?.effort === "none") {
      res.writeHead(400);
      const message = "Unsupported value: 'none' is not supported with the 'gpt-6.1-sol-2026-09-29' model.";
      return res.end(JSON.stringify({ error: { message: `litellm.BadRequestError: AzureException BadRequestError - ${message}` } }));
    }
    // Bedrock ignores background: it answers finished and cannot be polled.
    if (body?.background && body.model.startsWith("claude")) return res.end(JSON.stringify(completedResponse("resp_bedrock_1")));
    if (body?.background && body.model === "gpt-6-luna") {
      return res.end(JSON.stringify({ id: "resp_failed_1", object: "response", status: "failed", error: { message: FAILURE } }));
    }
    if (body?.background && body.model === "gpt-6.2-sol") return res.end(JSON.stringify({ ...completedResponse(), id: undefined }));
    if (body?.background) return res.end(JSON.stringify({ id: "resp_bg_1", object: "response", status: "queued" }));
    // The proxy collapses tool turns: only the terminal event has output.
    return sse(res, [{ type: "response.completed", response: completedResponse("resp_stream_1") }]);
  }
  if (req.method === "GET" && path === "/v1/responses/resp_bedrock_1") {
    res.writeHead(500);
    return res.end(JSON.stringify({ error: { message: "litellm.APIConnectionError: GET responses is not supported for bedrock" } }));
  }
  if (req.method === "GET" && path.startsWith("/v1/responses/")) {
    return res.end(JSON.stringify(completedResponse(decodeURIComponent(path.slice("/v1/responses/".length)))));
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    const chunk = (delta, finish_reason = null) => ({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: body?.model,
      choices: [{ index: 0, delta, finish_reason }],
    });
    // A plain JSON body fails in Pi with "Stream ended without finish_reason".
    return sse(res, [chunk({ role: "assistant", content: CHAT_REPLY }), chunk({}, "stop"), "[DONE]"]);
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "uva-test-"));
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      requests.push({ method: req.method, path: req.url.split("?")[0], body, auth: req.headers.authorization });
      res.setHeader("Content-Type", "application/json");
      handle(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(tmp, "creds.json"), JSON.stringify({ baseUrl, apiKey: "sk-test-creds" }));
  writeFileSync(join(tmp, "saved.json"), JSON.stringify({ baseUrl, apiKey: "sk-test-saved" }));
});

after(() => {
  server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function runPi(args, extraEnv = {}, agentDir = mkdtempSync(join(tmp, "agent-"))) {
  const home = mkdtempSync(join(tmp, "home-"));
  const env = { ...process.env, HOME: home, UVA_CREDENTIALS_FILE: join(tmp, "creds.json"), UVA_API_KEY: "sk-test-env" };
  for (const k of ["OPENAI_API_KEY", "UVA_MODEL_OVERRIDES_FILE", "PI_CODING_AGENT_DIR", "UVA_BASE_URL", "UVA_PROVIDER_ID"]) delete env[k];
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const full = ["--agent-dir", agentDir, "--offline", "-ne", "--no-session", "-e", EXTENSION, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, full, { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi timed out\n${stdout}\n${stderr}`));
    }, 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, home });
    });
  });
}

const since = (n) => requests.slice(n);

test("lists chat models and skips embeddings", async () => {
  const { code, stdout, stderr } = await runPi(["--list-models", "uva"]);
  assert.equal(code, 0, stderr);
  const rows = stdout.split("\n");
  for (const id of ["gpt-4.1", "gpt-6-sol", "gpt-35-turbo"]) assert.ok(rows.some((r) => r.includes(id)), `${id} missing:\n${stdout}`);
  assert.ok(!stdout.includes("text-embedding-3"), stdout);
  const header = rows.find((r) => /thinking/i.test(r));
  const row = rows.find((r) => /\bgpt-35-turbo\b/.test(r));
  assert.ok(header && row, stdout);
  const col = header.toLowerCase().indexOf("thinking");
  assert.ok(!/^\s*yes/.test(row.slice(col)), `gpt-35-turbo marked as thinking:\n${stdout}`);
});

test("gpt-4.1 streams one /v1/responses request with tools", async () => {
  const n = requests.length;
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-4.1", "-p", "hi"]);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes(REPLY), stdout + stderr);
  const posts = since(n).filter((r) => r.method === "POST" && r.path === "/v1/responses");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.stream, true);
  assert.ok(Array.isArray(posts[0].body.tools) && posts[0].body.tools.length > 0);
});

test("gpt-6-sol uses background and polls", async () => {
  const n = requests.length;
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-6-sol", "-p", "hi"]);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes(REPLY), stdout + stderr);
  const seen = since(n);
  const post = seen.find((r) => r.method === "POST" && r.path === "/v1/responses");
  assert.equal(post?.body?.background, true);
  assert.equal(typeof post.body.reasoning?.effort, "string");
  assert.ok(seen.some((r) => r.method === "GET" && r.path === "/v1/responses/resp_bg_1"));
});

test("thinking off works on a model that rejects effort none", async () => {
  const n = requests.length;
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-6.1-sol", "--thinking", "off", "-p", "hi"]);
  assert.equal(code, 0, stdout + stderr);
  assert.ok(stdout.includes(REPLY), stdout + stderr);
  const posts = since(n).filter((r) => r.method === "POST" && r.path === "/v1/responses");
  assert.equal(posts.at(-1).body.reasoning?.effort, "low");
});

test("a background reply that is already finished is not polled", async () => {
  // The real proxy marks claude-sonnet-4.6 as reasoning in /model_group/info.
  const ovFile = join(tmp, "claude-reasoning.json");
  writeFileSync(ovFile, JSON.stringify({ "claude-sonnet-4.6": { reasoning: true } }));
  const n = requests.length;
  const { code, stdout, stderr } = await runPi(["--model", "uva/claude-sonnet-4.6", "-p", "hi"], { UVA_MODEL_OVERRIDES_FILE: ovFile });
  assert.equal(code, 0, stdout + stderr);
  assert.ok(stdout.includes(REPLY), stdout + stderr);
  const seen = since(n);
  assert.equal(seen.find((r) => r.method === "POST" && r.path === "/v1/responses")?.body?.background, true);
  assert.ok(!seen.some((r) => r.method === "GET" && r.path.startsWith("/v1/responses/")));
});

test("a background reply that already failed shows its error", async () => {
  const n = requests.length;
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-6-luna", "-p", "hi"]);
  assert.notEqual(code, 0, stdout + stderr);
  assert.ok((stdout + stderr).includes(FAILURE), stdout + stderr);
  assert.ok(!since(n).some((r) => r.method === "GET" && r.path.startsWith("/v1/responses/")));
});

test("a finished background reply without an id is used", async () => {
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-6.2-sol", "-p", "hi"]);
  assert.equal(code, 0, stdout + stderr);
  assert.ok(stdout.includes(REPLY), stdout + stderr);
});

test("gpt-35-turbo goes to chat completions without reasoning_effort", async () => {
  const n = requests.length;
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-35-turbo", "-p", "hi"]);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes(CHAT_REPLY), stdout + stderr);
  const posts = since(n).filter((r) => r.method === "POST" && r.path === "/v1/chat/completions");
  assert.equal(posts.length, 1);
  assert.ok(!("reasoning_effort" in posts[0].body), JSON.stringify(posts[0].body));
});

test("a saved login alone is enough", async () => {
  const env = { UVA_API_KEY: undefined, UVA_CREDENTIALS_FILE: join(tmp, "saved.json") };
  const list = await runPi(["--list-models", "uva"], env);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.stdout.includes("gpt-4.1"), list.stdout + list.stderr);
  const n = requests.length;
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-4.1", "-p", "hi"], env);
  assert.equal(code, 0, stdout + stderr);
  assert.ok(stdout.includes(REPLY), stdout + stderr);
  const posts = since(n).filter((r) => r.method === "POST" && r.path === "/v1/responses");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].auth, "Bearer sk-test-saved");
});

test("a saved key with $ and ! is sent as is", async () => {
  writeFileSync(join(tmp, "special.json"), JSON.stringify({ baseUrl, apiKey: "!sk-$x$!y" }));
  const n = requests.length;
  const env = { UVA_API_KEY: undefined, UVA_CREDENTIALS_FILE: join(tmp, "special.json") };
  const { code, stdout, stderr } = await runPi(["--model", "uva/gpt-4.1", "-p", "hi"], env);
  assert.equal(code, 0, stdout + stderr);
  const posts = since(n).filter((r) => r.method === "POST" && r.path === "/v1/responses");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].auth, "Bearer !sk-$x$!y");
});

test("an OpenAI key alone never reaches the proxy", async () => {
  const env = {
    UVA_API_KEY: undefined,
    UVA_CREDENTIALS_FILE: join(tmp, "missing.json"),
    UVA_BASE_URL: baseUrl,
    OPENAI_API_KEY: "sk-test-openai",
  };
  const n = requests.length;
  await runPi(["--list-models", "uva"], env);
  await runPi(["--model", "uva/gpt-4.1", "-p", "hi"], env);
  const auths = since(n).map((r) => `${r.method} ${r.path} ${r.auth}`);
  assert.ok(!auths.some((a) => a.includes("sk-test-openai")), auths.join("\n"));
});

test("the saved login is read from --agent-dir", async () => {
  const agentDir = mkdtempSync(join(tmp, "agent-"));
  writeFileSync(join(agentDir, "openai-responses-uva.json"), JSON.stringify({ baseUrl, apiKey: "sk-test-saved" }));
  const n = requests.length;
  const { code, stdout, stderr, home } = await runPi(["--list-models", "uva"], { UVA_API_KEY: undefined, UVA_CREDENTIALS_FILE: undefined }, agentDir);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("gpt-4.1"), stdout + stderr);
  assert.ok(since(n).some((r) => r.auth === "Bearer sk-test-saved"));
  assert.ok(!existsSync(join(home, ".pi")), "wrote under $HOME/.pi");
});

test("lists the fallback ids when discovery fails", async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const closed = `http://127.0.0.1:${probe.address().port}/v1`;
  await new Promise((r) => probe.close(r));
  writeFileSync(join(tmp, "closed.json"), JSON.stringify({ baseUrl: closed, apiKey: "sk-test-closed" }));
  const { code, stdout, stderr } = await runPi(["--list-models", "uva"], { UVA_CREDENTIALS_FILE: join(tmp, "closed.json"), UVA_BASE_URL: closed });
  assert.equal(code, 0, stderr);
  assert.ok(/\bgpt-6\.1-sol\b/.test(stdout), stdout + stderr);
  assert.ok(!/\bgpt-5\.5\b/.test(stdout), stdout);
});

after(() => {
  const leaked = requests.filter((r) => r.auth?.includes("sk-test-openai"));
  assert.equal(leaked.length, 0, leaked.map((r) => `${r.method} ${r.path}`).join("\n"));
});
