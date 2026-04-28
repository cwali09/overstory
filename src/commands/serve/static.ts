/**
 * Static-file serving with path-traversal guard for `ov serve`.
 *
 * Extracted from serve.ts so the path-traversal check can be tested in isolation.
 */

import type { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { apiError } from "../../json.ts";

/**
 * Serve a static file from uiDistPath, falling back to index.html for SPA routes.
 * Rejects requests that escape uiDistPath with a 403 JSON envelope.
 * Returns a 503 JSON envelope when ui/dist is missing.
 */
export async function serveStatic(
	path: string,
	uiDistPath: string,
	_exists: typeof existsSync,
): Promise<Response> {
	if (!_exists(uiDistPath)) {
		return apiError("UI not built — run the UI build first", 503);
	}

	// Normalise path: strip leading slash, default to index.html
	const stripped = path.replace(/^\//, "") || "index.html";

	const uiRoot = resolve(uiDistPath);
	const filePath = resolve(uiRoot, stripped);

	// Path-traversal guard: resolved path must stay inside uiRoot
	if (filePath !== uiRoot && !filePath.startsWith(uiRoot + sep)) {
		return apiError("Forbidden", 403);
	}

	const file = Bun.file(filePath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback: any unknown path → index.html
	const indexPath = resolve(uiRoot, "index.html");
	const indexFile = Bun.file(indexPath);
	if (await indexFile.exists()) {
		return new Response(indexFile, {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	return new Response("Not found", { status: 404 });
}
