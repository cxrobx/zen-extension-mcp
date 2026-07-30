import { transform } from "@babel/standalone";
import { Interpreter } from "eval5";

declare global {
  interface Window {
    __zenExtMcpEvaluate?: (code: string) => unknown;
  }
}

const EVALUATION_TIMEOUT_MS = 10_000;

/**
 * Evaluate an MCP function body without eval() or Function().
 *
 * Firefox applies the page CSP to dynamic compilation in MAIN world, so sites
 * without unsafe-eval reject the old `new Function(code)` implementation. Babel
 * lowers current JavaScript syntax to ES5 and eval5 executes the resulting AST
 * against the real page window without asking Firefox to compile a string.
 */
function evaluate(code: string): unknown {
  const wrapped = `(function () {\n${code}\n}).call(window);`;
  const transpiled = transform(wrapped, {
    presets: [["env", { modules: false, targets: { ie: "11" }, useBuiltIns: false }]],
    sourceType: "script",
    comments: false,
    compact: true,
  }).code;
  if (!transpiled) throw new Error("script transpilation produced no code");

  const interpreter = new Interpreter(window, {
    timeout: EVALUATION_TIMEOUT_MS,
    globalContextInFunction: window,
  });
  return interpreter.evaluate(transpiled);
}

window.__zenExtMcpEvaluate = evaluate;
