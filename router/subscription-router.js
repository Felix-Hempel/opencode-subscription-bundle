import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Ergänzt OmO, ersetzt dessen getestete Runtime-Recovery nicht.
export default async function SubscriptionRouter({ client }, options = {}) {
  const home = homedir();
  const configFile = options.configFile ?? join(home, ".omo/omo.jsonc");
  const authFile = options.authFile ?? join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "opencode/auth.json");
  const stateDir = options.stateDir ?? join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "opencode/subscription-router");
  const stateFile = join(stateDir, "cooldowns.json");
  const eventDir = join(stateDir, "events");
  const allowed = new Set(["anthropic", "openai", "opencode-go"]);
  const sessions = new Map();
  const sessionInfo = new Map();
  let catalog;
  let catalogTime = 0;

  const json = async (path, fallback) => {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  };
  const view = async () => Bun.JSONC.parse(await readFile(configFile, "utf8"))["[opencode]"] ?? {};
  const entry = (candidate) => typeof candidate === "string" ? { model: candidate } : candidate;
  const chain = (config) => (config?.models ?? (config?.model ? [{ model: config.model, reasoning: config.reasoning }, ...(config.fallback_models ?? [])] : [])).map(entry);
  const split = (model) => { const i = model.indexOf("/"); return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }; };
  const modelName = (model) => model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : undefined;

  async function cooldowns() {
    const state = await json(stateFile, {}); // Bereits vorhandene State-Datei bleibt lesbar.
    const files = await readdir(eventDir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const path = join(eventDir, file);
      const event = await json(path, undefined);
      if (!event) continue;
      if (event.until <= Date.now()) { await rm(path, { force: true }); continue; }
      if ((state[event.key]?.until ?? 0) < event.until) state[event.key] = { until: event.until, kind: event.kind };
    }
    return state;
  }

  async function oauthProvider(provider) {
    if (!allowed.has(provider)) return false;
    if (provider === "opencode-go") return true; // Nativer Console-Connection-Store wird von OpenCode verwaltet.
    return (await json(authFile, {}))[provider]?.type === "oauth";
  }

  async function availableModels() {
    if (catalog && Date.now() - catalogTime < 30000) return catalog;
    const response = await client.provider.list();
    const data = response.data;
    if (!data?.all || !Array.isArray(data.connected)) throw new Error("Subscription router: Modellkatalog nicht erreichbar.");
    const connected = new Set(data.connected);
    catalog = new Map();
    for (const provider of data.all) {
      if (!connected.has(provider.id) || !await oauthProvider(provider.id)) continue;
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        catalog.set(`${provider.id}/${id}`, model);
      }
    }
    catalogTime = Date.now();
    return catalog;
  }

  async function notify(message) {
    await client.tui.showToast({ body: { title: "Subscription Router", message, variant: "warning", duration: 10000 } }).catch(() => {
      console.warn("Subscription router: TUI-Hinweis konnte nicht angezeigt werden.");
    });
  }

  function classify(error, model) {
    const text = JSON.stringify(error ?? {}).toLowerCase();
    const status = Number(error?.statusCode ?? error?.data?.statusCode ?? error?.status ?? 0);
    const provider = split(model).providerID;
    const modelUnavailable = /model.{0,60}(not found|not available|not supported|access denied)|requires global regions|region.{0,30}(not supported|unavailable)/.test(text) || status === 404;
    const headers = Object.fromEntries(Object.entries(error?.responseHeaders ?? error?.data?.responseHeaders ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const rejectedHeaders = Object.entries(headers).filter(([key, value]) => key.startsWith("anthropic-ratelimit-unified") && key.endsWith("status") && !key.includes("overage") && value === "rejected");
    const unifiedQuota = rejectedHeaders.length > 0;
    const quota = unifiedQuota || /quota|usage.limit|weekly.limit|subscription.limit|insufficient.quota|usage_limit_reached|out of extra usage|reached.{0,40}(usage|weekly|limit)/.test(text) || status === 402;
    const auth = status === 401 || /oauth.{0,40}(expired|invalid)|failed to authenticate|invalid.api.key/.test(text);
    const temporary = status === 429 || [500, 502, 503, 504].includes(status) || /rate.limit|capacity|overloaded|timeout|timed out/.test(text);
    if (!modelUnavailable && !quota && !auth && !temporary && status !== 403) return;
    let seconds = modelUnavailable ? 3600 : quota ? 3600 : auth || status === 403 ? 900 : 60;
    const reset = text.match(/(?:resets?_at|reset_at_timestamp)["\s:]+(\d{10,13})/);
    if (reset) {
      const timestamp = Number(reset[1]) * (reset[1].length === 10 ? 1000 : 1);
      seconds = Math.max(60, Math.min(7 * 86400, Math.ceil((timestamp - Date.now()) / 1000)));
    }
    const unifiedReset = Math.max(...rejectedHeaders.map(([key]) => Number(headers[key.replace(/status$/, "reset")])).filter(Number.isFinite));
    if (unifiedQuota && Number.isFinite(unifiedReset) && unifiedReset > Date.now() / 1000) seconds = Math.max(60, Math.min(7 * 86400, Math.ceil(unifiedReset - Date.now() / 1000)));
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const delay = Number(retryAfter);
      const ms = Number.isFinite(delay) ? delay * 1000 : Date.parse(retryAfter) - Date.now();
      if (ms > 0) seconds = Math.max(seconds, Math.min(7 * 86400, Math.ceil(ms / 1000)));
    }
    // Go hat modellbezogene Kontingente. Ein einzelnes Modelllimit sperrt nicht alle Go-Modelle.
    const goModelQuota = provider === "opencode-go" && quota && /this model|model.{0,40}(quota|limit)|model[_ -](?:usage[_ -])?limit/.test(text) && !/workspace.{0,40}(quota|limit)|account.{0,40}(quota|limit)|balance/.test(text);
    return {
      key: modelUnavailable || goModelQuota ? `model:${model}` : `provider:${provider}`,
      kind: modelUnavailable ? "model-unavailable" : quota ? "quota" : auth ? "auth" : "provider-error",
      until: Date.now() + seconds * 1000,
    };
  }

  async function record(failure) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(eventDir, { recursive: true, mode: 0o700 });
    const state = await cooldowns();
    if ((state[failure.key]?.until ?? 0) >= failure.until) return;
    const freshNotice = (state[failure.key]?.until ?? 0) <= Date.now();
    // Unveränderliche, atomar veröffentlichte Events vermeiden Shared-File- und Stale-Lock-Races.
    const path = join(eventDir, `${randomUUID()}.json`);
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(failure), { mode: 0o600 });
    await rename(temp, path);
    if (freshNotice) await notify(`${failure.key}: ${failure.kind}; Cooldown bis ${new Date(failure.until).toLocaleTimeString()}.`);
  }

  function resolveChain(config, agent, lane, requested) {
    if (lane === "deep" && !config.categories?.deep) lane = "deep-low";
    if (lane && !config.categories?.[lane]) throw new Error(`Subscription router: Unbekannte Kategorie ${lane}; kein stilles Downgrade.`);
    if (lane && config.categories?.[lane]) return chain(config.categories[lane]);
    const agentKey = Object.keys(config.agents ?? {}).find((name) => name.toLowerCase() === agent?.toLowerCase() || agent?.toLowerCase().startsWith(`${name.toLowerCase()} (`) || agent?.toLowerCase().startsWith(`${name.toLowerCase()} -`));
    if (agentKey) return chain(config.agents[agentKey]);
    // Native build/plan/general und interne Utility-Sessions erhalten explizite Chains.
    if (agent === "plan") return chain(config.agents?.prometheus);
    if (["title", "summary"].includes(agent)) return chain(config.categories?.quick);
    if (agent === "explore") return chain(config.agents?.explore);
    if (agent === "general") return chain(config.categories?.["deep-low"]);
    if (requested && !allowed.has(split(requested).providerID)) throw new Error("Subscription router: Nicht freigegebener Provider.");
    return chain(config.agents?.sisyphus);
  }

  async function delegatedLane(sessionID) {
    const session = sessionInfo.get(sessionID) ?? (await client.session.get({ path: { id: sessionID } })).data;
    if (!session?.parentID) return undefined;
    const response = await client.session.messages({ path: { id: session.parentID } });
    const title = session.title?.replace(/\s+\(@[^)]+ subagent\)$/, "");
    const matches = (response.data ?? []).flatMap((message) => message.parts ?? []).filter((part) =>
      part.type === "tool" && part.tool === "task" && part.state?.input?.category &&
      (part.state.metadata?.sessionId === sessionID || part.state.metadata?.sessionID === sessionID || part.state.input.description === title || part.state.title === title)
    );
    const categories = [...new Set(matches.map((part) => part.state.input.category))];
    if (categories.length !== 1) throw new Error("Subscription router: Delegationskategorie nicht eindeutig; kein stilles Downgrade. Eindeutige task.description verwenden.");
    return categories[0];
  }

  async function select(candidates, requested, state, modalities) {
    const models = await availableModels();
    const ordered = requested && candidates.some((item) => item.model === requested)
      ? [candidates.find((item) => item.model === requested), ...candidates.filter((item) => item.model !== requested)]
      : candidates;
    for (const candidate of ordered) {
      const id = split(candidate.model);
      const metadata = models.get(candidate.model);
      if (!metadata || (state[`provider:${id.providerID}`]?.until ?? 0) > Date.now() || (state[`model:${candidate.model}`]?.until ?? 0) > Date.now()) continue;
      if (modalities.some((modality) => !metadata.capabilities?.input?.[modality])) continue;
      return { ...candidate, variant: candidate.reasoning && metadata.variants?.[candidate.reasoning] ? candidate.reasoning : undefined };
    }
    throw new Error("Subscription router: Alle geeigneten Subscription-Modelle dieser Chain sind unavailable/cooldown. Arbeitsstand erhalten; kein PAYG-Fallback.");
  }

  return {
    async config(config) {
      config.enabled_providers = [...allowed];
      config.default_agent = "Sisyphus - ultraworker";
      const state = await cooldowns();
      const main = chain((await view()).agents?.sisyphus);
      const preferred = main.find((candidate) => (state[`provider:${split(candidate.model).providerID}`]?.until ?? 0) <= Date.now() && (state[`model:${candidate.model}`]?.until ?? 0) <= Date.now());
      if (preferred) config.model = preferred.model;
    },
    async "chat.message"(input, output) {
      const config = await view();
      const text = (output.parts ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      const storedLane = sessions.get(input.sessionID)?.lane;
      const nativeLane = !storedLane && /^sisyphus-junior/i.test(input.agent ?? "") ? await delegatedLane(input.sessionID) : undefined;
      const lane = storedLane ?? nativeLane ?? [...text.matchAll(/\[subscription-router-lane:([a-z-]+)\]/g)].at(-1)?.[1];
      const requested = modelName(output.message.model ?? input.model);
      if (requested && !allowed.has(split(requested).providerID)) throw new Error("Subscription router: PAYG-/Fremdprovider blockiert.");
      const candidates = resolveChain(config, input.agent, lane, requested);
      const modalities = [...new Set((output.parts ?? []).filter((part) => part.type === "file").flatMap((part) => part.mime === "application/pdf" ? ["pdf"] : /^(image|audio|video)\//.test(part.mime ?? "") ? [part.mime.split("/")[0]] : []))];
      // Neue Sessions starten auf ihrer Chain-Primary, nicht auf einem alten UI- oder Agent-Default.
      const preferred = sessions.has(input.sessionID) ? requested : undefined;
      const selected = await select(candidates, preferred, await cooldowns(), modalities);
      output.message.model = split(selected.model);
      if (selected.variant) output.message.variant = selected.variant;
      else delete output.message.variant;
      const previousModel = sessions.get(input.sessionID)?.model;
      sessions.set(input.sessionID, { model: selected.model, lane, agent: input.agent });
      if (requested && selected.model !== requested && previousModel !== selected.model) await notify(`${requested} → ${selected.model} (${lane ?? input.agent ?? "main"})`);
    },
    async "chat.params"(input) {
      if (!await oauthProvider(input.model.providerID)) throw new Error("Subscription router: Claude/OpenAI benötigen Subscription-OAuth; API-Abrechnung blockiert.");
      sessions.set(input.sessionID, { ...sessions.get(input.sessionID), model: `${input.model.providerID}/${input.model.id}` });
    },
    async "tool.execute.before"(input, output) {
      if (input.tool === "task" && typeof output.args?.prompt === "string" && output.args.category) {
        output.args.prompt += `\n[subscription-router-lane:${output.args.category}]`;
      }
      const model = sessions.get(input.sessionID)?.model ?? "";
      if (!/flash|luna|haiku/i.test(model) || !["edit", "write", "apply_patch"].includes(input.tool)) return;
      const files = input.tool === "apply_patch"
        ? [...String(output.args?.patchText ?? "").matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((match) => match[1])
        : [output.args?.filePath ?? output.args?.file_path ?? ""];
      const sensitive = files.some((file) => !/(?:^|\/)(?:tests?|__tests__|fixtures)\/|\.(?:test|spec)\./i.test(file) && /(?:^|\/)(?:auth|authorization|permissions?|oauth|secrets?|payments?|billing|migrations?)(?:\/|\.)|\.github\/workflows\/|\.(?:tf|tfvars)$/i.test(file));
      if (sensitive) throw new Error("ESCALATE: Security-/Infra-Datei darf nicht durch einen Flash-/Utility-Worker geändert werden. Context-Pack an security/deep-high übergeben.");
    },
    async event({ event }) {
      const props = event.properties ?? {};
      const info = props.info;
      if (event.type === "session.created" && info?.id) { sessionInfo.set(info.id, { parentID: info.parentID, title: info.title }); return; }
      const sessionID = props.sessionID ?? info?.sessionID;
      if (!sessionID) return;
      if (event.type === "session.deleted") { sessions.delete(sessionID); sessionInfo.delete(sessionID); return; }
      const model = modelName(info?.model ?? props.model) ?? (info?.providerID && info?.modelID ? `${info.providerID}/${info.modelID}` : sessions.get(sessionID)?.model);
      if (event.type === "message.updated" && info?.role === "assistant" && model) sessions.set(sessionID, { ...sessions.get(sessionID), model });
      const error = event.type === "session.error" ? props.error : event.type === "session.status" && props.status?.type === "retry" ? props.status : info?.role === "assistant" ? info.error : undefined;
      if (!error || !model || !allowed.has(split(model).providerID)) return;
      const failure = classify(error, model);
      if (failure) await record(failure);
    },
  };
}
