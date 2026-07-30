import type { FirefoxContainer } from "@zen-mcp/shared";

export function formatContainer(container: FirefoxContainer): string {
  return `${container.name} (${container.cookieStoreId})`;
}

export function formatAvailableContainers(containers: FirefoxContainer[]): string {
  if (containers.length === 0) return "none";
  return containers.map(formatContainer).join(", ");
}

export function resolveContainerByName(
  containers: FirefoxContainer[],
  name: string,
): FirefoxContainer {
  if (!name || typeof name !== "string") {
    throw new Error("Container name is required");
  }
  const matches = containers.filter((c) => c.name === name);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(
      `Container "${name}" was not found. Available containers: ${formatAvailableContainers(containers)}`,
    );
  }
  throw new Error(
    `Container name "${name}" is ambiguous (${matches.length} matches). Matching containers: ${matches
      .map(formatContainer)
      .join(", ")}`,
  );
}
