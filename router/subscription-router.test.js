import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SubscriptionRouter from "./subscription-router.js";
import ProviderErrorNormalizer from "./provider-error-normalizer.js";

const roots = [];
const actualConfig = new URL("../config/omo.jsonc", import.meta.url);
const config = Bun.JSONC.parse(await readFile(actualConfig, "utf8"))["[opencode]"];
const ids = [...new Set([...Object.values(config.agents), ...Object.values(config.categories)].flatMap((value) => (value.models ?? (value.model ? [value.model, ...(value.fallback_models ?? [])] : [])).map((entry) => typeof entry === "string" ? entry : entry.model)))];

afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(auth = { anthropic: { type: "oauth" }, openai: { type: "oauth" } }) {
  const root = await mkdtemp(join(tmpdir(), "router-test-"));
  roots.push(root);
  const authFile = join(root, "auth.json");
  await writeFile(authFile, JSON.stringify(auth));
  const all = ["anthropic", "openai", "opencode-go"].map((provider) => ({
    id: provider,
    models: Object.fromEntries(ids.filter((id) => id.startsWith(`${provider}/`)).map((id) => [id.slice(provider.length + 1), { capabilities: { input: { image: !id.includes("glm-5.3") || id.includes("flash") } }, variants: { low: {}, high: {}, max: {} } }])),
  }));
  const notices = [];
  const client = { provider: { list: async () => ({ data: { all, connected: all.map((provider) => provider.id) } }) }, tui: { showToast: async ({ body }) => notices.push(body.message) }, session: { get: async () => ({ data: {} }) } };
  const options = { configFile: actualConfig, authFile, stateDir: join(root, "state") };
  const hooks = await SubscriptionRouter({ client }, options);
  return { hooks, root, options, client, notices };
}

async function message(hooks, sessionID, model, agent = "Sisyphus - ultraworker", lane) {
  const [providerID, modelID] = model.split("/");
  const output = { message: { model: { providerID, modelID } }, parts: lane ? [{ type: "text", text: `[subscription-router-lane:${lane}]` }] : [] };
  await hooks["chat.message"]({ sessionID, agent, model: { providerID, modelID } }, output);
  return `${output.message.model.providerID}/${output.message.model.modelID}`;
}

async function snapshot(options) {
  const events = await readdir(join(options.stateDir, "events"));
  const state = {};
  for (const file of events.filter((name) => name.endsWith(".json"))) {
    const event = JSON.parse(await readFile(join(options.stateDir, "events", file), "utf8"));
    if ((state[event.key]?.until ?? 0) < event.until) state[event.key] = event;
  }
  return state;
}

test("Neue Main-Session verwendet Opus statt eines alten UI-Recent-Modells", async () => {
  const { hooks } = await fixture();
  expect(await message(hooks, "main", "openai/gpt-6.1-sol")).toBe("anthropic/claude-opus-5-5");
});

test("Claude-Weekly-Limit sperrt den Provider für neue Child-Sessions und überlebt Neustart", async () => {
  const { hooks, options, client } = await fixture();
  await message(hooks, "main", "anthropic/claude-opus-5-5");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "main", error: { statusCode: 429, message: "Weekly usage limit reached" } } } });
  const restarted = await SubscriptionRouter({ client }, options);
  expect(await message(restarted, "child", "anthropic/claude-sonnet-5-5", "prometheus")).toBe("openai/gpt-6.1-sol");
  const state = await snapshot(options);
  expect(state["provider:anthropic"].kind).toBe("quota");
});

test("Codex-Quota überspringt alle GPT-Rungs direkt bis zum Go-Fallback", async () => {
  const { hooks } = await fixture();
  await message(hooks, "senior", "openai/gpt-6.1-sol", "Sisyphus-Junior", "deep");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "senior", error: { statusCode: 429, message: "usage_limit_reached" } } } });
  expect(await message(hooks, "new-main", "openai/gpt-6.1-sol", "Sisyphus-Junior", "deep")).toBe("anthropic/claude-opus-5-5");
  await message(hooks, "claude", "anthropic/claude-opus-5-5");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "claude", error: { statusCode: 429, message: "weekly limit reached" } } } });
  expect(await message(hooks, "fallback", "openai/gpt-6.1-sol", "Sisyphus-Junior", "deep")).toBe("opencode-go/kimi-k3");
});

test("Ein Go-Modelllimit sperrt GLM Flash, aber nicht DeepSeek; Quick bleibt günstig", async () => {
  const { hooks } = await fixture();
  await message(hooks, "quick", "opencode-go/glm-5.3-flash", "Sisyphus-Junior", "quick");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "quick", error: { statusCode: 429, message: "This model has reached its weekly usage limit" } } } });
  expect(await message(hooks, "quick2", "opencode-go/glm-5.3-flash", "Sisyphus-Junior", "quick")).toBe("opencode-go/deepseek-v4.1-flash");
});

test("Review-Chain bleibt bei der unabhängigen Familie und scheitert geschlossen bei Quota", async () => {
  const { hooks } = await fixture();
  await message(hooks, "review", "anthropic/claude-opus-5-5", "Sisyphus-Junior", "review-claude");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "review", error: { statusCode: 429, message: "weekly quota exhausted" } } } });
  await expect(message(hooks, "review2", "anthropic/claude-opus-5-5", "Sisyphus-Junior", "review-claude")).rejects.toThrow("Alle geeigneten");
});

test("Abgelaufener Cooldown gibt die Primary wieder frei; fremde/PAYG-Provider werden abgewiesen", async () => {
  const { hooks, options } = await fixture();
  await message(hooks, "main", "anthropic/claude-opus-5-5");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "main", error: { statusCode: 503, message: "overloaded" } } } });
  const files = await readdir(join(options.stateDir, "events"));
  for (const file of files) await writeFile(join(options.stateDir, "events", file), JSON.stringify({ key: "provider:anthropic", until: Date.now() - 1 }));
  expect(await message(hooks, "new", "openai/gpt-6.1-sol")).toBe("anthropic/claude-opus-5-5");
  await expect(message(hooks, "paid", "opencode/claude-opus-5-5")).rejects.toThrow("PAYG");
});

test("OpenAI-/Anthropic-API-Credentials sind kein Subscription-Fallback", async () => {
  const { hooks } = await fixture({ openai: { type: "api", key: "not-a-real-key" } });
  expect(await message(hooks, "main", "openai/gpt-6.1-sol")).toBe("opencode-go/kimi-k3");
  await expect(hooks["chat.params"]({ sessionID: "api", model: { providerID: "openai", id: "gpt-6.1-sol" } })).rejects.toThrow("API-Abrechnung blockiert");
});

test("Flash darf Security-Dateien nicht editieren, Auth-Tests aber vorbereiten", async () => {
  const { hooks } = await fixture();
  await message(hooks, "worker", "opencode-go/deepseek-v4.1-flash", "Sisyphus-Junior", "quick");
  await expect(hooks["tool.execute.before"]({ sessionID: "worker", tool: "edit" }, { args: { filePath: "/repo/src/auth/login.ts" } })).rejects.toThrow("ESCALATE");
  await hooks["tool.execute.before"]({ sessionID: "worker", tool: "write" }, { args: { filePath: "/repo/tests/auth/login.test.ts" } });
});

test("Parallele Fehler von zwei Plugin-Instanzen verlieren keine Provider-Cooldowns", async () => {
  const { hooks, options, client } = await fixture();
  const sibling = await SubscriptionRouter({ client }, options);
  await message(hooks, "claude", "anthropic/claude-opus-5-5");
  await message(sibling, "openai", "openai/gpt-6.1-sol", "Sisyphus-Junior", "deep");
  await Promise.all([
    hooks.event({ event: { type: "session.error", properties: { sessionID: "claude", error: { statusCode: 429, message: "quota exhausted" } } } }),
    sibling.event({ event: { type: "session.error", properties: { sessionID: "openai", error: { statusCode: 429, message: "quota exhausted" } } } }),
  ]);
  expect(Object.keys(await snapshot(options)).sort()).toEqual(["provider:anthropic", "provider:openai"]);
});

test("Native synthetische Child-Prompts behalten die Task-Kategorie ohne Textmarker", async () => {
  const { hooks, client } = await fixture();
  client.session = {
    get: async () => ({ data: { parentID: "parent", title: "rename-one (@Sisyphus-Junior subagent)" } }),
    messages: async () => ({ data: [{ parts: [{ type: "tool", tool: "task", state: { input: { description: "rename-one", category: "quick" } } }] }] }),
  };
  expect(await message(hooks, "native-child", "opencode-go/glm-5.3-flash", "Sisyphus-Junior")).toBe("opencode-go/glm-5.3-flash");
});

test("Subscription-Reset-Header steuert den providerweiten Cooldown", async () => {
  const { hooks, options } = await fixture();
  await message(hooks, "main", "anthropic/claude-opus-5-5");
  const reset = Math.floor(Date.now() / 1000) + 240;
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "main", error: { statusCode: 429, message: "account rate limit", responseHeaders: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(reset) } } } } });
  const state = await snapshot(options);
  expect(state["provider:anthropic"].kind).toBe("quota");
  expect(Math.abs(state["provider:anthropic"].until - reset * 1000)).toBeLessThan(1000);
});

test("Unbekannte Review-Lane wird nicht in einen normalen Worker umgewandelt", async () => {
  const { hooks } = await fixture();
  await expect(message(hooks, "review", "openai/gpt-6-astra", "Sisyphus-Junior", "review-openai-removed")).rejects.toThrow("Unbekannte Kategorie");
});

test("Go-Quota mit unbekanntem Scope sperrt konservativ die Subscription", async () => {
  const { hooks, options } = await fixture();
  await message(hooks, "quick", "opencode-go/deepseek-v4.1-flash", "Sisyphus-Junior", "quick");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "quick", error: { statusCode: 429, message: "You have reached your weekly usage limit" } } } });
  expect((await snapshot(options))["provider:opencode-go"].kind).toBe("quota");
  expect(await message(hooks, "next", "opencode-go/deepseek-v4.1-flash", "Sisyphus-Junior", "quick")).toBe("openai/gpt-6-luna");
});

test("Abgelehntes Anthropic-Overage bei erlaubtem Abo ist keine Weekly-Quota", async () => {
  const { hooks, options } = await fixture();
  await message(hooks, "main", "anthropic/claude-opus-5-5");
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "main", error: { statusCode: 529, message: "overloaded", responseHeaders: { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-overage-status": "rejected", "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 86400) } } } } });
  const state = await snapshot(options);
  expect(state["provider:anthropic"].kind).toBe("provider-error");
  expect(state["provider:anthropic"].until - Date.now()).toBeLessThanOrEqual(60000);
});

test("Regionsfehler im nativen Retry-Status erhalten eine OmO-kompatible Klassifikation", async () => {
  const normalizer = await ProviderErrorNormalizer();
  const event = { type: "session.status", properties: { status: { type: "retry", message: "This Go model requires Global regions. Select Global in Privacy settings." } } };
  await normalizer.event({ event });
  expect(event.properties.status.message).toStartWith("Model not supported");
});
