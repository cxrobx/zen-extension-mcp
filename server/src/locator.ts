import { ZenToolError } from "./errors.js";

export type ParsedLocator =
  | { kind: "css"; selector: string }
  | { kind: "xpath"; expression: string };

export function parseLocator(spec: string): ParsedLocator {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new ZenToolError("BAD_SELECTOR", "Locator must be a non-empty string");
  }
  const trimmed = spec.trim();

  if (trimmed.startsWith("xpath:")) {
    return { kind: "xpath", expression: trimmed.slice(6) };
  }
  if (trimmed.startsWith("css:")) {
    return { kind: "css", selector: trimmed.slice(4) };
  }
  if (trimmed.startsWith("text:")) {
    const text = trimmed.slice(5);
    const lit = xpathStringLiteral(text);
    return {
      kind: "xpath",
      expression: `//*[normalize-space(.)=${lit} and not(.//*[normalize-space(.)=${lit}])]`,
    };
  }
  if (trimmed.startsWith("text*:")) {
    const text = trimmed.slice(6);
    const lit = xpathStringLiteral(text);
    return {
      kind: "xpath",
      expression: `//*[contains(normalize-space(.), ${lit}) and not(.//*[contains(normalize-space(.), ${lit})])]`,
    };
  }
  if (trimmed.startsWith("role:")) {
    return parseRoleLocator(trimmed.slice(5));
  }
  return { kind: "css", selector: trimmed };
}

function parseRoleLocator(spec: string): ParsedLocator {
  const match = spec.match(/^([a-zA-Z]+)(?:\[name=(?:"([^"]*)"|'([^']*)')\])?$/);
  if (!match) {
    throw new ZenToolError(
      "BAD_SELECTOR",
      `Invalid role locator: ${spec}`,
      'Expected: role:button or role:button[name="Submit"]',
    );
  }
  const role = match[1] as string;
  const name: string | undefined = match[2] ?? match[3];
  const roleLit = xpathStringLiteral(role);
  let xpath = `//*[@role=${roleLit}`;
  if (name) {
    const nameLit = xpathStringLiteral(name);
    xpath += ` and (@aria-label=${nameLit} or normalize-space(.)=${nameLit})`;
  }
  xpath += "]";
  return { kind: "xpath", expression: xpath };
}

function xpathStringLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  const parts = value.split("'");
  const literals = parts.map((part, idx) => (idx > 0 ? `"'", '${part}'` : `'${part}'`));
  return `concat(${literals.join(", ")})`;
}
