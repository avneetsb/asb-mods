// Pure logic for the tool-surface-gate package: no pi imports, so it is unit-testable.
//
// Idea: some tools cost prompt tokens without ever being used. On a fresh session we
// "park" them (remove from the active set) and wake them on demand through `tools_wake`.
// Parking must never fight an already-running conversation, so anything the transcript
// already declared stays active.

/** Names the transcript explicitly added (and not later removed). null = no records at all. */
export function declaredFromBranch(branch) {
	let set = null;
	for (const entry of branch ?? []) {
		const message = entry?.message ?? entry;
		if (!message || message.role !== "system") continue;
		const added = message.toolsAdded;
		const removed = message.toolsRemoved;
		if (!added && !removed) continue;
		set ??= new Set();
		for (const tool of removed ?? []) {
			const name = typeof tool === "string" ? tool : tool?.name;
			if (name) set.delete(name);
		}
		for (const tool of added ?? []) {
			const name = typeof tool === "string" ? tool : tool?.name;
			if (name) set.add(name);
		}
	}
	return set;
}

/**
 * Decide the next active tool set.
 *
 * @param {object} state
 * @param {string[]} state.registered  every registered tool name (pi.getAllTools())
 * @param {string[]} state.active      currently active tool names (pi.getActiveTools())
 * @param {Iterable<string>} state.familyTools  every tool the gate may park
 * @param {Iterable<string>} [state.keep]       never park these (policy-mandated tools)
 * @param {Set<string>|null} [state.declared]   from declaredFromBranch(); null = no tool-change records
 * @param {boolean} [state.branchHasContent]    transcript already has messages
 * @param {string} state.loaderName             the wake tool itself, always kept
 * @returns {{ next: string[], parked: string[], reason: string }}
 */
export function computeNextActive(state) {
	const { active = [], registered = [], familyTools = [], keep = [], declared = null, branchHasContent = false, loaderName } = state;
	const registrable = new Set(registered);
	const protectedNames = new Set([...keep, loaderName]);
	const candidates = [...new Set(familyTools)].filter(
		(name) => name !== loaderName && !protectedNames.has(name) && registrable.has(name),
	);

	// A conversation that is already under way without any tool-change records was built
	// with these tools in its prompt; yanking them mid-prefix buys nothing and can break
	// providers that replay tool history. Leave it alone.
	const armed = declared ?? (branchHasContent ? new Set(candidates) : new Set());

	const parked = [];
	const next = [];
	for (const name of active) {
		const shouldPark = candidates.includes(name) && !armed.has(name);
		if (shouldPark) parked.push(name);
		else next.push(name);
	}
	if (loaderName && registrable.has(loaderName) && !next.includes(loaderName)) next.push(loaderName);

	let reason = "nothing-to-park";
	if (declared) reason = "transcript-declared";
	else if (branchHasContent) reason = "session-in-progress";
	else if (parked.length) reason = "parked-fresh-session";
	return { next, parked, reason };
}
