/**
 * Web Fetch Extension
 *
 * Provides a `web_fetch` tool that fetches URLs and returns the content
 * as readable text. Handles HTML pages (strips tags), JSON, and plain text.
 *
 * Usage:
 *   - The LLM can call web_fetch automatically when it needs to fetch a URL
 *   - Users can use /web-fetch <url> to fetch from the command line
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_CHARS = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|nav|header|footer|aside|details|summary)>/gi, "\n")
    .replace(/<\/?(li|td|th|dt|dd)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#\d+;/g, (m) => String.fromCharCode(Number(m.slice(2, -1))))
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

function isHtml(contentType: string | null, body: string): boolean {
  if (contentType?.includes("text/html")) return true;
  const trimmed = body.trimStart();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML");
}

function isJson(contentType: string | null): boolean {
  return contentType?.includes("application/json") || contentType?.includes("application/ld+json") || false;
}

function formatJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return its content as readable text. Supports HTML pages, JSON APIs, and plain text. " +
      "Automatically strips HTML tags from web pages and formats JSON responses.",
    promptSnippet: "Fetch content from a URL (HTML, JSON, or plain text)",
    promptGuidelines: [
      "Use web_fetch to read web pages, documentation, or API responses.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch (must include protocol, e.g., https://example.com)" }),
      maxLength: Type.Optional(Type.Number({ description: "Maximum chars to return (default: 100000)" })),
      format: Type.Optional(Type.String({ description: "Output format: 'text' (default), 'raw', 'metadata'" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const url = params.url.trim();
      const maxLength = params.maxLength ?? DEFAULT_MAX_CHARS;
      const format = params.format ?? "text";

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return { content: [{ type: "text", text: `Error: Unsupported protocol "${parsedUrl.protocol}". Only http: and https: are supported.` }], isError: true };
        }
      } catch {
        return { content: [{ type: "text", text: `Error: Invalid URL "${url}". Include the protocol (e.g., https://example.com).` }], isError: true };
      }

      let response: Response;
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        const abortSignal = signal ? combineSignals(signal, ctrl.signal) : ctrl.signal;
        response = await fetch(url, {
          signal: abortSignal,
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept: "text/html,application/json,text/plain,*/*",
          },
          redirect: "follow",
        });
        clearTimeout(tid);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          return { content: [{ type: "text", text: `Error: Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s or was aborted.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Error fetching URL: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      let body: string;
      try {
        const contentLength = response.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
          return { content: [{ type: "text", text: `Error: Content too large (${Number(contentLength).toLocaleString()} bytes).` }], isError: true };
        }
        const ct = response.headers.get("content-type") || "";
        if (ct && !/text\/|application\/json|application\/ld\+json|application\/xml|application\/xhtml/.test(ct)) {
          return { content: [{ type: "text", text: `Skipped binary content (${ct}).` }], isError: true };
        }
        const buf = await response.arrayBuffer();
        if (buf.byteLength > MAX_RESPONSE_BYTES) {
          return { content: [{ type: "text", text: `Error: Response too large (${buf.byteLength.toLocaleString()} bytes).` }], isError: true };
        }
        body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error reading response: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      const statusCode = response.status;
      const contentType = response.headers.get("content-type") || "unknown";
      const bodySize = body.length;
      const truncated = bodySize > maxLength;

      let text: string;
      if (format === "metadata") {
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => { headers[k] = v; });
        text = [
          `URL: ${url}`,
          `Status: ${statusCode} ${response.statusText}`,
          `Content-Type: ${contentType}`,
          `Content-Length: ${bodySize.toLocaleString()} chars`,
          "",
          "Headers:",
          ...Object.entries(headers).filter(([k]) => !["set-cookie", "cookie"].includes(k.toLowerCase())).map(([k, v]) => `  ${k}: ${v}`),
        ].join("\n");
      } else if (format === "raw") {
        text = body;
      } else {
        text = isHtml(contentType, body) ? htmlToText(body) : isJson(contentType) ? formatJson(body) : body;
      }
      if (truncated) text = text.slice(0, maxLength);

      const result = [
        `> **URL**: ${url}`,
        `> **Status**: ${statusCode} ${response.statusText}`,
        `> **Content-Type**: ${contentType}`,
        `> **Size**: ${bodySize.toLocaleString()} chars`,
        ...(truncated ? [`> **Note**: Truncated to ${maxLength.toLocaleString()} chars.`] : []),
        "",
        text,
      ].join("\n");

      return { content: [{ type: "text", text: result }], details: { url, statusCode, contentType, bodySize, truncated } };
    },

    renderCall(args, theme, context) {
      const urlText = args.url.length > 80 ? args.url.slice(0, 77) + "..." : args.url;
      let text = theme.fg("toolTitle", "web_fetch ") + theme.fg("link", urlText);
      if (args.format && args.format !== "text") text += " " + theme.fg("dim", `[${args.format}]`);
      const component = context.lastComponent ?? new Text("", 0, 0);
      component.setText(text);
      return component;
    },

    renderResult(result, _options, theme, context) {
      const d = result.details as any;
      if (!d) {
        const component = context.lastComponent ?? new Text("", 0, 0);
        component.setText("");
        return component;
      }
      const icon = d.statusCode >= 400 ? theme.fg("statusError", "✗") : d.statusCode >= 300 ? theme.fg("statusWarn", "!") : theme.fg("statusSuccess", "✓");
      const truncated = d.truncated ? " " + theme.fg("statusWarn", "[truncated]") : "";
      const text = `${icon} ${theme.fg("accent", String(d.statusCode))} ${theme.fg("link", d.url.slice(0, 80))} ${theme.fg("dim", `(${(d.bodySize / 1024).toFixed(1)}KB)`)}${truncated}`;
      const component = context.lastComponent ?? new Text("", 0, 0);
      component.setText(text);
      return component;
    },
  });

  pi.registerCommand("web-fetch", {
    description: "Fetch a URL and display its content. Usage: /web-fetch <url> [maxLength]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (!parts[0]) { ctx.ui.notify("Usage: /web-fetch <url> [maxLength]", "info"); return; }

      const url = parts[0];
      const maxLength = parts[1] ? Number(parts[1]) || DEFAULT_MAX_CHARS : DEFAULT_MAX_CHARS;
      ctx.ui.setStatus("web-fetch", `Fetching ${url}...`);

      try {
        const parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          ctx.ui.notify(`Unsupported protocol: ${parsedUrl.protocol}`, "error");
          ctx.ui.setStatus("web-fetch", undefined);
          return;
        }
      } catch {
        ctx.ui.notify(`Invalid URL: ${url}`, "error");
        ctx.ui.setStatus("web-fetch", undefined);
        return;
      }

      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        const resp = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept: "text/html,application/json,text/plain,*/*",
          },
          redirect: "follow",
        });
        clearTimeout(tid);

        const ct = resp.headers.get("content-type") || "unknown";
        const buf = await resp.arrayBuffer();
        let body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        body = isHtml(ct, body) ? htmlToText(body) : isJson(ct) ? formatJson(body) : body;
        if (body.length > maxLength) body = body.slice(0, maxLength) + `\n\n... [truncated at ${maxLength.toLocaleString()} chars]`;

        ctx.ui.setStatus("web-fetch", undefined);
        ctx.ui.notify(`${url} (${resp.status}): ${body.slice(0, 500)}${body.length > 500 ? "..." : ""}`, "info");
      } catch (err: unknown) {
        ctx.ui.setStatus("web-fetch", undefined);
        ctx.ui.notify(`Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
