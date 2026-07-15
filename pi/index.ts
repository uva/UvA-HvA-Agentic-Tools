/**
 * openai-responses-uva, a Pi coding-agent provider extension
 * ============================================================
 *
 * Registers the UvA LiteLLM proxy (https://llmproxy.uva.nl/v1) as a Pi model
 * provider and works around a proxy bug that otherwise makes every agent turn
 * return "thinking then nothing".
 *
 * The bug
 * -------
 * The UvA proxy speaks the OpenAI **Responses API** (`/v1/responses`). When a
 * request contains NO tool definitions it streams normally. But when tool
 * definitions ARE present (i.e. every agent turn) it collapses the SSE stream
 * to a single terminal `response.completed` event carrying the whole result in
 * `response.output[]`, and emits none of the incremental events
 * (`response.output_item.added`, `response.output_text.delta`,
 * `response.function_call_arguments.delta`, ...).
 *
 * Pi's built-in Responses stream parser builds the assistant reply purely from
 * those incremental events; its terminal handler never harvests
 * `response.output[]`. So the assistant message ends up empty, no text, no
 * tool call, no error.
 *
 * The fix
 * -------
 * This extension registers the UvA provider under a private api id so this
 * handler runs. For each turn it:
 *   1. Lets Pi's pristine built-in `openai-responses` handler BUILD the exact
 *      request params (full message + tool conversion, reasoning, caching) via
 *      an `onPayload` hook that captures the params and throws BEFORE the
 *      network call, so nothing extra is billed.
 *   2. Reissues that request itself and synthesizes Pi's content events,
 *      reconciling the incremental SSE events with the terminal
 *      `response.output[]` so the collapsed tool call is never lost.
 *
 * Two dispatch paths keep it reliable:
 *   - Non-reasoning turns STREAM (`stream:true`). Bytes flow, so the nginx
 *     gateway read-timeout keeps resetting and the reply is token-by-token.
 *   - Reasoning turns (reasoning.effort low/medium/high) use BACKGROUND + POLL
 *     (`background:true` + `GET /responses/{id}`). The model can buffer its
 *     whole reasoning phase with zero interim bytes without ever tripping a
 *     504, because each HTTP request is short. A streaming turn that still hits
 *     a gateway 5xx before any output falls back to this path automatically.
 *
 * Trade-off: reasoning replies are not token-by-token (they appear at once on
 * completion); plain turns stream normally.
 *
 * Connecting
 * ----------
 * Run `/login` (choose "UvA / HvA proxy") or `/uva-login`: pick a base URL
 * (UvA / HvA / custom), paste your API key, and every model is auto-discovered.
 * The base URL + key are saved to ~/.pi/agent/openai-responses-uva.json so the
 * next launch reconnects with nothing re-entered. Then pick a model via /models.
 *
 * Reasoning models default to thinking ON at medium
 * (set UVA_NO_AUTO_THINKING=1 to disable this; change any model's default in
 * /configure-models).
 *
 * Config (environment variables, all optional; /login is the easy path)
 * ---------------------------------------------------------------------
 *   UVA_API_KEY           API key, if you prefer env over /login.
 *   UVA_BASE_URL          Default: https://llmproxy.uva.nl/v1
 *   UVA_PROVIDER_ID       Provider id in /models. Default: uva
 *   UVA_CREDENTIALS_FILE  Override the saved-credentials path.
 *   UVA_NO_AUTO_THINKING  Set to disable the medium thinking default.
 *
 * Only imports the aliased root "@earendil-works/pi-ai" (the extension-facing
 * compat surface), so it works under Pi's jiti extension loader.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider, createAssistantMessageEventStream, calculateCost } from "@earendil-works/pi-ai";

const BASE_API = "openai-responses"; // pristine built-in handler we delegate to
const CUSTOM_API = "openai-responses-uva"; // our fixed handler is registered under this
const DEFAULT_BASE_URL = "https://llmproxy.uva.nl/v1";
const BASE_URL_PRESETS: Record<string, string> = {
  uva: "https://llmproxy.uva.nl/v1",
  hva: "https://llmproxy.hva.nl/v1",
};

const PROVIDER_ID = process.env.UVA_PROVIDER_ID || "uva";

// Active connection settings. Seeded from env, overridden by saved credentials
// (from the /login flow) at startup, and updated live on login.
let activeBaseUrl = (process.env.UVA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
let activeApiKey: string | undefined = process.env.UVA_API_KEY || process.env.OPENAI_API_KEY;

// Persisted login (base URL + API key) so model discovery works at the next
// startup with nothing re-entered. Path overridable via UVA_CREDENTIALS_FILE.
function credsFile(): string {
  if (process.env.UVA_CREDENTIALS_FILE) return process.env.UVA_CREDENTIALS_FILE;
  const os = require("node:os");
  const { join } = require("node:path");
  return join(os.homedir(), ".pi", "agent", "openai-responses-uva.json");
}

function loadCreds(): { baseUrl?: string; apiKey?: string } | null {
  try {
    const { readFileSync } = require("node:fs");
    const parsed = JSON.parse(readFileSync(credsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveCreds(creds: { baseUrl: string; apiKey: string }): void {
  const { writeFileSync, mkdirSync, chmodSync } = require("node:fs");
  const { dirname } = require("node:path");
  const file = credsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(creds, null, 2));
  try {
    chmodSync(file, 0o600); // best-effort owner-only
  } catch {
    /* ignore */
  }
}

// Models that are not chat/response models, never register these.
const DENY = /embedding|whisper|audio|tts|speech|dall|(^|[-_])image|document-ai|ocr|rerank|moderation|guard|stable-diffusion/i;

// Known-good fallback if /v1/models discovery fails.
const FALLBACK_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"];

// ---------------------------------------------------------------------------
// FALLBACK capability table.
//
// The primary source of truth is the proxy's own /model_group/info (real
// context window, max output, reasoning/vision support, cost, backend). This
// table only fills fields the proxy leaves blank, common for brand-new
// deployments whose metadata isn't populated yet (e.g. gpt-5.6-* report empty
// token limits), and is the whole story only if /model_group/info is
// unavailable and discovery falls back to /v1/models (ids only).
//
// Values are researched per model family. Any positive signal (metadata OR this
// table) enables reasoning/vision, so a new model is never worse off than its
// name family. Override per-id via UVA_MODEL_OVERRIDES_FILE.
//
// First matching entry wins; order matters (specific → general).
// ---------------------------------------------------------------------------

type Caps = { ctx: number; out: number; reasoning: boolean; vision: boolean };

const CAPS: Array<{ re: RegExp; caps: Caps }> = [
  // OpenAI GPT-5.x
  { re: /^gpt-5\.6/i, caps: { ctx: 1_100_000, out: 128_000, reasoning: true, vision: true } },
  { re: /^gpt-5\.[45]/i, caps: { ctx: 1_050_000, out: 128_000, reasoning: true, vision: true } },
  { re: /^gpt-5\.1/i, caps: { ctx: 400_000, out: 128_000, reasoning: true, vision: true } },
  { re: /^gpt-5(-|$)/i, caps: { ctx: 400_000, out: 128_000, reasoning: true, vision: true } }, // gpt-5 / -mini / -nano
  // OpenAI o-series (o3-mini is text-only)
  { re: /^o[134](-|$)/i, caps: { ctx: 200_000, out: 100_000, reasoning: true, vision: false } },
  // OpenAI open-weight
  { re: /gpt-oss/i, caps: { ctx: 131_072, out: 32_768, reasoning: true, vision: false } },
  // OpenAI GPT-4.x (not reasoning)
  { re: /^gpt-4\.1/i, caps: { ctx: 1_047_576, out: 32_768, reasoning: false, vision: true } },
  { re: /^gpt-4o/i, caps: { ctx: 128_000, out: 16_384, reasoning: false, vision: true } },
  { re: /^gpt-4/i, caps: { ctx: 128_000, out: 16_384, reasoning: false, vision: true } },
  { re: /model-router/i, caps: { ctx: 256_000, out: 32_768, reasoning: false, vision: true } },
  // Anthropic Claude 4.x / 5.x (thinking left off for reliable proxy translation)
  { re: /claude-opus/i, caps: { ctx: 1_000_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude-sonnet-4\.6|claude-sonnet-[5-9]/i, caps: { ctx: 1_000_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude-sonnet/i, caps: { ctx: 200_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude-haiku/i, caps: { ctx: 200_000, out: 64_000, reasoning: false, vision: true } },
  { re: /claude/i, caps: { ctx: 200_000, out: 64_000, reasoning: false, vision: true } },
  // Qwen (VL = vision; Qwen3 text, thinking not exposed via responses effort)
  { re: /qwen.*vl|vl.*qwen/i, caps: { ctx: 128_000, out: 8_192, reasoning: false, vision: true } },
  { re: /qwen/i, caps: { ctx: 262_144, out: 32_768, reasoning: false, vision: false } },
  // Mistral (small 3.x is multimodal)
  { re: /mistral-small/i, caps: { ctx: 128_000, out: 32_768, reasoning: false, vision: true } },
  { re: /mistral/i, caps: { ctx: 128_000, out: 32_768, reasoning: false, vision: false } },
  // Google (if the proxy ever exposes it)
  { re: /gemini/i, caps: { ctx: 1_000_000, out: 65_536, reasoning: false, vision: true } },
];

// Safe map for reasoning models: low/medium/high are supported by every OpenAI
// reasoning family; minimal/xhigh/max are hidden because support varies.
const REASONING_THINKING_MAP = {
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
} as const;

// Endpoint routing. Some models speak the OpenAI Responses API (/v1/responses);
// open-weight vLLM deployments only speak /v1/chat/completions and 404 on
// /responses. We derive this from the proxy's own /model_group/info metadata
// (backend `providers`), fall back to a name regex when metadata is absent, and
// SELF-HEAL at runtime: a Responses turn that 404s is retried on
// chat-completions and the id is remembered for the rest of the session.
const RESPONSES_CAPABLE = /^(gpt-4|gpt-5|o[0-9]|claude|model-router|grok|gemini)/i;
const RESPONSES_PROVIDERS = /azure|bedrock|vertex|anthropic|openai_responses/i;

// The model defs from the most recent registration (for the /configure-models
// menu to show current effective values).
let currentModels: any[] = [];

// id -> route, seeded at registration from metadata / name.
const modelRoutes = new Map<string, "responses" | "chat">();
// Runtime self-heal overrides (win over modelRoutes, survive re-registration).
const routeOverrides = new Map<string, "responses" | "chat">();

function routeForModel(id: string, providers?: string[]): "responses" | "chat" {
  if (routeOverrides.has(id)) return routeOverrides.get(id)!;
  if (providers && providers.length) {
    return providers.some((p) => RESPONSES_PROVIDERS.test(p)) ? "responses" : "chat";
  }
  return RESPONSES_CAPABLE.test(id) ? "responses" : "chat";
}

function currentRoute(id: string): "responses" | "chat" {
  return routeOverrides.get(id) ?? modelRoutes.get(id) ?? (RESPONSES_CAPABLE.test(id) ? "responses" : "chat");
}

function resolveCaps(id: string): Caps {
  for (const { re, caps } of CAPS) if (re.test(id)) return caps;
  // Unknown / future model: infer conservatively.
  const reasoning = /gpt-5|gpt-oss/i.test(id) || /^o[134](-|$)/i.test(id);
  const vision = /gpt-4|gpt-5|claude|gemini|vl|vision|nova/i.test(id);
  return { ctx: reasoning ? 400_000 : 128_000, out: reasoning ? 128_000 : 16_384, reasoning, vision };
}

// Every model is registered under CUSTOM_API so our streamSimple always runs and
// decides the endpoint per turn (with self-heal). Capabilities are taken from
// the proxy metadata when present, falling back to the researched CAPS table for
// fields the proxy leaves blank (common for brand-new deployments).
function buildModelDef(info: ModelInfo, overrides: Record<string, any>) {
  const id = info.id;
  const caps = resolveCaps(id);
  const ov = overrides[id] || {};
  const route = routeForModel(id, info.providers);
  modelRoutes.set(id, route);
  const isResponses = route === "responses";
  // Reasoning only on the Responses route (chat-completions rejects
  // reasoning_effort with tools). Any positive signal enables it; incomplete
  // metadata (all-false on new models) is corrected by the CAPS fallback.
  const reasoning = ov.reasoning ?? (isResponses && ((info.reasoning ?? false) || caps.reasoning));
  const vision = ov.vision ?? ((info.vision ?? false) || caps.vision);
  const ctx = ov.contextWindow ?? (info.ctx && info.ctx > 0 ? info.ctx : caps.ctx);
  const out = ov.maxTokens ?? (info.out && info.out > 0 ? info.out : caps.out);
  const hasCost = !!info.cost && (info.cost.input > 0 || info.cost.output > 0);
  const cost = ov.cost ?? (hasCost ? info.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return {
    id,
    name: ov.name || `${id} (UvA)`,
    api: CUSTOM_API,
    reasoning,
    input: (ov.input as string[]) || (vision ? ["text", "image"] : ["text"]),
    cost,
    contextWindow: ctx,
    maxTokens: out,
    ...(reasoning ? { thinkingLevelMap: ov.thinkingLevelMap || REASONING_THINKING_MAP } : {}),
  };
}

// Per-id capability overrides (context window, reasoning, default thinking
// level, ...) written by the /configure-models menu. Path is
// UVA_MODEL_OVERRIDES_FILE or ~/.pi/agent/openai-responses-uva.models.json.
function overridesFile(): string {
  if (process.env.UVA_MODEL_OVERRIDES_FILE) return process.env.UVA_MODEL_OVERRIDES_FILE;
  const os = require("node:os");
  const { join } = require("node:path");
  return join(os.homedir(), ".pi", "agent", "openai-responses-uva.models.json");
}

function loadOverrides(): Record<string, any> {
  try {
    const { readFileSync } = require("node:fs");
    const parsed = JSON.parse(readFileSync(overridesFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveOverrides(obj: Record<string, any>): void {
  const { writeFileSync, mkdirSync } = require("node:fs");
  const { dirname } = require("node:path");
  const file = overridesFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

type ModelInfo = {
  id: string;
  ctx?: number;
  out?: number;
  reasoning?: boolean;
  vision?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  providers?: string[];
  mode?: string;
};

// Non-chat model modes to skip (LiteLLM `mode` from /model_group/info).
const EXCLUDED_MODES = new Set([
  "embedding",
  "ocr",
  "image_generation",
  "moderation",
  "rerank",
  "audio",
  "transcription",
  "image",
]);

// Rich per-model metadata from LiteLLM's /model_group/info: real context window,
// max output, reasoning/vision support, backend providers, and cost. This is the
// source of truth that lets the extension adapt when the model line-up changes.
async function fetchModelInfos(apiKey: string | undefined, baseUrl: string): Promise<ModelInfo[]> {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const res = await fetch(`${root}/model_group/info`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${root}/model_group/info -> HTTP ${res.status}`);
  const data: any = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  const perM = (v: any) => (typeof v === "number" && v > 0 ? v * 1_000_000 : 0);
  const infos: ModelInfo[] = [];
  for (const m of rows) {
    const id = m?.model_group;
    if (typeof id !== "string" || !id) continue;
    const params: string[] = Array.isArray(m.supported_openai_params) ? m.supported_openai_params : [];
    infos.push({
      id,
      mode: typeof m.mode === "string" ? m.mode : "",
      providers: Array.isArray(m.providers) ? m.providers : [],
      ctx: typeof m.max_input_tokens === "number" ? m.max_input_tokens : 0,
      out: typeof m.max_output_tokens === "number" ? m.max_output_tokens : 0,
      reasoning: !!m.supports_reasoning || params.includes("reasoning_effort"),
      vision: !!m.supports_vision,
      cost: {
        input: perM(m.input_cost_per_token),
        output: perM(m.output_cost_per_token),
        cacheRead: perM(m.cache_read_input_token_cost),
        cacheWrite: perM(m.cache_creation_input_token_cost),
      },
    });
  }
  return infos;
}

// Fallback discovery: /v1/models returns ids only (no capabilities).
async function fetchModelIds(apiKey: string | undefined, baseUrl: string): Promise<string[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${root}/models -> HTTP ${res.status}`);
  const data: any = await res.json();
  const ids = (Array.isArray(data?.data) ? data.data : [])
    .map((m: any) => m?.id)
    .filter((id: any): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) throw new Error("no models returned by /v1/models");
  return ids;
}

// Layered discovery: rich metadata first, ids-only fallback. Throws only if
// BOTH fail, so /login can detect a bad key/URL.
async function discoverModels(apiKey: string | undefined, baseUrl: string): Promise<ModelInfo[]> {
  try {
    const infos = await fetchModelInfos(apiKey, baseUrl);
    if (infos.length) return infos;
  } catch (err) {
    console.error(
      `[openai-responses-uva] /model_group/info unavailable (${err instanceof Error ? err.message : String(err)}); falling back to /v1/models.`,
    );
  }
  const ids = await fetchModelIds(apiKey, baseUrl);
  return ids.map((id) => ({ id }));
}

// ---------------------------------------------------------------------------
// Stream fix
// ---------------------------------------------------------------------------

function encodeTextSignatureV1(id: string, phase?: string): string {
  return JSON.stringify(phase ? { v: 1, id, phase } : { v: 1, id });
}

function mapStopReason(status: string | undefined): string {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return "stop";
  }
}

/** Capture the exact request params the built-in handler would send, without sending. */
function captureParams(builtin: any, model: any, context: any, options: any): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: any) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let probe: any;
    try {
      const clone = { ...model, api: BASE_API };
      probe = builtin.streamSimple(clone, context, {
        ...options,
        onPayload: (params: any) => {
          finish(params);
          throw new Error("__uva_capture_done__");
        },
      });
    } catch {
      finish(null);
      return;
    }
    (async () => {
      try {
        for await (const _ of probe) {
          /* drain; the probe ends via the thrown onPayload */
        }
      } catch {
        /* ignore */
      }
      finish(null); // in case onPayload never ran
    })();
  });
}

/** Emit Pi content events for a single Responses `output[]` item. */
function emitOneItem(out: any, output: any, item: any): void {
  if (item?.type === "reasoning") {
    const thinking =
      (item.summary && item.summary.map((s: any) => s?.text || "").join("\n\n")) ||
      (item.content && item.content.map((c: any) => c?.text || "").join("\n\n")) ||
      "";
    const block: any = { type: "thinking", thinking, thinkingSignature: JSON.stringify(item) };
    output.content.push(block);
    const i = output.content.length - 1;
    out.push({ type: "thinking_start", contentIndex: i, partial: output });
    if (thinking) out.push({ type: "thinking_delta", contentIndex: i, delta: thinking, partial: output });
    out.push({ type: "thinking_end", contentIndex: i, content: thinking, partial: output });
  } else if (item?.type === "message") {
    const parts = Array.isArray(item.content) ? item.content : [];
    const text = parts
      .map((c: any) => (c?.type === "output_text" ? c.text || "" : c?.type === "refusal" ? c.refusal || "" : ""))
      .join("");
    const block: any = { type: "text", text, textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined) };
    output.content.push(block);
    const i = output.content.length - 1;
    out.push({ type: "text_start", contentIndex: i, partial: output });
    if (text) out.push({ type: "text_delta", contentIndex: i, delta: text, partial: output });
    out.push({ type: "text_end", contentIndex: i, content: text, partial: output });
  } else if (item?.type === "function_call") {
    let args: any = {};
    try {
      args = JSON.parse(item.arguments || "{}");
    } catch {
      args = {};
    }
    const block: any = { type: "toolCall", id: `${item.call_id}|${item.id}`, name: item.name, arguments: args };
    output.content.push(block);
    const i = output.content.length - 1;
    out.push({ type: "toolcall_start", contentIndex: i, partial: output });
    out.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: output });
  }
  // other item types (e.g. bare encrypted reasoning) are ignored
}

/**
 * Reconcile the terminal `output[]` against what was already emitted
 * incrementally. Any item whose id was NOT seen in the incremental event
 * stream is emitted now. This covers:
 *   - full collapse (no incremental events)  -> emit everything
 *   - partial collapse (e.g. text streamed but the tool call only appears in
 *     the terminal payload, as Anthropic/Bedrock does) -> emit the missing item
 */
function reconcileTerminal(out: any, output: any, terminal: any, seenIds: Set<string>): void {
  const items = Array.isArray(terminal?.output) ? terminal.output : [];
  for (const item of items) {
    const id = item?.id;
    if (id && seenIds.has(id)) continue;
    emitOneItem(out, output, item);
  }
}

function applyUsage(output: any, data: any, model: any): void {
  const u = data?.usage;
  if (u) {
    const cached = u.input_tokens_details?.cached_tokens || 0;
    const cacheWrite = u.input_tokens_details?.cache_write_tokens || 0;
    output.usage.input = Math.max(0, (u.input_tokens || 0) - cached - cacheWrite);
    output.usage.output = u.output_tokens || 0;
    output.usage.cacheRead = cached;
    output.usage.cacheWrite = cacheWrite;
    output.usage.reasoning = u.output_tokens_details?.reasoning_tokens || 0;
    output.usage.totalTokens = u.total_tokens || output.usage.input + output.usage.output + cached + cacheWrite;
  }
  try {
    calculateCost(model, output.usage);
  } catch {
    /* cost is best-effort */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// OpenAI-native families (Azure backend) accept OpenAI-only request params like
// `prompt_cache_key`. Non-OpenAI backends behind the proxy (Anthropic/Bedrock,
// Gemini/Vertex, Mistral, Qwen, ...) reject them, e.g.
//   "prompt_cache_key: Extra inputs are not permitted"
// Keep the param only for OpenAI-native ids; strip it everywhere else (the only
// cost is losing prompt caching on backends that would have accepted it).
const OPENAI_NATIVE = /^(gpt-|o[134]([-_]|$)|gpt-oss|model-router)/i;

function sanitizeParamsForModel(modelId: string, params: any): any {
  if (OPENAI_NATIVE.test(modelId)) return params;
  const p = { ...params };
  delete p.prompt_cache_key;
  delete p.prompt_cache_retention;
  return p;
}

/**
 * Translate one Responses SSE event into Pi events + block state.
 * Handles the full incremental event set (good streaming case) and records the
 * terminal `response.completed` payload (whose `output[]` is harvested by the
 * caller when the proxy sent no incremental events, the tools-collapse case).
 */
function handleSseEvent(
  evt: any,
  out: any,
  output: any,
  slots: Map<number, any>,
  seenIds: Set<string>,
  setTerminal: (r: any) => void,
): void {
  const t = evt?.type;
  if (t === "response.output_item.added") {
    const item = evt.item;
    const oi = evt.output_index;
    if (item?.id) seenIds.add(item.id);
    if (item?.type === "reasoning") {
      const block: any = { type: "thinking", thinking: "" };
      output.content.push(block);
      const ci = output.content.length - 1;
      slots.set(oi, { type: "thinking", block, ci });
      out.push({ type: "thinking_start", contentIndex: ci, partial: output });
    } else if (item?.type === "message") {
      const block: any = { type: "text", text: "" };
      output.content.push(block);
      const ci = output.content.length - 1;
      slots.set(oi, { type: "text", block, ci });
      out.push({ type: "text_start", contentIndex: ci, partial: output });
    } else if (item?.type === "function_call") {
      const block: any = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: {},
        partialJson: item.arguments || "",
      };
      output.content.push(block);
      const ci = output.content.length - 1;
      slots.set(oi, { type: "toolCall", block, ci });
      out.push({ type: "toolcall_start", contentIndex: ci, partial: output });
    }
  } else if (t === "response.output_text.delta") {
    const slot = slots.get(evt.output_index);
    if (slot?.type === "text") {
      slot.block.text += evt.delta || "";
      out.push({ type: "text_delta", contentIndex: slot.ci, delta: evt.delta || "", partial: output });
    }
  } else if (t === "response.reasoning_summary_text.delta") {
    const slot = slots.get(evt.output_index);
    if (slot?.type === "thinking") {
      slot.block.thinking += evt.delta || "";
      out.push({ type: "thinking_delta", contentIndex: slot.ci, delta: evt.delta || "", partial: output });
    }
  } else if (t === "response.function_call_arguments.delta") {
    const slot = slots.get(evt.output_index);
    if (slot?.type === "toolCall") {
      slot.block.partialJson = (slot.block.partialJson || "") + (evt.delta || "");
      out.push({ type: "toolcall_delta", contentIndex: slot.ci, delta: evt.delta || "", partial: output });
    }
  } else if (t === "response.output_item.done") {
    const item = evt.item;
    if (item?.id) seenIds.add(item.id);
    const slot = slots.get(evt.output_index);
    if (item?.type === "reasoning" && slot?.type === "thinking") {
      const summary =
        (item.summary && item.summary.map((s: any) => s?.text || "").join("\n\n")) ||
        (item.content && item.content.map((c: any) => c?.text || "").join("\n\n")) ||
        slot.block.thinking;
      slot.block.thinking = summary;
      slot.block.thinkingSignature = JSON.stringify(item);
      out.push({ type: "thinking_end", contentIndex: slot.ci, content: slot.block.thinking, partial: output });
      slots.delete(evt.output_index);
    } else if (item?.type === "message" && slot?.type === "text") {
      const text =
        (item.content &&
          item.content
            .map((c: any) => (c?.type === "output_text" ? c.text || "" : c?.type === "refusal" ? c.refusal || "" : ""))
            .join("")) ||
        slot.block.text;
      slot.block.text = text;
      slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
      out.push({ type: "text_end", contentIndex: slot.ci, content: text, partial: output });
      slots.delete(evt.output_index);
    } else if (item?.type === "function_call" && slot?.type === "toolCall") {
      let args: any = {};
      try {
        args = JSON.parse(item.arguments || slot.block.partialJson || "{}");
      } catch {
        args = {};
      }
      slot.block.arguments = args;
      delete slot.block.partialJson;
      out.push({ type: "toolcall_end", contentIndex: slot.ci, toolCall: slot.block, partial: output });
      slots.delete(evt.output_index);
    }
  } else if (t === "response.completed" || t === "response.incomplete") {
    setTerminal(evt.response);
  } else if (t === "response.failed") {
    const e = evt.response?.error;
    throw new Error(`openai-responses-uva: ${e?.code || "failed"}: ${e?.message || "no message"}`);
  } else if (t === "error") {
    throw new Error(`openai-responses-uva: stream error: ${evt.message || evt.code || "unknown"}`);
  }
}

/**
 * One streaming attempt. Streaming keeps the gateway connection alive (bytes
 * flow) so slow generations don't hit an nginx 504. `state.started` is set once
 * we begin emitting, so the caller only retries failures that happen before any
 * output was produced.
 */
async function attemptStream(
  url: string,
  apiKey: string,
  body: any,
  out: any,
  output: any,
  model: any,
  signal: any,
  onResponse: any,
  state: { started: boolean },
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  try {
    await onResponse?.({ status: res.status, headers: {} }, model);
  } catch {
    /* ignore */
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    const err: any = new Error(`openai-responses-uva: HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    err.status = res.status;
    throw err;
  }

  state.started = true;
  out.push({ type: "start", partial: output });

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  const slots = new Map<number, any>();
  const seenIds = new Set<string>();
  let terminal: any = null;
  let buffer = "";

  const drainChunk = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt: any;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      handleSseEvent(evt, out, output, slots, seenIds, (r) => (terminal = r));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      drainChunk(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
  }
  if (buffer.trim()) drainChunk(buffer);

  // Close any slots the proxy left open without an output_item.done.
  for (const slot of slots.values()) {
    if (slot.type === "text") {
      out.push({ type: "text_end", contentIndex: slot.ci, content: slot.block.text, partial: output });
    } else if (slot.type === "thinking") {
      out.push({ type: "thinking_end", contentIndex: slot.ci, content: slot.block.thinking, partial: output });
    } else if (slot.type === "toolCall") {
      try {
        slot.block.arguments = JSON.parse(slot.block.partialJson || "{}");
      } catch {
        /* keep {} */
      }
      delete slot.block.partialJson;
      out.push({ type: "toolcall_end", contentIndex: slot.ci, toolCall: slot.block, partial: output });
    }
  }
  slots.clear();

  // Emit any terminal output[] items that never arrived as incremental events
  // (full or partial collapse, e.g. Anthropic/Bedrock streams text but delivers
  // the tool call only in the terminal payload).
  if (terminal) {
    reconcileTerminal(out, output, terminal, seenIds);
    applyUsage(output, terminal, model);
    output.stopReason = mapStopReason(terminal.status);
  }
}

/**
 * Background + poll path. The POST returns immediately with a stored response
 * id (status `queued`/`in_progress`), then we poll `GET /responses/{id}` until
 * it finishes. Because every HTTP request is short, the nginx gateway
 * read-timeout can never fire, this is the reliable path for long reasoning
 * turns that otherwise buffer server-side and 504.
 *
 * Trade-off: no token-by-token streaming (the proxy delivers background results
 * only as a single terminal payload), so the reply appears at once on completion.
 */
async function runBackgroundPoll(
  url: string,
  apiKey: string,
  params: any,
  out: any,
  output: any,
  model: any,
  signal: any,
  onResponse: any,
  state: { started: boolean },
): Promise<void> {
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const body = sanitizeParamsForModel(model.id, { ...params, background: true, store: true, stream: false });

  // Enqueue (retry a couple times on gateway 5xx, the POST returns fast, so
  // this rarely trips).
  let data: any = null;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error("openai-responses-uva: aborted");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    try {
      await onResponse?.({ status: res.status, headers: {} }, model);
    } catch {
      /* ignore */
    }
    const text = await res.text();
    if (res.ok) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`openai-responses-uva: non-JSON enqueue response: ${text.slice(0, 200)}`);
      }
      break;
    }
    const gateway = res.status >= 500 && res.status < 600;
    if (gateway && attempt < 2 && !signal?.aborted) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`openai-responses-uva: HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  const id = data?.id;
  if (!id) throw new Error("openai-responses-uva: background response missing id");

  state.started = true;
  out.push({ type: "start", partial: output });

  // Poll until a terminal status. Every GET is short, so no gateway timeout.
  const getUrl = `${url}/${encodeURIComponent(id)}`;
  const deadline = Date.now() + 15 * 60 * 1000; // 15 min hard cap
  let delay = 1500;
  let getFails = 0;
  let terminal: any = null;
  while (true) {
    if (signal?.aborted) throw new Error("openai-responses-uva: aborted");
    await sleep(delay);
    let g: any;
    try {
      g = await fetch(getUrl, { headers: authHeaders, ...(signal ? { signal } : {}) });
    } catch (e: any) {
      if (signal?.aborted) throw new Error("openai-responses-uva: aborted");
      if (++getFails > 5) throw e;
      continue;
    }
    if (!g.ok) {
      if (++getFails > 5) {
        const t = await g.text().catch(() => "");
        throw new Error(`openai-responses-uva: poll HTTP ${g.status}: ${t.slice(0, 160).replace(/\s+/g, " ")}`);
      }
      continue;
    }
    getFails = 0;
    let gd: any;
    try {
      gd = await g.json();
    } catch {
      continue;
    }
    const st = gd?.status;
    if (st === "completed" || st === "incomplete") {
      terminal = gd;
      break;
    }
    if (st === "failed" || st === "cancelled") {
      const e = gd?.error;
      throw new Error(`openai-responses-uva: background ${st}: ${e?.message || e?.code || "no message"}`);
    }
    if (Date.now() > deadline) throw new Error("openai-responses-uva: background poll timed out");
    delay = Math.min(delay + 500, 3000);
  }

  // Background responses carry no incremental events, emit the whole output[].
  reconcileTerminal(out, output, terminal, new Set());
  applyUsage(output, terminal, model);
  output.stopReason = mapStopReason(terminal.status);
}

/** Delegate a turn to Pi's built-in chat-completions handler (open-weight models). */
function chatDelegate(model: any, context: any, options: any): any {
  const builtin = getApiProvider("openai-completions");
  if (!builtin) {
    const out = createAssistantMessageEventStream();
    out.push({
      type: "error",
      reason: "error",
      error: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "openai-responses-uva: openai-completions handler unavailable",
      },
    });
    out.end();
    return out;
  }
  // Strip reasoning: chat-completions rejects reasoning_effort with tools.
  return builtin.streamSimple(
    { ...model, api: "openai-completions", reasoning: false, thinkingLevelMap: undefined },
    context,
    options,
  );
}

async function pipeInto(out: any, src: any): Promise<void> {
  for await (const ev of src) out.push(ev);
}

/** The replacement streamSimple for UvA models. */
function uvaStreamSimple(model: any, context: any, options: any): any {
  // Open-weight models only speak chat-completions, delegate straight to the
  // built-in handler (standard streaming, no Responses bug to work around).
  if (currentRoute(model.id) === "chat") {
    return chatDelegate(model, context, options);
  }
  const out = createAssistantMessageEventStream();
  (async () => {
    const output: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const builtin = getApiProvider(BASE_API);
      if (!builtin) throw new Error("openai-responses-uva: built-in openai-responses handler not available");

      const origOnPayload = options?.onPayload;
      let params = await captureParams(builtin, model, context, options);
      if (!params) throw new Error("openai-responses-uva: failed to capture request params");
      if (origOnPayload) {
        const next = await origOnPayload(params, model);
        if (next !== undefined) params = next;
      }

      const apiKey = options?.apiKey || activeApiKey || process.env.UVA_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("openai-responses-uva: no API key (run /login or set UVA_API_KEY)");
      const url = String(model.baseUrl || activeBaseUrl).replace(/\/+$/, "") + "/responses";

      const state = { started: false };
      const effort = params?.reasoning?.effort;
      // Reasoning turns buffer server-side (the proxy sends no interim bytes
      // while the model thinks) and can 504 mid-stream. Route them straight to
      // the background+poll path where every HTTP request is short, so the
      // gateway timeout cannot fire. Non-reasoning turns (effort "none"/absent)
      // stream normally for token-by-token output.
      const preferBackground = typeof effort === "string" && effort !== "none";

      if (preferBackground) {
        await runBackgroundPoll(url, apiKey, params, out, output, model, options?.signal, options?.onResponse, state);
      } else {
        const streamBody = sanitizeParamsForModel(model.id, { ...params, stream: true });
        try {
          await attemptStream(url, apiKey, streamBody, out, output, model, options?.signal, options?.onResponse, state);
        } catch (err: any) {
          const status: number | undefined = err?.status;
          const gateway = status === undefined || (status >= 500 && status < 600);
          // Gateway failure before any output = the proxy buffered with no bytes.
          // Fall back to background+poll (also defeats the 504) instead of
          // retrying the same doomed stream.
          if (!state.started && gateway && !options?.signal?.aborted) {
            await runBackgroundPoll(url, apiKey, params, out, output, model, options?.signal, options?.onResponse, state);
          } else {
            throw err;
          }
        }
      }

      if (output.content.some((b: any) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
      out.push({ type: "done", reason: output.stopReason, message: output });
      out.end();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Self-heal: this model isn't on /responses (proxy 404 / "not found").
      // Remember it as chat-only and reissue this turn on chat-completions.
      const notOnResponses =
        (error as any)?.status === 404 || /HTTP 404|not found|does not exist|no model group|NotFound/i.test(msg);
      if (notOnResponses && output.content.length === 0 && !options?.signal?.aborted) {
        routeOverrides.set(model.id, "chat");
        try {
          await pipeInto(out, chatDelegate(model, context, options));
          out.end();
          return;
        } catch {
          /* fall through to error reporting */
        }
      }
      for (const block of output.content) {
        delete block.partialJson;
        delete block.index;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = msg;
      out.push({ type: "error", reason: output.stopReason, error: output });
      out.end();
    }
  })();
  return out;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Discover + build the model list for a given key/base URL (falls back on error). */
async function buildModels(apiKey: string | undefined, baseUrl: string): Promise<any[]> {
  let infos: ModelInfo[];
  try {
    infos = await discoverModels(apiKey, baseUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[openai-responses-uva] model discovery failed (${msg}); using fallback list.`);
    infos = FALLBACK_MODEL_IDS.map((id) => ({ id }));
  }
  const overrides = loadOverrides();
  modelRoutes.clear();
  return infos
    .filter((info) => !DENY.test(info.id) && !(info.mode && EXCLUDED_MODES.has(info.mode)))
    .map((info) => buildModelDef(info, overrides));
}

function registerProviderNow(pi: ExtensionAPI, models: any[], baseUrl: string): void {
  currentModels = models;
  pi.registerProvider(PROVIDER_ID, {
    name: "UvA / HvA (Responses fix)",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: "$UVA_API_KEY",
    api: CUSTOM_API,
    models,
    streamSimple: uvaStreamSimple as any,
    oauth: makeOAuth(pi),
  });
}

/**
 * OAuth-shaped config so the connect flow appears under `/login`. It isn't real
 * OAuth, we reuse the callback prompts to pick a base URL and paste an API key,
 * then discover models and re-register the provider so `/models` fills in.
 */
function makeOAuth(pi: ExtensionAPI) {
  return {
    name: "UvA / HvA proxy (paste API key)",
    async login(callbacks: any): Promise<any> {
      const choice = await callbacks.onSelect({
        message: "Which proxy do you want to connect to?",
        options: [
          { id: "uva", label: "UvA - llmproxy.uva.nl" },
          { id: "hva", label: "HvA - llmproxy.hva.nl" },
          { id: "custom", label: "Custom base URL…" },
        ],
      });
      if (!choice) throw new Error("login cancelled");
      let baseUrl = BASE_URL_PRESETS[choice] || DEFAULT_BASE_URL;
      if (choice === "custom") {
        const typed = await callbacks.onPrompt({
          message: "Base URL (include /v1)",
          placeholder: "https://llmproxy.example.nl/v1",
        });
        if (!typed || !typed.trim()) throw new Error("login cancelled");
        baseUrl = typed.trim();
      }
      baseUrl = baseUrl.replace(/\/+$/, "");

      const key = await callbacks.onPrompt({ message: "Paste your API key", placeholder: "sk-…" });
      if (!key || !key.trim()) throw new Error("login cancelled");
      const apiKey = key.trim();

      callbacks.onProgress?.("Discovering models…");
      const infos = await discoverModels(apiKey, baseUrl); // throws on a bad key/url -> login fails
      callbacks.onProgress?.(`Connected, ${infos.length} models available.`);

      saveCreds({ baseUrl, apiKey });
      activeApiKey = apiKey;
      activeBaseUrl = baseUrl;
      registerProviderNow(pi, await buildModels(apiKey, baseUrl), baseUrl);

      return {
        access: apiKey,
        refresh: "",
        expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, // static key: never auto-refresh
        baseUrl,
      };
    },
    async refreshToken(cred: any): Promise<any> {
      return cred; // static API key, nothing to refresh
    },
    getApiKey(cred: any): string {
      if (cred?.baseUrl) activeBaseUrl = String(cred.baseUrl).replace(/\/+$/, "");
      const key = (cred && cred.access) || activeApiKey || "";
      if (key) activeApiKey = key;
      return key;
    },
    modifyModels(models: any[], cred: any): any[] {
      const b = (cred?.baseUrl ? String(cred.baseUrl) : activeBaseUrl).replace(/\/+$/, "");
      return models.map((m) => (m.provider === PROVIDER_ID ? { ...m, baseUrl: b } : m));
    },
  };
}

// Enforce the preferred default: thinking ON at medium for reasoning models.
// Applied whenever a UvA reasoning model becomes active. Disable with
// UVA_NO_AUTO_THINKING=1. A per-model default (set in /configure-models) wins.
function applyThinkingDefault(pi: ExtensionAPI, model: any): void {
  if (process.env.UVA_NO_AUTO_THINKING) return;
  if (!model || model.provider !== PROVIDER_ID || !model.reasoning) return;
  const ov = loadOverrides()[model.id] || {};
  const level = ov.defaultThinkingLevel || "medium";
  try {
    pi.setThinkingLevel(level);
  } catch {
    /* ignore */
  }
}

/** Interactive per-model settings loop for /configure-models (mutates `draft`). */
async function configureOneModel(ctx: any, id: string, draft: Record<string, any>): Promise<void> {
  const def = currentModels.find((m) => m.id === id);
  const ov = draft[id] || (draft[id] = {});
  const eff = (k: string, fallback: any) => (ov[k] !== undefined ? ov[k] : fallback);
  const num = (v: any) => parseInt(String(v ?? "").replace(/[_,\s]/g, ""), 10);
  const RESET = "\u27f2 Reset this model to auto (remove override)";
  const BACK = "\u2190 Back to model list";
  while (true) {
    const reasoning = eff("reasoning", def?.reasoning ?? false);
    const visionOn = eff("vision", (def?.input || []).includes("image"));
    const defLevel = eff("defaultThinkingLevel", reasoning ? "medium" : "n/a");
    const items = [
      `Context window: ${eff("contextWindow", def?.contextWindow ?? "?")}`,
      `Max output tokens: ${eff("maxTokens", def?.maxTokens ?? "?")}`,
      `Reasoning: ${reasoning ? "on" : "off"}`,
      `Default thinking level: ${defLevel}`,
      `Vision (image input): ${visionOn ? "on" : "off"}`,
      RESET,
      BACK,
    ];
    const pick = await ctx.ui.select(`${id} - pick a setting to change`, items);
    if (pick === undefined || pick === BACK) return;
    if (pick === RESET) {
      delete draft[id];
      ctx.ui.notify(`${id}: override cleared.`, "info");
      return;
    }
    if (pick.startsWith("Context window")) {
      const v = await ctx.ui.input(`${id} - context window (tokens)`, String(eff("contextWindow", def?.contextWindow ?? "")));
      const n = num(v);
      if (Number.isFinite(n) && n > 0) ov.contextWindow = n;
      else if (v !== undefined) ctx.ui.notify("Enter a positive integer.", "warning");
    } else if (pick.startsWith("Max output")) {
      const v = await ctx.ui.input(`${id} - max output tokens`, String(eff("maxTokens", def?.maxTokens ?? "")));
      const n = num(v);
      if (Number.isFinite(n) && n > 0) ov.maxTokens = n;
      else if (v !== undefined) ctx.ui.notify("Enter a positive integer.", "warning");
    } else if (pick.startsWith("Reasoning:")) {
      const v = await ctx.ui.select(`${id} - reasoning (thinking) support`, ["on", "off"]);
      if (v) ov.reasoning = v === "on";
    } else if (pick.startsWith("Default thinking")) {
      const v = await ctx.ui.select(`${id} - default thinking level when selected`, ["off", "low", "medium", "high"]);
      if (v) ov.defaultThinkingLevel = v;
    } else if (pick.startsWith("Vision")) {
      const v = await ctx.ui.select(`${id} - vision (image input)`, ["on", "off"]);
      if (v) ov.vision = v === "on";
    }
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const creds = loadCreds();
  if (creds?.baseUrl) activeBaseUrl = String(creds.baseUrl).replace(/\/+$/, "");
  if (creds?.apiKey) activeApiKey = creds.apiKey;

  registerProviderNow(pi, await buildModels(activeApiKey, activeBaseUrl), activeBaseUrl);

  // Default thinking level (medium) on selection and at startup.
  pi.on("model_select", (event: any) => applyThinkingDefault(pi, event?.model));
  pi.on("session_start", (_event: any, ctx: any) => applyThinkingDefault(pi, ctx?.model));

  // Named convenience command; the same flow is also reachable via `/login`.
  pi.registerCommand("uva-login", {
    description: "Connect a UvA/HvA proxy: pick base URL, paste API key, auto-discover models",
    handler: async (_args: string, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/uva-login needs interactive UI (or set UVA_API_KEY + UVA_BASE_URL).", "error");
        return;
      }
      const oauth = makeOAuth(pi);
      try {
        const cred = await oauth.login({
          onSelect: (p: any) =>
            ctx.ui
              .select(
                p.message,
                p.options.map((o: any) => o.label),
              )
              .then((label: string | undefined) =>
                label ? p.options.find((o: any) => o.label === label)?.id : undefined,
              ),
          onPrompt: (p: any) => ctx.ui.input(p.message, p.placeholder).then((v: string | undefined) => v ?? ""),
          onProgress: (m: string) => ctx.ui.notify(m, "info"),
          onAuth: () => {},
          onDeviceCode: () => {},
        });
        ctx.ui.notify(`Connected to ${cred.baseUrl}. Open /models to pick one.`, "info");
      } catch (err) {
        ctx.ui.notify(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("configure-models", {
    description: "Override a model's context window, max output, reasoning, and default thinking level",
    handler: async (_args: string, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/configure-models needs interactive UI.", "error");
        return;
      }
      if (!currentModels.length) {
        ctx.ui.notify("No models loaded yet - run /login (or set UVA_API_KEY) first.", "error");
        return;
      }
      const draft: Record<string, any> = JSON.parse(JSON.stringify(loadOverrides()));
      const SAVE = "\u2714 Save & apply changes";
      const DISCARD = "\u2718 Discard & exit";
      while (true) {
        const ids = currentModels.map((m) => m.id);
        const marked = ids.map((id) => (draft[id] && Object.keys(draft[id]).length ? `${id}  (edited)` : id));
        const pick = await ctx.ui.select("Configure model overrides", [...marked, SAVE, DISCARD]);
        if (pick === undefined || pick === DISCARD) {
          ctx.ui.notify("No changes applied.", "info");
          return;
        }
        if (pick === SAVE) {
          for (const k of Object.keys(draft)) {
            if (!draft[k] || Object.keys(draft[k]).length === 0) delete draft[k];
          }
          try {
            saveOverrides(draft);
            registerProviderNow(pi, await buildModels(activeApiKey, activeBaseUrl), activeBaseUrl);
            if (ctx.model) applyThinkingDefault(pi, ctx.model);
            ctx.ui.notify(`Saved & applied overrides for ${Object.keys(draft).length} model(s).`, "info");
          } catch (err) {
            ctx.ui.notify(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        const id = pick.replace(/  \(edited\)$/, "");
        await configureOneModel(ctx, id, draft);
      }
    },
  });
}
