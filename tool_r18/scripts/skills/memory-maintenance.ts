import {
  buildMemoryOutline,
  buildMemoryThumbnail,
  formatMemoryEntriesForPrompt,
  type MemoryEntryPreview,
} from "@/core/memory/memory-format";

interface MemoryMaintenanceInput {
  action: "outline" | "thumbnail" | "format";
  text?: string;
  entries?: MemoryEntryPreview[];
  limit?: number;
}

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

  const input = JSON.parse(raw) as MemoryMaintenanceInput;

  if (input.action === "outline") {
    printJson({ ok: true, outline: buildMemoryOutline(input.text || "") });
    return;
  }

  if (input.action === "thumbnail") {
    printJson({ ok: true, thumbnail: buildMemoryThumbnail(input.text || "") });
    return;
  }

  if (input.action === "format") {
    printJson({ ok: true, text: formatMemoryEntriesForPrompt(input.entries || [], input.limit || 12) });
    return;
  }

  printJson({ ok: false, error: `unsupported action: ${input.action}` });
  process.exitCode = 1;
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
