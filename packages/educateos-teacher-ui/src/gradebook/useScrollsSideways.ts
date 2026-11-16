import { useEffect, useState, type RefObject } from "react";

/**
 * Whether the element `ref` holds is narrower than its content, so it scrolls sideways. Rechecked
 * whenever the element or its content changes size; false where the browser cannot tell.
 */
export const useScrollsSideways = (ref: RefObject<HTMLElement | null>): boolean => {
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const check = () => setScrolls(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    check();
    return () => observer.disconnect();
  }, [ref]);
  return scrolls;
};
