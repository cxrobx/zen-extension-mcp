import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ClearCookiesResult,
  type ContainersListResult,
  type EvaluateScriptResult,
  type FirefoxContainer,
  type GetCookiesResult,
  type GetPageTextResult,
  type InfoGetResult,
  type LocatorSpec,
  Methods,
  type NavigateHistoryDirection,
  type NewPageResult,
  type PageInfo,
  type PagesListResult,
  type ReadPageResult,
  type ResolveUidResult,
  type ScreenshotPageResult,
  type SelectOptionResult,
  type SetCookiesResult,
  type SnapshotNode,
  type StorageClearResult,
  type StorageGetResult,
  type StorageSetResult,
  type TakeSnapshotResult,
} from "@zen-ext-mcp/shared";
import type { DaemonClient } from "./daemon-client.js";
import {
  formatAvailableContainers,
  resolveContainerByName,
} from "./container.js";
import { ZenToolError } from "./errors.js";
import { continueCursor, withResponseBudget } from "./response-budget.js";
import { parseLocator } from "./locator.js";

export interface ScopeRef {
  current: FirefoxContainer | null;
}

export interface ServerIdentity {
  name: string;
  version: string;
  daemonUrl: string;
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolResponse = {
  isError?: boolean;
  content: Array<TextContent | ImageContent>;
};

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

function okWithImage(text: string, base64Png: string): ToolResponse {
  return {
    content: [
      { type: "text", text },
      { type: "image", data: base64Png, mimeType: "image/png" },
    ],
  };
}

function fail(err: unknown): ToolResponse {
  if (err instanceof ZenToolError) {
    return { isError: true, content: [{ type: "text", text: err.toToolText() }] };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

function toLocator(spec: string): LocatorSpec {
  return parseLocator(spec) as LocatorSpec;
}

function truncateOneLine(value: string | undefined, maxLen: number): string {
  if (!value) return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

async function resolvePageIdx(daemon: DaemonClient, pageIdx: number): Promise<PageInfo> {
  const pages = await listPages(daemon);
  const page = pages[pageIdx];
  if (!page) {
    throw new Error(`pageIdx ${pageIdx} out of range; ${pages.length} pages currently open`);
  }
  return page;
}

function formatSnapshotTree(node: SnapshotNode | null, indent = 0): string {
  if (!node) return "(empty tree)";
  const pad = "  ".repeat(indent);
  const parts: string[] = [`${node.tag}#${node.uid}`];
  if (node.role) parts.push(`role=${node.role}`);
  if (node.name) parts.push(`name=${JSON.stringify(node.name)}`);
  if (node.text) parts.push(`text=${JSON.stringify(node.text)}`);
  if (node.value) parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.href) parts.push(`href=${node.href}`);
  if (node.isIframe) parts.push(node.crossOrigin ? "iframe(cross-origin)" : "iframe");
  const lines = [`${pad}${parts.join(" ")}`];
  for (const child of node.children) lines.push(formatSnapshotTree(child, indent + 1));
  return lines.join("\n");
}

function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  if (idx === -1) return dataUrl;
  return dataUrl.slice(idx + 1);
}

function sortedPages(pages: PageInfo[]): PageInfo[] {
  return [...pages].sort((a, b) => {
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  });
}

function formatPageList(pages: PageInfo[]): string {
  if (pages.length === 0) return "(no pages)";
  return pages
    .map((p, i) => {
      const marker = p.active ? "*" : " ";
      const container = p.containerName ?? "no container";
      const title = p.title ? ` "${p.title}"` : "";
      return `${marker} [${i}] tabId=${p.tabId} ${p.url}${title} (${container})`;
    })
    .join("\n");
}

async function listPages(daemon: DaemonClient): Promise<PageInfo[]> {
  const result = await daemon.call<PagesListResult>(Methods.PagesList);
  return sortedPages(result.pages);
}

async function resolveScopeContainer(
  daemon: DaemonClient,
  name: string,
): Promise<FirefoxContainer> {
  const result = await daemon.call<ContainersListResult>(Methods.ContainersList);
  try {
    return resolveContainerByName(result.containers, name);
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\nAvailable: ${formatAvailableContainers(result.containers)}`,
    );
  }
}

export function registerTools(
  server: McpServer,
  daemon: DaemonClient,
  scope: ScopeRef,
  identity: ServerIdentity,
): void {
  server.registerTool(
    "list_containers",
    {
      title: "List Firefox containers",
      description: "List all containers (contextual identities) in the connected Zen.",
      inputSchema: {},
    },
    async () => {
      try {
        const r = await daemon.call<ContainersListResult>(Methods.ContainersList);
        if (r.containers.length === 0) return ok("(no containers)");
        return ok(
          r.containers
            .map((c) => `- ${c.name} (${c.cookieStoreId}) [${c.color}/${c.icon}]`)
            .join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "set_default_container",
    {
      title: "Set default container",
      description:
        "Set the default Firefox container for future new_page calls in this MCP session. Existing tabs are not moved.",
      inputSchema: {
        name: z.string().describe("Exact Firefox container name"),
      },
    },
    async ({ name }) => {
      try {
        scope.current = await resolveScopeContainer(daemon, name);
        return ok(
          `default container set to "${scope.current.name}" (${scope.current.cookieStoreId})`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "List all open tabs across all windows. Pages are stably indexed by (windowId, tab.index); use that index with select_page / navigate_page / close_page / navigate_history.",
      inputSchema: {},
    },
    async () => {
      try {
        const pages = await listPages(daemon);
        return ok(formatPageList(pages));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "new_page",
    {
      title: "New page",
      description:
        "Open a new tab at URL. Uses the current default container if one is set (via --container or set_default_container).",
      inputSchema: {
        url: z.string().describe("Target URL"),
      },
    },
    async ({ url }) => {
      try {
        const params: { url: string; cookieStoreId?: string } = { url };
        if (scope.current) params.cookieStoreId = scope.current.cookieStoreId;
        const r = await daemon.call<NewPageResult>(Methods.PagesNew, params);
        const cn = r.containerName ?? "no container";
        return ok(`new page tabId=${r.tabId} -> ${r.url} (${cn})`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "new_page_in_container",
    {
      title: "New page in container",
      description:
        "Open a new tab at URL in the named Firefox container. Independent of the default container scope.",
      inputSchema: {
        name: z.string().describe("Exact Firefox container name"),
        url: z.string().describe("Target URL"),
      },
    },
    async ({ name, url }) => {
      try {
        const container = await resolveScopeContainer(daemon, name);
        const r = await daemon.call<NewPageResult>(Methods.PagesNew, {
          url,
          cookieStoreId: container.cookieStoreId,
        });
        return ok(`new page tabId=${r.tabId} -> ${r.url} (${container.name})`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "navigate_page",
    {
      title: "Navigate page",
      description:
        "Navigate the tab at pageIdx to URL. pageIdx comes from list_pages.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative().describe("Index from list_pages"),
        url: z.string().describe("Target URL"),
      },
    },
    async ({ pageIdx, url }) => {
      try {
        const pages = await listPages(daemon);
        const page = pages[pageIdx];
        if (!page) {
          throw new Error(
            `pageIdx ${pageIdx} out of range; ${pages.length} pages currently open`,
          );
        }
        await daemon.call(Methods.PagesNavigate, { tabId: page.tabId, url });
        return ok(`tabId=${page.tabId} -> ${url}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "select_page",
    {
      title: "Select page",
      description:
        "Focus a tab. Provide one of: pageIdx (from list_pages), url (substring match), title (substring match). Errors if multiple match for url/title.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
      },
    },
    async ({ pageIdx, url, title }) => {
      try {
        const pages = await listPages(daemon);
        const target = ((): PageInfo => {
          if (typeof pageIdx === "number") {
            const p = pages[pageIdx];
            if (!p) throw new Error(`pageIdx ${pageIdx} out of range`);
            return p;
          }
          if (url) {
            const matches = pages.filter((p) => p.url.includes(url));
            if (matches.length === 0) throw new Error(`no page matches url substring "${url}"`);
            if (matches.length > 1) {
              throw new Error(
                `${matches.length} pages match url "${url}"; refine the substring or use pageIdx`,
              );
            }
            return matches[0]!;
          }
          if (title) {
            const matches = pages.filter((p) => p.title.includes(title));
            if (matches.length === 0) throw new Error(`no page matches title substring "${title}"`);
            if (matches.length > 1) {
              throw new Error(
                `${matches.length} pages match title "${title}"; refine or use pageIdx`,
              );
            }
            return matches[0]!;
          }
          throw new Error("provide one of: pageIdx, url, title");
        })();
        await daemon.call(Methods.PagesSelect, { tabId: target.tabId });
        return ok(`selected tabId=${target.tabId} ${target.url}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "close_page",
    {
      title: "Close page",
      description: "Close the tab at pageIdx. pageIdx comes from list_pages.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative().describe("Index from list_pages"),
      },
    },
    async ({ pageIdx }) => {
      try {
        const pages = await listPages(daemon);
        const page = pages[pageIdx];
        if (!page) throw new Error(`pageIdx ${pageIdx} out of range`);
        await daemon.call(Methods.PagesClose, { tabId: page.tabId });
        return ok(`closed tabId=${page.tabId} ${page.url}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "navigate_history",
    {
      title: "Navigate history",
      description: "Go back or forward in the tab at pageIdx.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative().describe("Index from list_pages"),
        direction: z.enum(["back", "forward"]),
      },
    },
    async ({ pageIdx, direction }) => {
      try {
        const pages = await listPages(daemon);
        const page = pages[pageIdx];
        if (!page) throw new Error(`pageIdx ${pageIdx} out of range`);
        const dir: NavigateHistoryDirection = direction;
        await daemon.call(Methods.PagesNavigateHistory, {
          tabId: page.tabId,
          direction: dir,
        });
        return ok(`tabId=${page.tabId} ${direction}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "take_snapshot",
    {
      title: "Take DOM snapshot",
      description:
        "Capture a structured DOM snapshot of the page at pageIdx. Returns a tree with stable UIDs that other DOM tools accept. UIDs are scoped to (tabId, snapshotId) and persist until the next take_snapshot, navigation, or clear_snapshot.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        selector: z.string().optional().describe("Optional CSS selector to scope the snapshot root"),
        includeAll: z
          .boolean()
          .optional()
          .describe("Include all visible elements, not just the relevance-filtered set"),
        includeIframes: z.boolean().optional(),
      },
    },
    async ({ pageIdx, selector, includeAll, includeIframes }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const params: Record<string, unknown> = { tabId: page.tabId };
        if (selector !== undefined) params.selector = selector;
        if (includeAll !== undefined) params.includeAll = includeAll;
        if (includeIframes !== undefined) params.includeIframes = includeIframes;
        const r = await daemon.call<TakeSnapshotResult>(Methods.DomTakeSnapshot, params);
        if (r.selectorError) return fail(new Error(r.selectorError));
        const header = `snapshot ${r.snapshotId} for tabId=${r.tabId} (${r.uidMap.length} UIDs${r.truncated ? ", truncated" : ""})`;
        return ok(`${header}\n${formatSnapshotTree(r.tree)}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "clear_snapshot",
    {
      title: "Clear DOM snapshot",
      description: "Drop the cached snapshot for the page at pageIdx.",
      inputSchema: { pageIdx: z.number().int().nonnegative() },
    },
    async ({ pageIdx }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        await daemon.call(Methods.DomClearSnapshot, { tabId: page.tabId });
        return ok(`cleared snapshot for tabId=${page.tabId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "click_by_uid",
    {
      title: "Click by UID",
      description: "Click the element with the given UID from the most recent snapshot of the page.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        uid: z.string().describe("UID from take_snapshot"),
      },
    },
    async ({ pageIdx, uid }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        await daemon.call(Methods.DomClick, { tabId: page.tabId, uid });
        return ok(`clicked uid=${uid} on tabId=${page.tabId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "hover_by_uid",
    {
      title: "Hover by UID",
      description: "Dispatch mouseover + mouseenter on the element at UID.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        uid: z.string(),
      },
    },
    async ({ pageIdx, uid }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        await daemon.call(Methods.DomHover, { tabId: page.tabId, uid });
        return ok(`hovered uid=${uid} on tabId=${page.tabId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "fill_by_uid",
    {
      title: "Fill by UID",
      description:
        "Set the value on an input/textarea/contenteditable element identified by UID. Dispatches input + change events.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        uid: z.string(),
        value: z.string(),
      },
    },
    async ({ pageIdx, uid, value }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        await daemon.call(Methods.DomFill, { tabId: page.tabId, uid, value });
        return ok(`filled uid=${uid} on tabId=${page.tabId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "fill_form_by_uid",
    {
      title: "Fill form by UID",
      description:
        "Fill multiple form fields in one call. Each field is { uid, value }. All fields must resolve from the current snapshot or the call errors.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        fields: z.array(z.object({ uid: z.string(), value: z.string() })),
      },
    },
    async ({ pageIdx, fields }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        await daemon.call(Methods.DomFillForm, { tabId: page.tabId, fields });
        return ok(`filled ${fields.length} fields on tabId=${page.tabId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "drag_by_uid_to_uid",
    {
      title: "Drag by UID to UID",
      description:
        "Synthetic drag from one element to another. Dispatches dragstart, dragenter, dragover, drop, dragend with a shared DataTransfer.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        fromUid: z.string(),
        toUid: z.string(),
      },
    },
    async ({ pageIdx, fromUid, toUid }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        await daemon.call(Methods.DomDrag, {
          tabId: page.tabId,
          fromUid,
          toUid,
        });
        return ok(`dragged ${fromUid} -> ${toUid} on tabId=${page.tabId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "resolve_uid_to_selector",
    {
      title: "Resolve UID to selector",
      description: "Look up the CSS selector for a UID from the current snapshot.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        uid: z.string(),
      },
    },
    async ({ pageIdx, uid }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const r = await daemon.call<ResolveUidResult>(Methods.DomResolveUidToSelector, {
          tabId: page.tabId,
          uid,
        });
        const xpathLine = r.xpath ? `\nxpath=${r.xpath}` : "";
        return ok(`uid=${r.uid}\ncss=${r.css}${xpathLine}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "evaluate_script",
    {
      title: "Evaluate script",
      description:
        "Run JavaScript in the page's MAIN world. The provided string is the function body; return a JSON-serializable value with `return ...`. Cannot return DOM nodes or non-serializable objects.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        code: z.string().describe("Function body. Use `return` to send a value back."),
      },
    },
    async ({ pageIdx, code }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const r = await daemon.call<EvaluateScriptResult>(Methods.DomEvaluate, {
          tabId: page.tabId,
          code,
        });
        const text =
          r.result === undefined
            ? "(undefined)"
            : typeof r.result === "string"
              ? r.result
              : JSON.stringify(r.result, null, 2);
        return ok(text);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "screenshot_page",
    {
      title: "Screenshot page",
      description:
        "Capture the visible viewport of the tab at pageIdx as PNG. Note: WebExtension API can only capture the *active* tab in its window — call select_page first if necessary.",
      inputSchema: { pageIdx: z.number().int().nonnegative() },
    },
    async ({ pageIdx }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const r = await daemon.call<ScreenshotPageResult>(Methods.PagesScreenshot, {
          tabId: page.tabId,
        });
        const base64 = dataUrlToBase64(r.dataUrl);
        return okWithImage(`screenshot of tabId=${r.tabId} (${base64.length} bytes base64)`, base64);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_page_text",
    {
      title: "Get page text",
      description:
        "Return the visible innerText of the page or a selector subtree. Cheaper than take_snapshot for reading content. Honors a response budget; pass cursor to continue.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        selector: z.string().optional(),
        maxBytes: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ pageIdx, selector, maxBytes, cursor }) => {
      try {
        if (cursor) {
          const next = continueCursor(cursor, maxBytes);
          return ok(next.text);
        }
        const page = await resolvePageIdx(daemon, pageIdx);
        const params: { tabId: number; selector?: string } = { tabId: page.tabId };
        if (selector) params.selector = selector;
        const r = await daemon.call<GetPageTextResult>(Methods.DomGetPageText, params);
        return ok(withResponseBudget(r.text, maxBytes).text);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "read_page",
    {
      title: "Read page as Markdown",
      description:
        "Extract the main article from the current page using Mozilla Readability and convert it to Markdown via Turndown. Strips nav, ads, sidebars. Honors a response budget.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        maxBytes: z.number().int().positive().optional(),
        cursor: z.string().optional(),
        includeMetadata: z.boolean().optional(),
      },
    },
    async ({ pageIdx, maxBytes, cursor, includeMetadata }) => {
      try {
        if (cursor) {
          const next = continueCursor(cursor, maxBytes);
          return ok(next.text);
        }
        const page = await resolvePageIdx(daemon, pageIdx);
        const r = await daemon.call<ReadPageResult>(Methods.DomReadPage, {
          tabId: page.tabId,
        });
        if (!r.ok) {
          if (r.reason === "no_article") {
            throw new ZenToolError(
              "NOT_FOUND",
              "Readability could not extract an article from this page",
              "Try get_page_text or take_snapshot instead.",
            );
          }
          throw new ZenToolError(
            "UPSTREAM",
            `Readability failed (${r.reason ?? "unknown"})${r.message ? `: ${r.message}` : ""}`,
          );
        }
        let body = "";
        const headerOn = includeMetadata !== false;
        if (headerOn) {
          const header: string[] = [];
          if (r.title) header.push(`# ${r.title}`);
          const meta: string[] = [];
          if (r.byline) meta.push(`by ${r.byline}`);
          if (r.siteName) meta.push(r.siteName);
          if (typeof r.length === "number") meta.push(`${r.length} chars`);
          if (meta.length > 0) header.push(`_${meta.join(" · ")}_`);
          if (r.excerpt) {
            header.push("");
            header.push(`> ${r.excerpt}`);
          }
          if (header.length > 0) body = header.join("\n") + "\n\n";
        }
        body += r.markdown ?? "";
        return ok(withResponseBudget(body, maxBytes).text);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "find_by_text",
    {
      title: "Find UIDs by rendered text",
      description:
        "Take a snapshot (forced includeAll) and return matches whose text/name/value contain the given string. Returned UIDs are usable with click_by_uid / fill_by_uid.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        text: z.string(),
        exact: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        selector: z.string().optional(),
      },
    },
    async ({ pageIdx, text, exact, caseSensitive, limit, selector }) => {
      try {
        if (typeof text !== "string" || text.length === 0) {
          throw new ZenToolError("BAD_INPUT", "text must be a non-empty string");
        }
        const page = await resolvePageIdx(daemon, pageIdx);
        const params: { tabId: number; selector?: string; includeAll: boolean } = {
          tabId: page.tabId,
          includeAll: true,
        };
        if (selector) params.selector = selector;
        const snap = await daemon.call<TakeSnapshotResult>(Methods.DomTakeSnapshot, params);
        const needle = caseSensitive ? text : text.toLowerCase();
        const cap = typeof limit === "number" && limit > 0 ? limit : 20;
        const matches: Array<{
          uid: string;
          tag: string;
          role?: string;
          name?: string;
          text?: string;
        }> = [];
        const walk = (node: SnapshotNode | null): boolean => {
          if (!node) return true;
          if (matches.length >= cap) return false;
          const haystacks = [node.text, node.name, node.value].filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          );
          for (const candidate of haystacks) {
            const hay = caseSensitive ? candidate : candidate.toLowerCase();
            const hit = exact ? hay === needle : hay.includes(needle);
            if (hit) {
              matches.push({
                uid: node.uid,
                tag: node.tag,
                ...(node.role ? { role: node.role } : {}),
                ...(node.name ? { name: node.name } : {}),
                ...(node.text ? { text: node.text } : {}),
              });
              break;
            }
          }
          for (const child of node.children) {
            if (!walk(child)) return false;
          }
          return true;
        };
        walk(snap.tree);
        if (matches.length === 0) {
          return ok(
            `No matches for ${exact ? "exact" : "substring"} text "${text}" (snapshotId=${snap.snapshotId}).`,
          );
        }
        const lines = [
          `Found ${matches.length} match${matches.length === 1 ? "" : "es"} (snapshotId=${snap.snapshotId}):`,
          "",
          ...matches.map((m) => {
            const parts = [`uid=${m.uid}`, m.role ?? m.tag];
            if (m.role && m.role !== m.tag) parts.push(`tag=${m.tag}`);
            if (m.name) parts.push(`name="${truncateOneLine(m.name, 60)}"`);
            if (m.text) parts.push(`text="${truncateOneLine(m.text, 80)}"`);
            return `  ${parts.join(" ")}`;
          }),
        ];
        return ok(lines.join("\n"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for a condition",
      description:
        "Poll until a condition holds. Supports text (page innerText contains), selector_visible/hidden (locator matches and offsetParent), selector_count (locator count compared via op), url (substring or regex when urlRegex:true), time (fixed delay).",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        condition: z.enum([
          "text",
          "selector_visible",
          "selector_hidden",
          "selector_count",
          "url",
          "time",
        ]),
        text: z.string().optional(),
        selector: z.string().optional(),
        count: z.number().int().nonnegative().optional(),
        op: z.enum(["=", "!=", ">", ">=", "<", "<="]).optional(),
        urlPattern: z.string().optional(),
        urlRegex: z.boolean().optional(),
        ms: z.number().int().nonnegative().optional(),
        timeout: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const {
        pageIdx,
        condition,
        text,
        selector,
        count,
        op,
        urlPattern,
        urlRegex,
        ms,
        timeout,
      } = args;
      try {
        if (condition === "time") {
          const delay = ms ?? 0;
          await new Promise((r) => setTimeout(r, delay));
          return ok(`Waited ${delay}ms.`);
        }
        const page = await resolvePageIdx(daemon, pageIdx);
        const tabId = page.tabId;
        const totalTimeout = timeout ?? 10_000;
        const start = Date.now();
        const deadline = start + totalTimeout;
        const POLL_MS = 200;

        let useRegex = false;
        let re: RegExp | null = null;
        if (condition === "url") {
          if (!urlPattern) {
            throw new ZenToolError("BAD_INPUT", "urlPattern is required when condition=url");
          }
          useRegex = urlRegex === true;
          if (useRegex) {
            try {
              re = new RegExp(urlPattern);
            } catch (e) {
              throw new ZenToolError(
                "BAD_INPUT",
                `Invalid urlPattern regex: ${(e as Error).message}`,
              );
            }
          }
        }

        let locator: LocatorSpec | null = null;
        if (
          condition === "selector_visible" ||
          condition === "selector_hidden" ||
          condition === "selector_count"
        ) {
          if (!selector) {
            throw new ZenToolError("BAD_INPUT", "selector is required for this condition");
          }
          locator = toLocator(selector);
        }
        if (condition === "selector_count" && typeof count !== "number") {
          throw new ZenToolError("BAD_INPUT", "count is required when condition=selector_count");
        }
        if (condition === "text" && (!text || typeof text !== "string")) {
          throw new ZenToolError("BAD_INPUT", "text is required when condition=text");
        }

        let lastObserved = "";
        while (Date.now() < deadline) {
          let matched = false;
          if (condition === "text") {
            const probe = `var t = document.body && document.body.innerText; return typeof t === 'string' && t.indexOf(${JSON.stringify(text)}) !== -1;`;
            const r = await daemon.call<EvaluateScriptResult>(Methods.DomEvaluate, {
              tabId,
              code: probe,
            });
            matched = r.result === true;
            lastObserved = matched ? "present" : "absent";
          } else if (condition === "url") {
            const tabs = await daemon.call<PagesListResult>(Methods.PagesList);
            const tab = tabs.pages.find((p) => p.tabId === tabId);
            const url = tab?.url ?? "";
            matched = re ? re.test(url) : url.includes(urlPattern as string);
            lastObserved = `url=${url.slice(0, 80)}`;
          } else {
            const loc = locator as LocatorSpec;
            const probeCode =
              loc.kind === "css"
                ? `var sel = ${JSON.stringify(loc.selector)}; var els = Array.from(document.querySelectorAll(sel)); return els.map(function(el){ return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0); });`
                : `var x = document.evaluate(${JSON.stringify(loc.expression)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); var out=[]; for (var i=0;i<x.snapshotLength;i++){ var el=x.snapshotItem(i); out.push(el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0)); } return out;`;
            const r = await daemon.call<EvaluateScriptResult>(Methods.DomEvaluate, {
              tabId,
              code: probeCode,
            });
            const states = Array.isArray(r.result) ? (r.result as boolean[]) : [];
            const visible = states.filter((s) => s === true).length;
            const total = states.length;
            if (condition === "selector_visible") {
              matched = visible > 0;
              lastObserved = `matched=${total} visible=${visible}`;
            } else if (condition === "selector_hidden") {
              matched = total === 0 || visible === 0;
              lastObserved = `matched=${total} visible=${visible}`;
            } else {
              const target = count as number;
              const operator = op ?? "=";
              switch (operator) {
                case "=":
                  matched = total === target;
                  break;
                case "!=":
                  matched = total !== target;
                  break;
                case ">":
                  matched = total > target;
                  break;
                case ">=":
                  matched = total >= target;
                  break;
                case "<":
                  matched = total < target;
                  break;
                case "<=":
                  matched = total <= target;
                  break;
              }
              lastObserved = `count=${total}`;
            }
          }
          if (matched) {
            return ok(`Matched after ${Date.now() - start}ms (${condition}).`);
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        throw new ZenToolError(
          "TIMEOUT",
          `wait_for(${condition}) timed out after ${totalTimeout}ms. Last observed: ${lastObserved}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "click",
    {
      title: "Click by locator",
      description:
        'Click the first element matching the locator. Locator grammar: prefixes css:/xpath:/text:/text*:/role: (default is css). Example: "text:Submit" or "role:button[name=\\"Submit\\"]".',
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        selector: z.string(),
      },
    },
    async ({ pageIdx, selector }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const locator = toLocator(selector);
        await daemon.call(Methods.DomClickByLocator, { tabId: page.tabId, locator });
        return ok(`clicked ${selector}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "hover",
    {
      title: "Hover by locator",
      description: "Dispatch mouseover/mouseenter on the first element matching the locator.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        selector: z.string(),
      },
    },
    async ({ pageIdx, selector }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const locator = toLocator(selector);
        await daemon.call(Methods.DomHoverByLocator, { tabId: page.tabId, locator });
        return ok(`hovered ${selector}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "fill",
    {
      title: "Fill by locator",
      description:
        "Set the value of an input/textarea/contenteditable matched by the locator. Dispatches input + change.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        selector: z.string(),
        value: z.string(),
      },
    },
    async ({ pageIdx, selector, value }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const locator = toLocator(selector);
        await daemon.call(Methods.DomFillByLocator, {
          tabId: page.tabId,
          locator,
          value,
        });
        return ok(`filled ${selector}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "type",
    {
      title: "Type into a field (key by key)",
      description:
        "Type text into the matched element one keypress at a time, dispatching keydown/keypress/input/keyup. Use fill for plain value-set.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        selector: z.string(),
        text: z.string(),
        delayMs: z.number().int().nonnegative().optional(),
        clearFirst: z.boolean().optional(),
      },
    },
    async ({ pageIdx, selector, text, delayMs, clearFirst }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const locator = toLocator(selector);
        await daemon.call(Methods.DomTypeByLocator, {
          tabId: page.tabId,
          locator,
          text,
          ...(typeof delayMs === "number" ? { delayMs } : {}),
          ...(typeof clearFirst === "boolean" ? { clearFirst } : {}),
        });
        return ok(`typed ${text.length} chars into ${selector}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "drag",
    {
      title: "Drag and drop by locator",
      description:
        "Drag the from element onto the to element. Dispatches synthetic DragEvents (dragstart, dragenter, dragover, drop, dragend).",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        from: z.string(),
        to: z.string(),
      },
    },
    async ({ pageIdx, from, to }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        await daemon.call(Methods.DomDragByLocator, {
          tabId: page.tabId,
          from: toLocator(from),
          to: toLocator(to),
        });
        return ok(`dragged ${from} -> ${to}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "select_option",
    {
      title: "Select <option>",
      description:
        "Pick an option from a <select> element identified by locator. Choose by value, label (visible text), or index.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        selector: z.string(),
        by: z.enum(["value", "label", "index"]),
        value: z.string(),
      },
    },
    async ({ pageIdx, selector, by, value }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const locator = toLocator(selector);
        const r = await daemon.call<SelectOptionResult>(Methods.DomSelectOptionByLocator, {
          tabId: page.tabId,
          locator,
          by,
          value,
        });
        if (!r.ok) {
          if (r.reason === "not_select") {
            throw new ZenToolError(
              "BAD_INPUT",
              `Target is <${r.tag ?? "?"}>, not <select>`,
            );
          }
          if (r.reason === "not_found") {
            throw new ZenToolError("NOT_FOUND", `No element matched ${selector}`);
          }
          throw new ZenToolError(
            "NOT_FOUND",
            `No <option> matched by=${by} value=${value}`,
          );
        }
        return ok(`selected "${r.label ?? ""}" (value="${r.value ?? ""}") in ${selector}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "press_key",
    {
      title: "Press a key combo",
      description:
        'Send a key combo (e.g. "Enter", "Cmd+L", "Ctrl+Shift+P", "Escape"). Without selector, sends to the active element.',
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        keys: z.string(),
        selector: z.string().optional(),
      },
    },
    async ({ pageIdx, keys, selector }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const target = selector
          ? { kind: "locator" as const, locator: toLocator(selector) }
          : { kind: "active" as const };
        await daemon.call(Methods.DomPressKey, { tabId: page.tabId, target, keys });
        return ok(`pressed ${keys}${selector ? ` on ${selector}` : ""}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_cookies",
    {
      title: "Get cookies",
      description:
        "List cookies via browser.cookies.getAll. Filter by url/name/domain/storeId. Returns Playwright-shape entries.",
      inputSchema: {
        url: z.string().optional(),
        name: z.string().optional(),
        domain: z.string().optional(),
        storeId: z.string().optional(),
      },
    },
    async ({ url, name, domain, storeId }) => {
      try {
        const params: { url?: string; name?: string; domain?: string; storeId?: string } = {};
        if (url) params.url = url;
        if (name) params.name = name;
        if (domain) params.domain = domain;
        if (storeId) params.storeId = storeId;
        const r = await daemon.call<GetCookiesResult>(Methods.CookiesGet, params);
        return ok(JSON.stringify(r.cookies, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "set_cookies",
    {
      title: "Set cookies",
      description:
        "Set one or more cookies via browser.cookies.set. Each cookie needs {url, name, value}; domain/path/secure/etc are optional.",
      inputSchema: {
        cookies: z
          .array(
            z.object({
              url: z.string(),
              name: z.string(),
              value: z.string(),
              domain: z.string().optional(),
              path: z.string().optional(),
              expirationDate: z.number().optional(),
              httpOnly: z.boolean().optional(),
              secure: z.boolean().optional(),
              sameSite: z.enum(["no_restriction", "lax", "strict"]).optional(),
              storeId: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ cookies }) => {
      try {
        const r = await daemon.call<SetCookiesResult>(Methods.CookiesSet, { cookies });
        return ok(`set ${r.set} cookie${r.set === 1 ? "" : "s"}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "clear_cookies",
    {
      title: "Clear cookies",
      description:
        "Delete cookies matched by url/name/domain/storeId via browser.cookies.remove. Without filters, returns 0 (use a domain filter).",
      inputSchema: {
        url: z.string().optional(),
        name: z.string().optional(),
        domain: z.string().optional(),
        storeId: z.string().optional(),
      },
    },
    async ({ url, name, domain, storeId }) => {
      try {
        const params: { url?: string; name?: string; domain?: string; storeId?: string } = {};
        if (url) params.url = url;
        if (name) params.name = name;
        if (domain) params.domain = domain;
        if (storeId) params.storeId = storeId;
        const r = await daemon.call<ClearCookiesResult>(Methods.CookiesClear, params);
        return ok(`deleted ${r.deleted} cookie${r.deleted === 1 ? "" : "s"}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_storage",
    {
      title: "Get localStorage/sessionStorage",
      description: "Read storage items as a key->value map. Filter via keys array.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        kind: z.enum(["local", "session"]),
        keys: z.array(z.string()).optional(),
      },
    },
    async ({ pageIdx, kind, keys }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const params: { tabId: number; kind: "local" | "session"; keys?: string[] } = {
          tabId: page.tabId,
          kind,
        };
        if (keys) params.keys = keys;
        const r = await daemon.call<StorageGetResult>(Methods.StorageGet, params);
        return ok(JSON.stringify(r.items, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "set_storage",
    {
      title: "Set localStorage/sessionStorage",
      description: "Write key/value pairs into storage.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        kind: z.enum(["local", "session"]),
        items: z.record(z.string()),
      },
    },
    async ({ pageIdx, kind, items }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        const r = await daemon.call<StorageSetResult>(Methods.StorageSet, {
          tabId: page.tabId,
          kind,
          items,
        });
        return ok(`wrote ${r.written} ${kind}Storage item${r.written === 1 ? "" : "s"}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "clear_storage",
    {
      title: "Clear localStorage/sessionStorage",
      description:
        "Remove specific keys, or omit keys to clear all. Empty keys array is a no-op rather than a wipe.",
      inputSchema: {
        pageIdx: z.number().int().nonnegative(),
        kind: z.enum(["local", "session"]),
        keys: z.array(z.string()).optional(),
      },
    },
    async ({ pageIdx, kind, keys }) => {
      try {
        const page = await resolvePageIdx(daemon, pageIdx);
        if (keys !== undefined && (!Array.isArray(keys) || keys.length === 0)) {
          if (Array.isArray(keys) && keys.length === 0) {
            return ok("no keys to remove (empty key list)");
          }
          throw new ZenToolError("BAD_INPUT", "keys must be an array when provided");
        }
        const params: { tabId: number; kind: "local" | "session"; keys?: string[] } = {
          tabId: page.tabId,
          kind,
        };
        if (keys) params.keys = keys;
        const r = await daemon.call<StorageClearResult>(Methods.StorageClear, params);
        if (r.cleared) return ok(`cleared all ${kind}Storage entries`);
        return ok(`removed ${r.removed} ${kind}Storage key${r.removed === 1 ? "" : "s"}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_firefox_info",
    {
      title: "Get Firefox info",
      description:
        "Report identity + connection state: MCP server name/version, daemon URL, current container scope (if any), connected extension version, platform, tab/window/container counts.",
      inputSchema: {},
    },
    async () => {
      try {
        const r = await daemon.call<InfoGetResult>(Methods.InfoGet);
        const lines = [
          `mcp.server: ${identity.name} ${identity.version}`,
          `mcp.daemonUrl: ${identity.daemonUrl}`,
          `mcp.scope: ${scope.current ? `${scope.current.name} (${scope.current.cookieStoreId})` : "(none)"}`,
          `extension.id: ${r.extensionId}`,
          `extension.version: ${r.extensionVersion}`,
          `extension.platform: ${r.platform}`,
          `extension.userAgent: ${r.userAgent}`,
          `protocolVersion: ${r.protocolVersion}`,
          `windows: ${r.windowCount}`,
          `tabs: ${r.tabCount}`,
          `containers: ${r.containerCount}`,
        ];
        return ok(lines.join("\n"));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
