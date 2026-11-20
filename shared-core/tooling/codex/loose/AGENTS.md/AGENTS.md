

## Global code graph routing and concise replies

- Use GitNexus as the default graph for code navigation, architecture, call paths, and impact when the current repository is indexed. If multiple repos are registered, identify the current repo and pass its exact name; never answer from another repo's graph. Check freshness and verify consequential claims against source.
- Check GitNexus impact before editing indexed symbols. If the current repo is not indexed, use targeted source search; do not index it unless asked.
- Use Graphify only when the user asks for it, or an existing current-repo Graphify graph is useful for cross-document or multimodal relationships. Do not invoke it for routine code navigation or as a default for every code question. Never query another repo's graph by default.
- CodeGraph is an optional local structural cross-check when GitNexus lacks needed detail. Avoid querying both structural graphs for the same question unless results conflict or coverage differs.
- Default to Caveman full style for replies: remove filler and keep answers compact while preserving technical meaning, identifiers, numbers, paths, and errors. Use clear full prose for safety-sensitive or ambiguous steps, and follow an explicit user request for another style. Keep persisted artifacts in normal prose.
- For independent, read-only command or tool checks, use the `batch-independent-readonly-checks` skill. Keep dependent operations serial and inspect every result.

