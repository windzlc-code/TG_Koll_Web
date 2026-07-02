import type { DramaSetup } from "@/types/drama";
import { usesJinjunyaFreeContentStyle } from "@/lib/workflow-personas";

export function buildPersonaPaidCaptionToneGuide(setup?: Partial<DramaSetup> | null): string[] {
  if (!usesJinjunyaFreeContentStyle(setup)) return [];
  return [
    "[Jinjunya paid caption tone]",
    "Write in short, natural Traditional Chinese.",
    "Sound like a real person reacting to one concrete thing in the image, not a report.",
    "Keep one visual anchor from the image, such as camera angle, raised hand, window light, bed edge, blinds, chair, collar, skirt line, or loose fabric.",
    "Prefer the most distinctive anchor in the frame; do not default to light if angle, pose, or gesture is stronger.",
    "Use paid-group teaser direction, but keep it spoken and casual.",
    "Prefer a structure like: emotion hook + visual anchor + light trailing beat.",
    "Example tone: 這個角度真的有點太犯規了 / 手一抬起來，整個氣氛都變了 / 窗邊這樣一側過來，真的很難不多看。",
    "Do not use second-person direct address such as 你 or 妳.",
    "Do not output dry anatomy lists, prompt summaries, or scene reports.",
  ];
}

export function isMechanicalPaidCaption(text: string): boolean {
  const body = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^https?:\/\//i.test(line))
    .join(" ");
  if (!body) return false;

  const anatomyMatches = body.match(/胸口|胸前|乳暈|乳頭|大腿|腿根|私處|臀線/gi) || [];
  const hasMechanicalVerb = /清晰可見|自然清晰|完整露出|完全敞開|全部露出|露出來了|透出來了/gi.test(body);
  const hasListyStructure = /[，、].*(胸口|胸前|乳暈|乳頭|大腿|腿根|私處|臀線)/i.test(body);
  const hasColloquialBeat = /真的|有點|這個|這套|這身|這張|快要|差點|根本|太犯規|不太對|不乖|難不成|很會/i.test(body);
  const hasVisualAnchor = /角度|鏡頭|抬手|側身|回頭|窗邊|床邊|百葉窗|椅子|光線|領口|裙擺|布料|絲襪|外套|襯衫/i.test(body);

  if (anatomyMatches.length >= 2 && !hasColloquialBeat) return true;
  if (hasMechanicalVerb && hasListyStructure && !hasVisualAnchor) return true;
  return false;
}
