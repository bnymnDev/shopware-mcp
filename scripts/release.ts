/**
 * A release from this machine, no CI needed. Every step checks first whether its part is out
 * already, so running the script again after a failure repairs the release instead of
 * repeating it:
 *
 *   1. version   pending changesets become a version, a changelog entry and a commit
 *   2. verify    lint, types, tests, build, generated files, smoke test (scripts/verify.sh)
 *   3. git       tag vX.Y.Z, push main and the tag
 *   4. npm       publish, with NPM_TOKEN (an npm "automation" or granular token)
 *   5. github    a release with the changelog entry and the Claude Desktop bundle
 *   6. docker    ghcr.io/<owner>/shopware-mcp:X.Y.Z and :latest for amd64 and arm64
 *   7. registry  the official MCP registry, once npm serves the version
 *
 * Tokens come from the environment: NPM_TOKEN, GITHUB_TOKEN (or GH_TOKEN) with contents
 * write and packages write. `--only npm,registry` runs some steps, `--dry-run` only says
 * what it would do.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STEPS = ["version", "verify", "git", "npm", "github", "docker", "registry"] as const;
type Step = (typeof STEPS)[number];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyArg = args.find((arg) => arg.startsWith("--only="))?.slice(7) ?? valueAfter("--only");
const only = onlyArg ? new Set(onlyArg.split(",")) : null;
const wanted = (step: Step) => !only || only.has(step);

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const root = new URL("..", import.meta.url).pathname;
const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const npmToken = process.env.NPM_TOKEN ?? "";

function run(command: string, commandArgs: string[], options: { input?: string } = {}): string {
  if (dryRun && !["git", "npm"].includes(command)) {
    console.log(`  (dry run) ${command} ${commandArgs.join(" ")}`);
    return "";
  }
  return execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio:
      options.input === undefined ? ["inherit", "pipe", "inherit"] : ["pipe", "pipe", "inherit"],
    input: options.input,
  }).trim();
}

/** Runs a command whose output the user should see as it happens. */
function live(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (dryRun) {
    const shown = commandArgs.map((arg) => (arg === githubToken && arg ? "<token>" : arg));
    console.log(`  (dry run) ${command} ${shown.join(" ")}`);
    return;
  }
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs[0] ?? ""} failed`);
}

const git = (...gitArgs: string[]) =>
  execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();

function packageVersion(): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string })
    .version;
}

function repository(): { owner: string; repo: string } {
  const url = git("remote", "get-url", "origin");
  const match = /github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/.exec(url);
  if (!match?.[1] || !match[2]) throw new Error(`origin is not a GitHub repository: ${url}`);
  return { owner: match[1], repo: match[2] };
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  if (!githubToken) throw new Error("GITHUB_TOKEN or GH_TOKEN is needed for this step");
  return fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

/** The CHANGELOG entry of one version, for the release notes. */
function changelogEntry(version: string): string {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf(`## ${version}\n`);
  if (start < 0) return `Release ${version}.`;
  const rest = changelog.slice(start + `## ${version}\n`.length);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function npmHas(version: string): boolean {
  const result = spawnSync("npm", ["view", `shopware-mcp@${version}`, "version"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

const header = (step: Step, text: string) => console.log(`\n▸ ${step}: ${text}`);

async function main(): Promise<void> {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new Error(`Release from main, not ${branch}`);
  if (git("status", "--porcelain")) throw new Error("The working tree is not clean");
  git("fetch", "--quiet", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    throw new Error("main and origin/main differ: pull or push first");
  }

  if (wanted("version")) {
    const pending = readdirSync(join(root, ".changeset")).filter(
      (file) => file.endsWith(".md") && file !== "README.md",
    );
    if (pending.length === 0) {
      header("version", `no pending changesets, releasing ${packageVersion()} as it is`);
    } else {
      header("version", `${pending.length} changeset(s)`);
      live("pnpm", ["-s", "release:version"]);
      const version = packageVersion();
      if (!dryRun) {
        git("add", "-A");
        git("commit", "--quiet", "-m", `chore: release ${version}`);
      }
      console.log(`  version ${version}`);
    }
  }
  const version = packageVersion();
  const tag = `v${version}`;

  if (wanted("verify")) {
    header("verify", "every check CI would run");
    live("bash", ["scripts/verify.sh"]);
  }

  if (wanted("git")) {
    const tagged =
      spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
        cwd: root,
      }).status === 0;
    header("git", tagged ? `${tag} exists` : `tag ${tag} and push`);
    if (!tagged && !dryRun) git("tag", "-a", tag, "-m", tag);
    live("git", ["push", "--quiet", "origin", "main", tag]);
  }

  if (wanted("npm")) {
    if (npmHas(version)) {
      header("npm", `shopware-mcp@${version} is published`);
    } else if (!npmToken) {
      header("npm", "skipped: set NPM_TOKEN (npmjs.com → Access Tokens → Granular, publish)");
    } else {
      header("npm", `publish ${version}`);
      const config = join(tmpdir(), `shopware-mcp-npmrc-${process.pid}`);
      // npm expands ${NPM_TOKEN} itself, so the token is never written to disk.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an npm placeholder, not JavaScript
      writeFileSync(config, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
      chmodSync(config, 0o600);
      try {
        live("pnpm", ["-s", "build"]);
        live("npm", ["publish", "--access", "public"], {
          ...process.env,
          NPM_CONFIG_USERCONFIG: config,
          NPM_CONFIG_PROVENANCE: "false",
        });
      } finally {
        rmSync(config, { force: true });
      }
    }
  }

  const { owner, repo } = repository();

  if (wanted("github")) {
    const existing = await github(`/repos/${owner}/${repo}/releases/tags/${tag}`);
    let release = existing.ok
      ? ((await existing.json()) as {
          id: number;
          upload_url: string;
          assets: Array<{ name: string }>;
        })
      : null;
    header("github", release ? `release ${tag} exists` : `create release ${tag}`);
    if (!release && !dryRun) {
      const created = await github(`/repos/${owner}/${repo}/releases`, {
        method: "POST",
        body: JSON.stringify({ tag_name: tag, name: tag, body: changelogEntry(version) }),
      });
      if (!created.ok) throw new Error(`creating the release failed: ${await created.text()}`);
      release = (await created.json()) as typeof release;
    }
    if (release && !release.assets.some((asset) => asset.name === "shopware-mcp.mcpb")) {
      console.log("  attach shopware-mcp.mcpb");
      live("pnpm", ["-s", "pack:mcpb"]);
      if (!dryRun) {
        const bundle = readFileSync(join(root, "shopware-mcp.mcpb"));
        const upload = await github(
          release.upload_url.replace(/\{.*\}$/, "?name=shopware-mcp.mcpb"),
          { method: "POST", body: bundle, headers: { "content-type": "application/zip" } },
        );
        if (!upload.ok) throw new Error(`uploading the bundle failed: ${await upload.text()}`);
        rmSync(join(root, "shopware-mcp.mcpb"), { force: true });
      }
    }
  }

  if (wanted("docker")) {
    const image = `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}`;
    header("docker", `${image}:${version} for amd64 and arm64`);
    if (githubToken) {
      run("docker", ["login", "ghcr.io", "-u", owner, "--password-stdin"], {
        input: process.env.GHCR_TOKEN ?? githubToken,
      });
    }
    // The default builder cannot push a multi-platform image; a container builder can.
    if (
      spawnSync("docker", ["buildx", "inspect", "shopware-mcp"], { stdio: "ignore" }).status !== 0
    ) {
      live("docker", [
        "buildx",
        "create",
        "--name",
        "shopware-mcp",
        "--driver",
        "docker-container",
      ]);
    }
    live("docker", [
      "buildx",
      "build",
      "--builder",
      "shopware-mcp",
      "--platform",
      "linux/amd64,linux/arm64",
      ...(process.env.NODE_IMAGE ? ["--build-arg", `NODE_IMAGE=${process.env.NODE_IMAGE}`] : []),
      "--tag",
      `${image}:${version}`,
      "--tag",
      `${image}:latest`,
      "--push",
      ".",
    ]);
  }

  if (wanted("registry")) {
    if (!npmHas(version)) {
      header("registry", `skipped: npm does not serve ${version} yet, and the registry checks it`);
    } else {
      header("registry", `publish server.json ${version}`);
      const bin = join(root, "node_modules", ".cache", "mcp-publisher");
      mkdirSync(bin, { recursive: true });
      const publisher = join(bin, "mcp-publisher");
      if (!existsSync(publisher)) {
        const arch = process.arch === "arm64" ? "arm64" : "amd64";
        const platform = process.platform === "darwin" ? "darwin" : "linux";
        const url = `https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${platform}_${arch}.tar.gz`;
        live("bash", ["-c", `curl -fsSL "${url}" | tar xz -C "${bin}" mcp-publisher`]);
      }
      live(publisher, ["login", "github", "-token", githubToken]);
      live(publisher, ["publish"]);
    }
  }

  console.log(`\n✓ ${tag} done`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
