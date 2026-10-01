import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");
const opencode = Bun.JSONC.parse(await read("config/opencode.jsonc"));
const omo = Bun.JSONC.parse(await read("config/omo.jsonc"));
assert.equal(opencode.$schema, "https://opencode.ai/config.json");
assert.deepEqual(opencode.enabled_providers, ["anthropic", "openai", "opencode-go"]);
assert.deepEqual(opencode.plugin, [
  "file:///home/opencode/.config/opencode/router/provider-error-normalizer.js",
  "oh-my-openagent@5.1.7",
  "@ex-machina/opencode-anthropic-auth@1.8.6",
  "file:///home/opencode/.config/opencode/router/subscription-router.js",
]);
assert.equal(opencode.autoupdate, false);
assert.deepEqual(opencode.instructions, ["/home/opencode/.config/opencode/router/orchestration.md"]);
assert.equal(Object.keys(omo["[opencode]"].agents).length, 11);
assert.equal(Object.keys(omo["[opencode]"].categories).length, 17);
assert.equal(omo["[opencode]"].categories.artistry.disable, true);
assert.deepEqual(omo._migrations, ["2026-08-reasoning-unification", "2026-09-category-deep-split"]);
const routing = omo["[opencode]"];
for (const [name, entry] of [...Object.entries(routing.agents), ...Object.entries(routing.categories)]) {
  if (entry.disable) continue;
  const chain = entry.models ?? [entry.model, ...(entry.fallback_models ?? [])];
  assert.ok(chain.length > 0, name);
  for (const item of chain) {
    const model = typeof item === "string" ? item : item.model;
    assert.match(model, /^(anthropic|openai|opencode-go)\/.+$/, name);
    if (name === "review-openai") assert.ok(model.startsWith("openai/"));
    if (name === "review-claude") assert.ok(model.startsWith("anthropic/"));
  }
  if (entry.prompt_append?.startsWith("file:")) assert.equal(entry.prompt_append, "file:///home/opencode/.config/opencode/router/orchestration.md");
}
assert.equal(routing.runtime_fallback.enabled, true);
assert.equal(routing.model_fallback, false);
const docker = await read("Dockerfile");
assert.ok(docker.includes("opencode-ai@1.18.34"));
assert.ok(docker.includes("USER 10001:10001"));
const compose = await read("compose.yaml");
assert.ok(compose.includes("${WORKSPACE:-.}:/workspace"));
assert.ok(compose.includes("opencode-home:/home/opencode"));
assert.doesNotMatch(compose, /ports:|docker\.sock|privileged:|network_mode:|\$\{?HOME/);
let checked = 0;
for (const directory of ["router", "scripts"]) {
  for (const file of await readdir(join(root, directory))) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const path = join(directory, file);
    const source = await read(path);
    assert.doesNotMatch(source, /\/Users\/|\/var\/folders\//, path);
    const pureLines = source.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//")).length;
    assert.ok(pureLines <= 250, `${path}: ${pureLines} pure LOC`);
    const result = await Bun.build({ entrypoints: [join(root, path)], target: "bun", packages: "external", write: false });
    assert.ok(result.success, `${path}: ${result.logs.join("\n")}`);
    console.log(`Syntax/LOC OK: ${path} (${pureLines})`);
    checked++;
  }
}
for (const path of ["config/opencode.jsonc", "config/omo.jsonc", "router/orchestration.md"]) {
  assert.doesNotMatch(await read(path), /\/Users\/|\/var\/folders\//, path);
}
const shell = Bun.spawn(["sh", "-n", join(root, "scripts/container-entrypoint.sh")], { stdout: "inherit", stderr: "inherit" });
assert.equal(await shell.exited, 0);
console.log(`Static checks passed: ${checked} JS modules; JSONC, routing, pins, portable paths, container constraints, shell syntax.`);
