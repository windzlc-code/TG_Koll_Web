import "@/runtime/node/browser-shim";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";
import { runPersonaWorkflow, type PersonaWorkflowInput } from "@/core/persona/persona-workflow-service";

installNodePersonaArchiveBridge();

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    printJson({ ok: false, error: "missing JSON input" });
    process.exitCode = 1;
    return;
  }

  const input = JSON.parse(raw) as PersonaWorkflowInput;
  const result = await runPersonaWorkflow(input);
  printJson(result);
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
