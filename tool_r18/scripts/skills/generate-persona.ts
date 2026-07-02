import { getRuntimeApiConfigForProtocol } from "@/runtime/node/config";
import {
  buildCharactersPrompt,
  buildEpisodePrompt,
  buildOutlinePrompt,
  buildSocialPostsPrompt,
} from "@/lib/drama-prompts";
import type { DramaSetup } from "@/types/drama";

export interface GeneratePersonaScriptInput {
  setup: DramaSetup;
  creativePlan?: string;
  characters?: string;
  personaContent?: string;
  episodes?: { number: number; title: string; summary: string; hookType: string }[];
  allDirectoryRaw?: string;
  outline?: string;
  episodeTitle?: string;
  count?: number;
  customInstruction?: string;
  dryRun?: boolean;
  configPath?: string;
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

  const input = JSON.parse(raw) as GeneratePersonaScriptInput;
  const setup = input.setup;
  const protocol = "gemini";
  const api = getRuntimeApiConfigForProtocol(protocol, { configPath: input.configPath });

  const result = {
    ok: true,
    dryRun: input.dryRun !== false,
    apiConfigured: Boolean(api.apiKey),
    prompts: {
      characters: buildCharactersPrompt(setup),
      outline: buildOutlinePrompt(
        setup,
        input.creativePlan || "",
        input.characters || input.personaContent || "",
        input.episodes || [{ number: 1, title: input.episodeTitle || "第1篇", summary: input.outline || "", hookType: "懸念鉤" }],
        input.allDirectoryRaw || "",
      ),
      socialPosts: buildSocialPostsPrompt(
        setup,
        input.personaContent || input.characters || "",
        input.count || 3,
        input.customInstruction,
      ),
      episode: buildEpisodePrompt(
        setup,
        input.characters || input.personaContent || "",
        input.episodes || [{ number: 1, title: input.episodeTitle || "第1篇", summary: input.outline || "", hookType: "懸念鉤" }],
        1,
        "",
      ),
    },
  };

  printJson(result);
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
