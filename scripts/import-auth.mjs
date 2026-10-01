import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class ImportError extends Error {
  constructor(code) {
    super(`Auth-Import abgelehnt (${code}).`);
    this.name = "ImportError";
    this.code = code;
  }
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.length > 0;
const own = (value, key) => Object.hasOwn(value, key);

export function parseAuth(value) {
  if (!object(value) || Object.keys(value).length === 0) throw new ImportError("schema");
  const result = {};
  for (const [provider, entry] of Object.entries(value)) {
    if (!object(entry)) throw new ImportError("schema");
    let keys;
    switch (provider) {
      case "anthropic":
      case "openai":
        keys = ["type", "refresh", "access", "expires", "accountId", "enterpriseUrl"];
        if (entry.type !== "oauth" || !nonempty(entry.refresh) || !nonempty(entry.access) ||
            !Number.isFinite(entry.expires) || !Number.isInteger(entry.expires) || entry.expires < 0 ||
            ["accountId", "enterpriseUrl"].some((key) => own(entry, key) && typeof entry[key] !== "string")) {
          throw new ImportError("schema");
        }
        break;
      case "opencode-go":
        keys = ["type", "key", "metadata"];
        if (entry.type !== "api" || !nonempty(entry.key) ||
            (own(entry, "metadata") && (!object(entry.metadata) || Object.values(entry.metadata).some((item) => typeof item !== "string")))) {
          throw new ImportError("schema");
        }
        break;
      default:
        throw new ImportError("provider");
    }
    if (Object.keys(entry).some((key) => !keys.includes(key))) throw new ImportError("schema");
    result[provider] = entry;
  }
  return result;
}

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

async function privateDirectory(path) {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split("/")) {
    if (!component) continue;
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ImportError("directory");
  }
  await chmod(path, 0o700);
}

async function sourceAuth(source) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ImportError("source-file");
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new ImportError("source-file");
    let value;
    try { value = JSON.parse(await file.readFile("utf8")); }
    catch { throw new ImportError("json"); }
    return parseAuth(value);
  } finally { await file.close(); }
}

export async function importAuth({ source, targetHome }) {
  if (typeof source !== "string" || !nonempty(source) || typeof targetHome !== "string" || !isAbsolute(targetHome)) {
    throw new ImportError("arguments");
  }
  const target = resolve(targetHome);
  const callerHome = await realpath(homedir()).catch((error) => {
    if (error.code === "ENOENT") return resolve(homedir());
    throw error;
  });
  if (target === parse(target).root || target === resolve(homedir()) || target === callerHome) throw new ImportError("unsafe-home");
  const existingHome = await optionalStat(target);
  if (existingHome && (existingHome.isSymbolicLink() || !existingHome.isDirectory())) throw new ImportError("unsafe-home");
  if (existingHome && await realpath(target) === callerHome) throw new ImportError("unsafe-home");
  const auth = await sourceAuth(source);
  await privateDirectory(target);
  for (const directory of [".local", ".local/share", ".local/share/opencode"]) {
    await privateDirectory(join(target, directory));
  }
  const destination = join(target, ".local/share/opencode/auth.json");
  const existing = await optionalStat(destination);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new ImportError("target-file");
    throw new ImportError("exists");
  }
  const temp = join(target, ".local/share/opencode", `.auth-${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(auth)}\n`);
      await file.sync();
    } finally { await file.close(); }
    // Exclusive hard-link publication prevents rename's overwrite race. Both names
    // then refer to the same complete inode; POSIX rename cannot replace other data.
    try { await link(temp, destination); }
    catch (error) { if (error.code === "EEXIST") throw new ImportError("exists"); throw error; }
    await rename(temp, destination);
  } finally { await rm(temp, { force: true }); }
}

export async function main(args) {
  try {
    if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--target-home") throw new ImportError("arguments");
    await importAuth({ source: args[1], targetHome: args[3] });
    console.log("Auth-Import erfolgreich; keine Zugangsdaten ausgegeben.");
    return 0;
  } catch (error) {
    console.error(error instanceof ImportError ? error.message : "Auth-Import fehlgeschlagen (Dateisystem).");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
