import { parseArgs } from "@std/cli/parse-args";
import { join, relative } from "@std/path";
import { BlobReader, ZipWriter } from "@zip-js/zip-js";
import bundle from "../bundle.config.ts";

const DIST = "dist";
const STAGE = join(DIST, "stage");
const PACKAGES = join(DIST, "packages");

/** Runs a required build command and preserves its diagnostics. */
async function run(command: string, ...args: string[]): Promise<void> {
  const status = await new Deno.Command(command, { args }).spawn().status;
  if (!status.success) {
    throw new Error(`${command} failed with ${status.code}`);
  }
}

/** Yields ordinary files below a package staging directory. */
async function* walk(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

/** Writes the universal Agent package with deterministic ordinary-file permissions. */
async function writeOrax(destination: string): Promise<void> {
  const writer = new ZipWriter((await Deno.create(destination)).writable);
  for await (const path of walk(STAGE)) {
    const name = relative(STAGE, path).replaceAll("\\", "/");
    await writer.add(
      name,
      new BlobReader(new Blob([await Deno.readFile(path)])),
      {
        externalFileAttribute: (0o100_644 << 16) >>> 0,
      },
    );
  }
  await writer.close();
}

/** Returns the lowercase SHA-256 used by marketplace manifests. */
async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Builds the local package and release-form manifest without publishing either artifact. */
async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, { string: ["tag", "repo"] });
  const tag = flags.tag ?? "v0.2.0";
  const repo = flags.repo ?? "ora-space/claude-code-agent";
  await Deno.remove(DIST, { recursive: true }).catch(() => {});
  await Deno.mkdir(STAGE, { recursive: true });
  await Deno.mkdir(PACKAGES, { recursive: true });
  await run(
    Deno.execPath(),
    "bundle",
    "src/main.ts",
    "-o",
    join(DIST, "main.js"),
  );
  await Deno.copyFile(join(DIST, "main.js"), join(STAGE, "main.js"));
  for (const name of ["orax.toml", "README.md", "logo.svg"]) {
    await Deno.copyFile(name, join(STAGE, name));
  }
  const fileName = `ora-space.claude-${tag}.orax`;
  const packagePath = join(PACKAGES, fileName);
  await writeOrax(packagePath);
  const digest = await sha256(packagePath);
  const manifest = `${(await Deno.readTextFile("orax.toml")).trimEnd()}\n\n` +
    `url = "https://github.com/${repo}/releases/download/${tag}/${fileName}"\n` +
    `sha256 = "${digest}"\n` +
    `# Validated adapter baseline: claude-agent-acp ${bundle.adapterVersion}\n`;
  await Deno.writeTextFile(join(DIST, "manifest.toml"), manifest);
  console.log(`${packagePath} sha256=${digest}`);
}

await main();
