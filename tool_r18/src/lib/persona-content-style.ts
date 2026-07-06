import type { DramaSetup } from "@/types/drama";

export function usesJinjunyaFreeContentStyle(setup?: Partial<DramaSetup> | null): boolean {
  const explicit = String(setup?.freePostTemplate || "").trim().toLowerCase();
  if (explicit) return explicit === "jinjunya-hook";
  const rawMarkers = [
    String(setup?.personaName || ""),
    String(setup?.personaDescription || ""),
    String(setup?.contentTheme || ""),
    String(setup?.tweetStyleLinkUrl || ""),
  ].join(" ");
  const normalized = rawMarkers.toLowerCase();
  return rawMarkers.includes("金君雅")
    || normalized.includes("jinjunya")
    || normalized.includes("gy_night_flight_bot");
}

export function resolvePersonaFreeContentTargetWords(setup?: Partial<DramaSetup> | null): number {
  return usesJinjunyaFreeContentStyle(setup) ? 20 : 120;
}
