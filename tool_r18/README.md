# Tool R18

Tool R18 is the local runtime for persona content generation, media generation,
memory maintenance, and Web console queue management.

## Available scripts

```sh
npm run skill:generate-persona
npm run skill:generate-persona-images
npm run skill:memory
npm run skill:publish-queue
npm run skill:verify-path
npm run skill:persona
npm run skill:persona-generate-by-id
```

Publishing is handled by the Web social automation worker using Camoufox
persistent browser profiles. The queue schema still keeps existing target
fields for data compatibility with archived personas, pending tasks, and
dashboard filters.
