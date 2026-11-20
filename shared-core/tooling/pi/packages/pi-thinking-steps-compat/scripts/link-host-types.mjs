// Dev-only: link the *running* Pi host's packages into ./node_modules so `tsc --noEmit`
// type-checks this fork against the host it will actually run inside.
//
// Runtime does not need these links: Pi loads extensions through jiti with aliases that
// already point at the host's own module graph. These symlinks exist only for type-checking,
// and they must track the live install — a pinned copy is how the boolean/getter drift slipped
// past upstream (its devDependencies pin @earendil-works/* 0.99.2).
//
//   node scripts/link-host-types.mjs            # link (idempotent)
//   node scripts/link-host-types.mjs --print     # print the resolved host path only

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, rmSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const printOnly = process.argv.includes("--print");

function findHostPackageDir() {
	const override = process.env.PI_TEST_HOST_PACKAGE ?? process.env.PI_PACKAGE_DIR;
	if (override) return resolve(override);

	const binaryCandidates = [];
	try {
		binaryCandidates.push(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
	} catch {
		// `pi` not on PATH; fall through to known install roots.
	}

	// Walk up from the resolved launcher (…/@earendil-works/pi-coding-agent/dist/bundle/cli.js)
	// until a package.json names the host package. Launcher wrappers may be shell scripts, so
	// also harvest absolute paths from them.
	const seen = new Set();
	const queue = binaryCandidates.flatMap((entry) => {
		const paths = [entry];
		try {
			const text = readFileSync(entry, "utf8");
			for (const match of text.matchAll(/(\/[^\s"']+)+/g)) paths.push(match[0]);
		} catch {
			/* binary or unreadable; the entry itself is enough */
		}
		// Wrapper scripts point at launcher symlinks (e.g. libexec/bin/pi -> the real bundle
		// entry), so resolve each candidate before walking up for the manifest.
		return paths.map((entry2) => safeRealpath(entry2) ?? entry2);
	});

	for (const start of queue) {
		let dir = dirname(start);
		while (dir !== "/" && !seen.has(dir)) {
			seen.add(dir);
			const manifest = join(dir, "package.json");
			if (existsSync(manifest)) {
				try {
					if (JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
				} catch {
					/* unreadable manifest */
				}
			}
			dir = dirname(dir);
		}
	}

	for (const root of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules", execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()]) {
		const candidate = join(root, "@earendil-works/pi-coding-agent");
		if (existsSync(join(candidate, "dist/index.js"))) return realpathSync(candidate);
	}

	throw new Error("Could not locate the installed @earendil-works/pi-coding-agent. Set PI_TEST_HOST_PACKAGE=<path>.");
}

const hostDir = findHostPackageDir();
const hostVersion = JSON.parse(readFileSync(join(hostDir, "package.json"), "utf8")).version;
if (printOnly) {
	console.log(`${hostDir} (${hostVersion})`);
	process.exit(0);
}

const nested = join(hostDir, "node_modules/@earendil-works");
const links = {
	"pi-coding-agent": hostDir,
	"pi-tui": join(nested, "pi-tui"),
	"pi-ai": join(nested, "pi-ai"),
	"pi-agent-core": join(nested, "pi-agent-core"),
};

const targetRoot = join(packageRoot, "node_modules/@earendil-works");
mkdirSync(targetRoot, { recursive: true });
let changed = 0;
for (const [name, target] of Object.entries(links)) {
	if (!existsSync(target)) {
		console.log(`skip @earendil-works/${name}: not present in host`);
		continue;
	}
	const link = join(targetRoot, name);
	if (safeLstat(link)) {
		let current;
		try {
			current = readlinkSync(link, { encoding: "utf8" });
		} catch {
			current = undefined; // a real directory, not our link: replace it
		}
		if (current === target) continue;
		rmSync(link, { recursive: true, force: true });
	}
	symlinkSync(target, link, "dir");
	changed += 1;
	console.log(`linked @earendil-works/${name} -> ${target}`);
}

const typesNode = [
	join(process.env.HOME ?? "", ".pi/agent/npm/node_modules/@types/node"),
	join(hostDir, "node_modules/@types/node"),
].find((candidate) => existsSync(join(candidate, "package.json")));
if (typesNode) {
	const link = join(packageRoot, "node_modules/@types/node");
	if (!safeLstat(link)) {
		mkdirSync(join(packageRoot, "node_modules/@types"), { recursive: true });
		symlinkSync(typesNode, link, "dir");
		changed += 1;
		console.log(`linked @types/node -> ${typesNode}`);
	}
}

console.log(changed === 0 ? `Up to date against host ${hostVersion}.` : `Linked against host ${hostVersion}. Run: npm run build`);

function safeLstat(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function safeRealpath(path) {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}
