import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { importAuth, ImportError, parseAuth } from "./import-auth.mjs";

const roots = [];
const oauth = { type: "oauth", refresh: "synthetic-refresh", access: "synthetic-access", expires: 0 };
const valid = {
  anthropic: { ...oauth, accountId: "", enterpriseUrl: "https://synthetic.invalid" },
  openai: { ...oauth },
  "opencode-go": { type: "api", key: "synthetic-key", metadata: { scope: "synthetic" } },
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(value = valid) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "auth-import-test-"));
  roots.push(root);
  const source = join(root, "source.json");
  const targetHome = join(root, "isolated-home");
  const destination = join(targetHome, ".local/share/opencode/auth.json");
  await writeFile(source, JSON.stringify(value), { mode: 0o600 });
  return { root, source, targetHome, destination };
}

test("import preserves exact allowed synthetic entries and private permissions", async () => {
  const paths = await fixture();
  await importAuth(paths);
  expect(JSON.parse(await readFile(paths.destination, "utf8"))).toEqual(valid);
  expect((await stat(paths.destination)).mode & 0o777).toBe(0o600);
  for (const path of [paths.targetHome, ".local", ".local/share", ".local/share/opencode"].map((path, i) => i === 0 ? path : join(paths.targetHome, path))) {
    expect((await stat(path)).mode & 0o777).toBe(0o700);
  }
  expect(await readdir(join(paths.targetHome, ".local/share/opencode"))).toEqual(["auth.json"]);
});

test.each(["anthropic", "openai"])("accepts %s alone with optional fields absent", (provider) => {
  expect(parseAuth({ [provider]: oauth })).toEqual({ [provider]: oauth });
});

test("accepts Go without optional metadata", () => {
  expect(parseAuth({ "opencode-go": { type: "api", key: "synthetic" } })).toEqual({ "opencode-go": { type: "api", key: "synthetic" } });
});

test.each([null, [], {}, "synthetic", { other: oauth }, { anthropic: oauth, other: oauth }, { __proto__: null, constructor: oauth }].map((value) => [value]))("rejects non-object/empty/unknown provider input %#", (value) => {
  expect(() => parseAuth(value)).toThrow(ImportError);
});

const badOauth = [
  null, [], "synthetic", {}, { ...oauth, type: "api" },
  { ...oauth, refresh: "" }, { ...oauth, access: "" },
  { ...oauth, refresh: 1 }, { ...oauth, access: null },
  { type: "oauth", access: "synthetic", expires: 0 },
  { type: "oauth", refresh: "synthetic", expires: 0 },
  { type: "oauth", refresh: "synthetic", access: "synthetic" },
  ...[-1, 0.5, Infinity, NaN, "0", null].map((expires) => ({ ...oauth, expires })),
  { ...oauth, accountId: 1 }, { ...oauth, enterpriseUrl: null },
  { ...oauth, extra: "synthetic" }, { ...oauth, key: "synthetic" },
];
for (const provider of ["anthropic", "openai"]) {
  test.each(badOauth.map((entry) => [entry]))(`rejects malformed ${provider} entry %#`, (entry) => {
    expect(() => parseAuth({ [provider]: entry })).toThrow(ImportError);
  });
}

test.each([
  { type: "oauth", key: "synthetic" }, { type: "api" },
  { type: "api", key: "" }, { type: "api", key: 1 },
  { type: "api", key: "synthetic", metadata: [] },
  { type: "api", key: "synthetic", metadata: null },
  { type: "api", key: "synthetic", metadata: { number: 1 } },
  { type: "api", key: "synthetic", extra: "synthetic" },
])("rejects malformed Go entry %#", (entry) => {
  expect(() => parseAuth({ "opencode-go": entry })).toThrow(ImportError);
});

test("rejects malformed selected entry instead of dropping it", async () => {
  const paths = await fixture({ anthropic: oauth, openai: { ...oauth, refresh: "" } });
  await expect(importAuth(paths)).rejects.toThrow("schema");
});

test.each(["/", "relative", "", homedir(), join(homedir(), "x/..")])("rejects unsafe target home %#", async (targetHome) => {
  const paths = await fixture();
  await expect(importAuth({ ...paths, targetHome })).rejects.toThrow(ImportError);
});

test("rejects absent explicit target home", async () => {
  const paths = await fixture();
  await expect(importAuth({ source: paths.source })).rejects.toThrow("arguments");
});

test("rejects source symlink", async () => {
  const paths = await fixture();
  const source = join(paths.root, "source-link");
  await symlink(paths.source, source);
  await expect(importAuth({ ...paths, source })).rejects.toThrow("source-file");
});

test("rejects non-regular source directory", async () => {
  const paths = await fixture();
  await expect(importAuth({ ...paths, source: paths.root })).rejects.toThrow("source-file");
});

test("rejects target home symlink including caller-home aliases", async () => {
  const paths = await fixture();
  await symlink(homedir(), paths.targetHome);
  await expect(importAuth(paths)).rejects.toThrow("unsafe-home");
});

test("rejects symlink data directory", async () => {
  const paths = await fixture();
  await mkdir(paths.targetHome, { mode: 0o700 });
  await symlink(paths.root, join(paths.targetHome, ".local"));
  await expect(importAuth(paths)).rejects.toThrow("directory");
});

test("rejects symlink in target ancestors", async () => {
  const paths = await fixture();
  const alias = join(paths.root, "alias");
  await symlink(paths.root, alias);
  await expect(importAuth({ ...paths, targetHome: join(alias, "nested") })).rejects.toThrow("directory");
});

test.each(["file", "symlink", "dangling-symlink", "directory"])("rejects existing target %s without reading or replacing it", async (kind) => {
  const paths = await fixture();
  await mkdir(join(paths.targetHome, ".local/share/opencode"), { recursive: true, mode: 0o700 });
  switch (kind) {
    case "file": await writeFile(paths.destination, "synthetic-existing-invalid-json"); break;
    case "symlink": await symlink(paths.source, paths.destination); break;
    case "dangling-symlink": await symlink(join(paths.root, "absent"), paths.destination); break;
    case "directory": await mkdir(paths.destination); break;
    default: throw new Error("unknown test case");
  }
  await expect(importAuth(paths)).rejects.toThrow(ImportError);
  if (kind === "file") expect(await readFile(paths.destination, "utf8")).toBe("synthetic-existing-invalid-json");
});

test("existing permissive data directories become private", async () => {
  const paths = await fixture();
  await mkdir(join(paths.targetHome, ".local/share/opencode"), { recursive: true });
  await chmod(join(paths.targetHome, ".local/share/opencode"), 0o755);
  await importAuth(paths);
  expect((await stat(join(paths.targetHome, ".local/share/opencode"))).mode & 0o777).toBe(0o700);
});

test("parallel import publishes one complete file without overwriting", async () => {
  const paths = await fixture();
  const results = await Promise.allSettled([importAuth(paths), importAuth(paths)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(JSON.parse(await readFile(paths.destination, "utf8"))).toEqual(valid);
});

test("CLI imports using an explicit isolated HOME and never prints synthetic values", async () => {
  const paths = await fixture();
  const child = Bun.spawn([process.execPath, new URL("./import-auth.mjs", import.meta.url).pathname, "--source", paths.source, "--target-home", paths.targetHome], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(paths.root, "caller") } });
  const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(output).not.toContain("synthetic");
  expect(JSON.parse(await readFile(paths.destination, "utf8"))).toEqual(valid);
});

test("CLI error does not disclose malformed JSON values", async () => {
  const paths = await fixture();
  await writeFile(paths.source, '{"synthetic-secret-DO-NOT-LOG":');
  const child = Bun.spawn([process.execPath, new URL("./import-auth.mjs", import.meta.url).pathname, "--source", paths.source, "--target-home", paths.targetHome], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(output).not.toContain("synthetic-secret-DO-NOT-LOG");
});
