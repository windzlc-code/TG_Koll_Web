import { useEffect, useState, type CSSProperties } from "react";

export const SLIDE_MS = 180;
export const SLIDE_EASE = "cubic-bezier(.2, .72, .2, 1)";

type SlideStyle = Record<string, string>;

export type SegmentSlide = {
  phase: "from" | "to";
  fromIndex: number;
  toIndex: number;
  fromStyle: SlideStyle;
  toStyle: SlideStyle;
};

let pageSlideAnimation: Animation | null = null;

export function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function relativeBox(group: HTMLElement, item: HTMLElement) {
  const groupRect = group.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  return {
    left: itemRect.left - groupRect.left - group.clientLeft + group.scrollLeft,
    top: itemRect.top - groupRect.top - group.clientTop + group.scrollTop,
    width: itemRect.width,
    height: itemRect.height,
  };
}

function boxStyle(box: { left: number; top: number; width: number; height: number }, colors: SlideStyle): SlideStyle {
  return {
    ...colors,
    "--segment-slide-x": `${box.left}px`,
    "--segment-slide-y": `${box.top}px`,
    "--segment-slide-width": `${box.width}px`,
    "--segment-slide-height": `${box.height}px`,
  };
}

export function captureSegmentSlide(group: HTMLElement, fromButton: HTMLElement, toButton: HTMLElement): SegmentSlide | null {
  if (fromButton === toButton || prefersReducedMotion()) return null;
  const buttons = [...group.querySelectorAll<HTMLElement>(":scope > button")];
  const fromIndex = buttons.indexOf(fromButton);
  const toIndex = buttons.indexOf(toButton);
  if (fromIndex < 0 || toIndex < 0) return null;
  const activeStyle = getComputedStyle(fromButton);
  const inactiveStyle = getComputedStyle(toButton);
  const colors: SlideStyle = {
    "--segment-slide-background": activeStyle.background,
    "--segment-slide-border": activeStyle.borderColor,
    "--segment-slide-radius": activeStyle.borderRadius,
    "--segment-slide-shadow": activeStyle.boxShadow,
    "--segment-slide-active-color": activeStyle.color,
    "--segment-slide-inactive-color": inactiveStyle.color,
  };
  return {
    phase: "from",
    fromIndex,
    toIndex,
    fromStyle: boxStyle(relativeBox(group, fromButton), colors),
    toStyle: boxStyle(relativeBox(group, toButton), colors),
  };
}

export function slideGroupClass(base: string, slide: SegmentSlide | null) {
  return slide ? `${base} is-segment-background-sliding is-segment-slide-positioned` : base;
}

export function slideGroupStyle(slide: SegmentSlide | null, extra?: CSSProperties): CSSProperties {
  const vars = slide ? (slide.phase === "from" ? slide.fromStyle : slide.toStyle) : undefined;
  return { ...extra, ...vars } as CSSProperties;
}

export function slideButtonClass(slide: SegmentSlide | null, index: number, active = false) {
  return [
    active ? "is-active" : "",
    slide?.fromIndex === index ? "is-segment-slide-from" : "",
    slide?.toIndex === index ? "is-segment-slide-to" : "",
  ].filter(Boolean).join(" ");
}

export function useSegmentSlide() {
  const [slide, setSlide] = useState<SegmentSlide | null>(null);

  useEffect(() => {
    if (!slide) return;
    if (slide.phase === "from") {
      const frame = window.requestAnimationFrame(() => {
        setSlide((current) => (current && current.phase === "from" ? { ...current, phase: "to" } : current));
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(() => setSlide(null), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [slide]);

  const start = (group: HTMLElement | null, fromButton: HTMLElement | null, toButton: HTMLElement | null) => {
    if (!group || !fromButton || !toButton) return;
    setSlide(captureSegmentSlide(group, fromButton, toButton));
  };

  return {
    slide,
    start,
    groupClass: (base: string) => slideGroupClass(base, slide),
    groupStyle: (extra?: CSSProperties) => slideGroupStyle(slide, extra),
    buttonClass: (index: number, active = false) => slideButtonClass(slide, index, active),
  };
}

export function animatePageSlide(node: HTMLElement | null, direction: number) {
  if (!node || !direction || prefersReducedMotion() || typeof node.animate !== "function") return;
  const distance = Math.min(56, Math.max(32, Math.round(window.innerWidth * 0.12)));
  pageSlideAnimation?.cancel();
  const animation = node.animate(
    [
      { transform: `translate3d(${direction * distance}px, 0, 0)` },
      { transform: "translate3d(0, 0, 0)" },
    ],
    { duration: SLIDE_MS, easing: SLIDE_EASE },
  );
  pageSlideAnimation = animation;
  animation.finished.catch(() => {}).finally(() => {
    if (pageSlideAnimation === animation) pageSlideAnimation = null;
  });
}

export function navigationDirection(buttons: HTMLElement[], current: HTMLElement | null, target: HTMLElement | null) {
  const currentIndex = current ? buttons.indexOf(current) : -1;
  const targetIndex = target ? buttons.indexOf(target) : -1;
  if (currentIndex < 0 || targetIndex < 0 || currentIndex === targetIndex) return 0;
  return targetIndex > currentIndex ? 1 : -1;
}
