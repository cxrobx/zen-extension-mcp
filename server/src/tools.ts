import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ContainersListResult,
  type EvaluateScriptResult,
  type FirefoxContainer,
  type InfoGetResult,
  Methods,
  type NavigateHistoryDirection,
  type NewPageResult,
  type PageInfo,
  type PagesListResult,
  type ResolveUidResult,
  type ScreenshotPageResult,
  type SnapshotNode,
  type TakeSnapshotResult,
} from "@zen-ext-mcp/shared";
import type { DaemonClient } from "./daemon-client.js";
import {
  formatAvailableContainers,
  resolveContainerByName,
} from "./container.js";

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
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
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
