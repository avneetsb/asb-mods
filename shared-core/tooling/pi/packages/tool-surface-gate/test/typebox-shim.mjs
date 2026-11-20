// Test-only resolution shim. Under pi, `import { Type } from "typebox"` inside an extension is
// satisfied by jiti aliases that pi injects (verified: dist/core/extensions/loader.js resolves
// `typebox`, `typebox/compile`, `typebox/value` and passes them as jiti aliases). Bare `node
// --test` has no such alias, so we link pi's own copy of the package into this package's
// node_modules before importing the extension. No upstream file is touched — the link points at
// pi's installed dependency read-only.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SHIM = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "node_modules", "typebox");

function candidatePiDirs() {
	const roots = [
		"/opt/homebrew/Cellar/pi-coding-agent/*/libexec/lib/node_modules/@earendil-works/pi-coding-agent",
		path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent"),
		path.join(os.homedir(), "Library/pnpm/global/5/node_modules/@earendil-works/pi-coding-agent"),
	];
	const found = [];
	for (const pattern of roots) {
		for (const dir of globSync(pattern)) found.push(dir);
	}
	// `npm root -g` covers non-Homebrew installs.
	try {
		const npmRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (npmRoot) found.push(path.join(npmRoot, "@earendil-works/pi-coding-agent"));
	} catch {
		/* npm not on PATH — other candidates still apply */
	}
	return found.filter((dir) => existsSync(dir));
}

/** Resolve pi's copy of typebox; returns the package dir, or null when pi is not installed. */
export function resolvePiTypebox() {
	for (const piDir of candidatePiDirs()) {
		try {
			const req = createRequire(path.join(piDir, "index.js"));
			const entry = req.resolve("typebox");
			let dir = path.dirname(entry);
			// Walk up to the package root (typebox may resolve to dist/index.js or similar).
			for (let i = 0; i < 5 && !existsSync(path.join(dir, "package.json")); i += 1) dir = path.dirname(dir);
			if (existsSync(path.join(dir, "package.json"))) return dir;
		} catch {
			/* typebox not under this candidate */
		}
	}
	return null;
}

/** Link pi's typebox into ./node_modules/typebox. Idempotent; safe to call every run. */
export function ensureTypeboxShim() {
	const target = resolvePiTypebox();
	if (!target) return null;
	// Already linked (or a real copy): nothing to do. This is the steady state.
	if (existsSync(path.join(SHIM, "package.json"))) return target;
	const parent = path.dirname(SHIM);
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	try {
		rmSync(SHIM, { recursive: true, force: true });
	} catch {
		/* dangling entry we could not remove; symlink attempt below decides */
	}
	try {
		symlinkSync(target, SHIM, "dir");
	} catch (err) {
		// Parallel test workers can race on this; whoever lost finds a usable package.
		if (!existsSync(path.join(SHIM, "package.json"))) throw err;
	}
	return target;
}

export const shimPath = SHIM;
