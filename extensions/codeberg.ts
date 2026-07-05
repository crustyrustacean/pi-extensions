/**
 * Codeberg Extension
 *
 * Tools for the Codeberg (Forgejo) API: create and list repositories under
 * the authenticated user. The token is read from a file (or env) at runtime —
 * it is never shipped with the extension — so this code syncs across machines
 * via git without leaking secrets. Each machine provides its own token.
 *
 * Configuration (environment variables, all optional with sensible defaults):
 *   CODEBERG_TOKEN       - token value (overrides the file)
 *   CODEBERG_TOKEN_FILE  - path to a token file (default: ~/.config/codeberg/token)
 *   CODEBERG_API         - API base URL (default: https://codeberg.org/api/v1)
 *                          set this to point at a self-hosted Forgejo instance
 *
 * Required token scopes (https://codeberg.org/user/settings/applications):
 *   - create repos (POST /user/repos):  write:user   (Forgejo gates this here,
 *                                                       not under write:repository)
 *   - list/edit existing repos:         read:repository / write:repository
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const DEFAULT_API = "https://codeberg.org/api/v1";
const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "codeberg", "token");

function apiBase(): string {
	return process.env.CODEBERG_API || DEFAULT_API;
}

/**
 * Resolve the token from env or the configured file. Throws a helpful error
 * (not the raw value) when missing so the LLM can tell the user exactly what
 * to do.
 */
function getToken(): string {
	if (process.env.CODEBERG_TOKEN) return process.env.CODEBERG_TOKEN;
	const file = process.env.CODEBERG_TOKEN_FILE || DEFAULT_TOKEN_FILE;
	try {
		const raw = readFileSync(file, "utf8").trim();
		if (!raw) throw new Error("empty");
		return raw;
	} catch {
		throw new Error(
			`Codeberg token not found. Set CODEBERG_TOKEN, or write a token to ${file} (chmod 600). ` +
				`Generate one at https://codeberg.org/user/settings/applications with scopes: ` +
				`write:user (to create repos), read:repository, write:repository.`,
		);
	}
}

interface CodebergRepo {
	name: string;
	full_name: string;
	description: string;
	private: boolean;
	html_url: string;
	ssh_url: string;
	clone_url: string;
	default_branch: string;
	owner: { login: string };
}

/**
 * Perform a Forgejo API request with the resolved token. Non-2xx responses
 * throw carrying the API message; 204 / empty body resolves to undefined.
 */
async function codebergRequest<T>(
	ctx: ExtensionContext,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const url = `${apiBase()}${path}`;
	const token = getToken();
	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers: {
				Authorization: `token ${token}`,
				"Content-Type": "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: ctx.signal,
		});
	} catch (error: any) {
		if (error.name === "AbortError") throw new Error("Request cancelled");
		throw new Error(`Codeberg request failed: ${error.message}`);
	}

	const text = await response.text();
	if (!response.ok) {
		let detail = text;
		try {
			detail = JSON.parse(text).message || text;
		} catch {
			/* keep raw text */
		}
		throw new Error(`Codeberg API ${response.status}: ${detail}`);
	}
	if (response.status === 204 || text.length === 0) return undefined as T;
	return JSON.parse(text) as T;
}

// --- Tools -----------------------------------------------------------------

const codebergCreateRepoTool = defineTool({
	name: "codeberg_create_repo",
	label: "Codeberg Create Repo",
	description:
		"Create a new repository on Codeberg under the authenticated user. " +
		"Returns the new repo's SSH URL, web URL, and default branch. " +
		"Requires a token with write:user scope. " +
		"Default is private with no auto-init so an existing local commit becomes the initial commit.",
	promptSnippet: "Create a new private Codeberg repository and get its SSH URL",
	promptGuidelines: [
		"Use codeberg_create_repo when the user wants a new project hosted on Codeberg.",
		"Default is private and no auto-init; after creating, add the returned ssh_url as 'origin' and push.",
		"If a local git repo already has commits, keep auto_init false to avoid a conflicting initial commit on the remote.",
	],
	parameters: Type.Object({
		name: Type.String({ description: "Repository name (lowercase letters, digits, hyphens, periods; no spaces)" }),
		description: Type.Optional(Type.String({ description: "Short repo description" })),
		private: Type.Optional(Type.Boolean({ description: "Private repo (default: true)" })),
		auto_init: Type.Optional(
			Type.Boolean({ description: "Initialize with an empty README on the remote (default: false)" }),
		),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: `Creating Codeberg repo: ${params.name}` }] });
		const repo = await codebergRequest<CodebergRepo>(ctx, "POST", "/user/repos", {
			name: params.name,
			description: params.description ?? "",
			private: params.private ?? true,
			auto_init: params.auto_init ?? false,
		});
		return {
			content: [
				{
					type: "text",
					text: [
						`Created **${repo.full_name}** (${repo.private ? "private" : "public"})`,
						``,
						`Web:  ${repo.html_url}`,
						`SSH:  ${repo.ssh_url}`,
						``,
						`To push an existing local repo:`,
						`  git remote add origin ${repo.ssh_url}`,
						`  git push -u origin main`,
					].join("\n"),
				},
			],
			details: {
				name: repo.name,
				full_name: repo.full_name,
				html_url: repo.html_url,
				ssh_url: repo.ssh_url,
				private: repo.private,
				default_branch: repo.default_branch,
			},
		};
	},
});

const codebergListReposTool = defineTool({
	name: "codeberg_list_repos",
	label: "Codeberg List Repos",
	description:
		"List repositories owned by the authenticated Codeberg user, with SSH clone URLs. " +
		"Use before creating a repo to check for name collisions, or to discover an existing repo's SSH URL.",
	parameters: Type.Object({
		limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 30)" })),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const limit = params.limit ?? 30;
		const repos = await codebergRequest<CodebergRepo[]>(ctx, "GET", `/user/repos?limit=${limit}`);
		const lines = repos.map(
			(r) => `- **${r.full_name}** ${r.private ? "(private)" : "(public)"} — ${r.ssh_url}`,
		);
		return {
			content: [
				{
					type: "text",
					text: `${repos.length} repo(s):\n${lines.join("\n")}`,
				},
			],
			details: {
				count: repos.length,
				repos: repos.map((r) => ({ name: r.full_name, ssh_url: r.ssh_url, private: r.private })),
			},
		};
	},
});

// --- Registration ----------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(codebergCreateRepoTool);
	pi.registerTool(codebergListReposTool);

	// Surface a warning on session start if the token isn't readable, so the
	// user finds out proactively rather than on the first failed tool call.
	pi.on("session_start", async (_event, ctx) => {
		try {
			getToken();
		} catch (e: any) {
			ctx.ui.notify(`Codeberg: ${e.message}`, "warning");
		}
	});
}
