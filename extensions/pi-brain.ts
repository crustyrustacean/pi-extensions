/**
 * Pi Brain Extension
 *
 * Provides tools for interacting with the local pi-brain knowledge base service.
 * The pi-brain should be running on http://localhost:8080
 *
 * NOTE: As of pi-brain v1.0.0 the API uses plain HTTP — status codes carry
 * success/error and response bodies are the resource itself (no
 * `{success, data, error}` envelope). DELETE returns 204 with no body.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Configuration
const KB_BASE_URL = "http://localhost:8080";
const KB_API_BASE = `${KB_BASE_URL}/pb`;

// --- Domain types (mirror pi-brain's `domain` crate) -----------------------

interface Document {
	id: string;
	title: string;
	content: string;
	content_hash: string;
	tags: string[];
	metadata: any;
	created_at: string;
	updated_at: string;
}

interface SearchResult {
	relevance_score: number;
	document: Document;
	excerpt: string;
}

interface SearchResponse {
	results: SearchResult[];
	total_count: number;
	search_time_ms: number;
	query: string;
}

interface DocumentListResponse {
	documents: Document[];
	total: number;
	limit: number;
	offset: number;
}

interface StatsResponse {
	total_documents: number;
	total_links: number;
	unique_tags: number;
	database_size_bytes: number;
	last_updated: string;
}

// --- HTTP helper -----------------------------------------------------------

/**
 * Perform an HTTP request against the pi-brain API and return the parsed
 * JSON body. A non-2xx status throws (carrying the response body as the
 * message); an empty body (e.g. 204 No Content) resolves to `undefined`.
 */
async function kbRequest<T>(
	ctx: ExtensionContext,
	method: string,
	path: string,
	body?: unknown,
): Promise<T | undefined> {
	const url = `${KB_API_BASE}${path}`;

	try {
		const response = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: ctx.signal,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			throw new Error(`Pi brain request failed: ${response.status} ${errorText}`);
		}

		// 204 No Content (and any empty body) has nothing to parse.
		if (response.status === 204) {
			return undefined;
		}
		const text = await response.text();
		if (text.length === 0) {
			return undefined;
		}
		return JSON.parse(text) as T;
	} catch (error: any) {
		if (error.name === 'AbortError') {
			throw new Error('Request cancelled');
		}
		if (error.message?.includes('ECONNREFUSED')) {
			throw new Error('Pi brain service not running. Start it with: systemctl --user start pi-brain');
		}
		throw error;
	}
}

// --- Tools -----------------------------------------------------------------

const kbSearchTool = defineTool({
	name: "kb_search",
	label: "KB Search",
	description: "Search the pi-brain knowledge base for documents matching a query",
	promptSnippet: "Search pi-brain by query and optional tags",
	promptGuidelines: [
		"Use kb_search when you need to find information stored in the pi-brain knowledge base.",
		"Use the query parameter for full-text search and tags parameter to filter by tags.",
		"The results include relevance scores and excerpts for context.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search query for full-text search" }),
		tags: Type.Optional(Type.Array(Type.String({ description: "Tags to filter by" }))),
		limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 20)" })),
		offset: Type.Optional(Type.Number({ description: "Number of results to skip (default: 0)" })),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: `Searching pi-brain for: ${params.query}` }] });

		const response = await kbRequest<SearchResponse>(
			ctx,
			'POST',
			'/search',
			{
				query: params.query,
				tags: params.tags,
				limit: params.limit || 20,
				offset: params.offset || 0,
			},
		);

		const { results, total_count, search_time_ms } = response ?? {
			results: [], total_count: 0, search_time_ms: 0,
		};

		// Format results as readable text
		let resultText = `Found ${total_count} result(s) in ${search_time_ms}ms:\n\n`;

		for (const result of results) {
			const { document, excerpt, relevance_score } = result;
			resultText += `## ${document.title}\n`;
			resultText += `**ID:** ${document.id}\n`;
			resultText += `**Relevance:** ${relevance_score.toFixed(2)}\n`;
			resultText += `**Tags:** ${document.tags.join(', ') || 'none'}\n`;
			resultText += `**Last Updated:** ${document.updated_at}\n`;
			resultText += `**Excerpt:** ${excerpt}\n`;
			resultText += `**Content:** ${document.content.substring(0, 200)}${document.content.length > 200 ? '...' : ''}\n\n`;
		}

		return {
			content: [{ type: "text", text: resultText }],
			details: { total_count, search_time_ms },
		};
	},
});

const kbCreateTool = defineTool({
	name: "kb_create",
	label: "KB Create",
	description: "Create a new document in the pi-brain knowledge base",
	promptSnippet: "Create a new pi-brain document",
	promptGuidelines: [
		"Use kb_create to store important information for future reference.",
		"Provide a clear title and detailed content for better searchability.",
		"Use tags to organize and categorize documents.",
		"Metadata can store structured data (JSON) for programmatic access.",
	],
	parameters: Type.Object({
		title: Type.String({ description: "Document title" }),
		content: Type.String({ description: "Document content" }),
		tags: Type.Optional(Type.Array(Type.String({ description: "Tags for organization" }))),
		metadata: Type.Optional(Type.Object({}, { description: "Additional metadata as JSON object" })),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: `Creating document: ${params.title}` }] });

		const document = await kbRequest<Document>(
			ctx,
			'POST',
			'/documents',
			{
				title: params.title,
				content: params.content,
				tags: params.tags || [],
				metadata: params.metadata || null,
			},
		);

		if (!document) {
			throw new Error('Document creation returned no body');
		}

		return {
			content: [{
				type: "text",
				text: `Document created successfully!\n\n**ID:** ${document.id}\n**Title:** ${document.title}\n**Tags:** ${document.tags.join(', ') || 'none'}\n**Created:** ${document.created_at}`,
			}],
			details: { document_id: document.id },
		};
	},
});

const kbGetTool = defineTool({
	name: "kb_get",
	label: "KB Get",
	description: "Retrieve a specific document from the pi-brain knowledge base",
	promptSnippet: "Get a document by ID",
	promptGuidelines: [
		"Use kb_get to retrieve the full content of a specific document.",
		"Document IDs are returned by kb_search and kb_list tools.",
	],
	parameters: Type.Object({
		id: Type.String({ description: "Document ID (UUID)" }),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: `Retrieving document: ${params.id}` }] });

		const document = await kbRequest<Document>(ctx, 'GET', `/documents/${params.id}`);

		if (!document) {
			throw new Error('Document retrieval returned no body');
		}

		let resultText = `## ${document.title}\n`;
		resultText += `**ID:** ${document.id}\n`;
		resultText += `**Tags:** ${document.tags.join(', ') || 'none'}\n`;
		resultText += `**Created:** ${document.created_at}\n`;
		resultText += `**Updated:** ${document.updated_at}\n`;
		resultText += `**Content Hash:** ${document.content_hash}\n`;

		if (document.metadata && Object.keys(document.metadata).length > 0) {
			resultText += `**Metadata:** ${JSON.stringify(document.metadata, null, 2)}\n`;
		}

		resultText += `\n### Content\n${document.content}`;

		return {
			content: [{ type: "text", text: resultText }],
			details: { document_id: document.id },
		};
	},
});

const kbListTool = defineTool({
	name: "kb_list",
	label: "KB List",
	description: "List all documents in the pi-brain knowledge base with pagination",
	promptSnippet: "List all pi-brain documents",
	promptGuidelines: [
		"Use kb_list to browse all documents in the pi-brain knowledge base.",
		"Use pagination to navigate large document collections.",
	],
	parameters: Type.Object({
		limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 50)" })),
		offset: Type.Optional(Type.Number({ description: "Number of results to skip (default: 0)" })),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: "Listing documents..." }] });

		const response = await kbRequest<DocumentListResponse>(
			ctx,
			'GET',
			`/documents?limit=${params.limit || 50}&offset=${params.offset || 0}`,
		);

		const { documents, total, limit, offset } = response ?? {
			documents: [], total: 0, limit: params.limit || 50, offset: params.offset || 0,
		};

		let resultText = `Documents ${offset + 1}-${Math.min(offset + limit, total)} of ${total}:\n\n`;

		for (const doc of documents) {
			resultText += `### ${doc.title}\n`;
			resultText += `- **ID:** ${doc.id}\n`;
			resultText += `- **Tags:** ${doc.tags.join(', ') || 'none'}\n`;
			resultText += `- **Updated:** ${doc.updated_at}\n\n`;
		}

		return {
			content: [{ type: "text", text: resultText }],
			details: { total, limit, offset },
		};
	},
});

const kbStatsTool = defineTool({
	name: "kb_stats",
	label: "KB Stats",
	description: "Get statistics about the pi-brain knowledge base",
	promptSnippet: "Get pi-brain statistics",
	promptGuidelines: [
		"Use kb_stats to understand the current state and size of the pi-brain knowledge base.",
	],
	parameters: Type.Object({}),

	async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: "Getting statistics..." }] });

		const stats = await kbRequest<StatsResponse>(ctx, 'GET', '/stats');

		if (!stats) {
			throw new Error('Statistics retrieval returned no body');
		}

		const sizeMB = (stats.database_size_bytes / (1024 * 1024)).toFixed(2);

		const resultText = `## Pi Brain Statistics\n\n` +
			`- **Total Documents:** ${stats.total_documents}\n` +
			`- **Total Links:** ${stats.total_links}\n` +
			`- **Unique Tags:** ${stats.unique_tags}\n` +
			`- **Database Size:** ${sizeMB} MB (${stats.database_size_bytes} bytes)\n` +
			`- **Last Updated:** ${stats.last_updated}`;

		return {
			content: [{ type: "text", text: resultText }],
			details: stats,
		};
	},
});

const kbUpdateTool = defineTool({
	name: "kb_update",
	label: "KB Update",
	description: "Update an existing document in the pi-brain knowledge base",
	promptSnippet: "Update an existing pi-brain document",
	promptGuidelines: [
		"Use kb_update to modify existing documents.",
		"Only provide fields that should be changed; others remain unchanged.",
		"All parameters are optional except the document ID.",
	],
	parameters: Type.Object({
		id: Type.String({ description: "Document ID (UUID)" }),
		title: Type.Optional(Type.String({ description: "New title" })),
		content: Type.Optional(Type.String({ description: "New content" })),
		tags: Type.Optional(Type.Array(Type.String({ description: "New tags" }))),
		metadata: Type.Optional(Type.Object({}, { description: "New metadata as JSON object" })),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: `Updating document: ${params.id}` }] });

		// Only send fields that were actually provided so unspecified fields
		// are left unchanged by the partial-update endpoint.
		const body: Record<string, unknown> = {};
		if (params.title !== undefined) body.title = params.title;
		if (params.content !== undefined) body.content = params.content;
		if (params.tags !== undefined) body.tags = params.tags;
		if (params.metadata !== undefined) body.metadata = params.metadata;

		const document = await kbRequest<Document>(ctx, 'PUT', `/documents/${params.id}`, body);

		if (!document) {
			throw new Error('Document update returned no body');
		}

		return {
			content: [{
				type: "text",
				text: `Document updated successfully!\n\n**ID:** ${document.id}\n**Title:** ${document.title}\n**Tags:** ${document.tags.join(', ') || 'none'}\n**Updated:** ${document.updated_at}`,
			}],
			details: { document_id: document.id },
		};
	},
});

const kbDeleteTool = defineTool({
	name: "kb_delete",
	label: "KB Delete",
	description: "Delete (soft delete) a document from the pi-brain knowledge base",
	promptSnippet: "Delete a pi-brain document",
	promptGuidelines: [
		"Use kb_delete to remove documents (soft delete - can be restored).",
		"Deleted documents are not returned in search results but remain in the database.",
	],
	parameters: Type.Object({
		id: Type.String({ description: "Document ID (UUID)" }),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: `Deleting document: ${params.id}` }] });

		// DELETE returns 204 No Content; kbRequest resolves to undefined on success.
		await kbRequest<void>(ctx, 'DELETE', `/documents/${params.id}`);

		return {
			content: [{
				type: "text",
				text: `Document deleted successfully!\n\n**ID:** ${params.id}`,
			}],
			details: { document_id: params.id },
		};
	},
});

// Register the extension
export default function (pi: ExtensionAPI) {
	// Register all tools
	pi.registerTool(kbSearchTool);
	pi.registerTool(kbCreateTool);
	pi.registerTool(kbGetTool);
	pi.registerTool(kbListTool);
	pi.registerTool(kbStatsTool);
	pi.registerTool(kbUpdateTool);
	pi.registerTool(kbDeleteTool);

	// Notify on load
	pi.on("session_start", async (_event, ctx) => {
		try {
			// Check if KB is running
			await kbRequest(ctx, 'GET', '/stats');
			ctx.ui.notify('Pi brain connected', 'success');
			ctx.ui.setStatus('kb', 'Connected');
		} catch (error) {
			ctx.ui.notify('Pi brain not available', 'warning');
			ctx.ui.setStatus('kb', 'Disconnected');
		}
	});
}
