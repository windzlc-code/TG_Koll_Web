import { execFile } from "node:child_process";

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    process.stdout.write(JSON.stringify({ ok: false, error: "missing JSON input" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const { prompt, archiveId } = JSON.parse(raw) as { prompt: string; archiveId: string };

  const shell = [
    "cd /opt/Automatic-script",
    "unset OPENAI_API_KEY",
    "unset OPENAI_BASE_URL",
    `npm run skill:persona -- '${JSON.stringify({ action: "generate-posts", archiveId, count: 3, customInstruction: prompt })}'`,
  ].join(" && ");

  await new Promise<void>((resolve) => {
    execFile("sh", ["-lc", shell], {
      timeout: 180_000,
      env: {
        ...process.env,
        MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || "",
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
      },
    }, (error, stdout, stderr) => {
      if (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: stderr || error.message }, null, 2));
      } else {
        process.stdout.write(stdout);
      }
      resolve();
    });
  });
}

main();
