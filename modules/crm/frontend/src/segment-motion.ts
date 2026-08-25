import { useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { dockPillBox, resolveSegmentSlideAction, SLIDE_EASE, SLIDE_MS } from "./segment-motion-policy.js";

export { dockPillBox, resolveSegmentSlideAction, SLIDE_EASE, SLIDE_MS };
export type SegmentSlideAction = "skip" | "coalesce" | "start";

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

export function applyDockPill(dock: HTMLElement | null, pill: HTMLElement | null, index: number, instant = false) {
  if (!dock || !pill) return null;
  const buttons = [...dock.querySelectorAll<HTMLElement>(".crm-mobile-dock-items > button, :scope > button")];
  const button = buttons[index];
  if (!button) return null;
  const dockRect = dock.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const box = dockPillBox(
    { left: buttonRect.left, top: buttonRect.top, width: buttonRect.width, height: buttonRect.height },
    {
      left: dockRect.left,
      top: dockRect.top,
      clientLeft: dock.clientLeft,
      clientTop: dock.clientTop,
      scrollLeft: dock.scrollLeft,
      scrollTop: dock.scrollTop,
    },
  );
  pill.style.left = "0px";
  pill.style.top = "0px";
  pill.style.width = `${box.width}px`;
  pill.style.height = `${box.height}px`;
  pill.getAnimations().forEach((animation) => animation.cancel());
  pill.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
  return box;
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

function capturedFill(style: CSSStyleDeclaration) {
  const image = style.backgroundImage;
  const color = style.backgroundColor;
  const transparent = !color || color === "transparent" || color === "rgba(0, 0, 0, 0)";
  if (image && image !== "none") return transparent ? image : `${color} ${image}`.trim();
  if (!transparent) return color;
  return "var(--public-action-gradient, linear-gradient(#253746, #253746))";
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
    "--segment-slide-background": capturedFill(activeStyle),
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
  return slide ? `${base} is-segment-background-sliding` : base;
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
  const slideRef = useRef<SegmentSlide | null>(null);
  const commitFrame = useRef(0);
  const commitToken = useRef(0);
  slideRef.current = slide;

  useEffect(() => {
    if (slide?.phase !== "to") return;
    const timer = window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        setSlide((current) => (current?.phase === "to" ? null : current));
      });
    }, SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [slide]);

  const start = (
    group: HTMLElement | null,
    fromButton: HTMLElement | null,
    toButton: HTMLElement | null,
    commit?: () => void,
  ): SegmentSlideAction => {
    const token = ++commitToken.current;
    const runCommit = () => {
      if (token !== commitToken.current) return;
      commit?.();
    };
    const buttons = group ? [...group.querySelectorAll<HTMLElement>(":scope > button")] : [];
    const action = resolveSegmentSlideAction({
      fromIndex: fromButton && group ? buttons.indexOf(fromButton) : -1,
      toIndex: toButton && group ? buttons.indexOf(toButton) : -1,
      pending: Boolean(slideRef.current),
      reducedMotion: prefersReducedMotion(),
    });
    if (action === "skip") {
      runCommit();
      return action;
    }
    if (action === "coalesce") {
      if (commitFrame.current) window.cancelAnimationFrame(commitFrame.current);
      commitFrame.current = window.requestAnimationFrame(() => {
        commitFrame.current = 0;
        runCommit();
      });
      return action;
    }
    const captured = group && fromButton && toButton ? captureSegmentSlide(group, fromButton, toButton) : null;
    if (!captured || !group) {
      runCommit();
      return "skip";
    }
    flushSync(() => setSlide(captured));
    void group.offsetWidth;
    commitFrame.current = window.requestAnimationFrame(() => {
      commitFrame.current = 0;
      setSlide((current) => (current && current.phase === "from" ? { ...current, phase: "to" } : current));
      runCommit();
    });
    return action;
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
  if (!window.matchMedia("(max-width: 980px)").matches) return;
  pageSlideAnimation?.cancel();
  const animation = node.animate(
    [
      { transform: `translate3d(${direction * 100}%, 0, 0)` },
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
