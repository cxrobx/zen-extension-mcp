#!/usr/bin/env node

for (const required of ["--safe-mode", "--tools", "--no-session-persistence", "--json-schema"]) {
  if (!process.argv.includes(required)) {
    process.stderr.write(`missing required distiller flag: ${required}\n`);
    process.exit(2);
  }
}
if (!process.cwd().split("/").pop()?.startsWith("zen-nav-distill-")) {
  process.stderr.write("distiller did not use an isolated working directory\n");
  process.exit(2);
}

process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    structured_output: {
      notes: [
        {
          kind: "tool-tip",
          summary: "The fixture form uses a stable email locator.",
          detail: "The input is consistently available through its structural name attribute.",
          example: "css:input[name=email]",
          tools: ["fill"],
          success: true,
          confidence: 0.6,
        },
      ],
    },
  }));
});
