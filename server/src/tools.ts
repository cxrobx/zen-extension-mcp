import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ContainersListResult,
  type FirefoxContainer,
  Methods,
  type NavigateHistoryDirection,
  type NewPageResult,
  type PageInfo,
  type PagesListResult,
} from "@zen-ext-mcp/shared";
import type { DaemonClient } from "./daemon-client.js";
import {
  formatAvailableContainers,
  resolveContainerByName,
} from "./container.js";

export interface ScopeRef {
  current: FirefoxContainer | null;
}

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResponse {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
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
}
