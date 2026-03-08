import { render } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { useAppInteractions } from "./useAppInteractions";
import type { MediaItem } from "../../types";

const mediaItem: MediaItem = {
  name: "IMG_20260101_120000.jpg",
  path: "account/IMG_20260101_120000.jpg",
  url: "/media/account/IMG_20260101_120000.jpg",
  kind: "image",
  size: 1234,
  modified: Date.now(),
};

function Harness({ selected }: { selected: MediaItem | null }) {
  const previewScrollRef = useRef<HTMLDivElement | null>(null) as RefObject<HTMLDivElement | null>;

  useAppInteractions({
    selected,
    effectsEnabled: false,
    previewScrollRef,
    resetRootPreviewQueue: () => undefined,
    scrollTrackingKey: "",
  });

  return <div ref={previewScrollRef} />;
}

describe("useAppInteractions", () => {
  it("locks document scrolling while the preview modal is open and restores it on close", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 240,
    });
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    document.body.style.overflow = "clip";
    document.documentElement.style.overflow = "clip";

    const { rerender, unmount } = render(<Harness selected={mediaItem} />);

    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.top).toBe("-240px");
    expect(document.body.style.left).toBe("0px");
    expect(document.body.style.right).toBe("0px");
    expect(document.body.style.width).toBe("100%");
    expect(document.body.style.overscrollBehavior).toBe("none");
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overscrollBehavior).toBe("none");

    rerender(<Harness selected={null} />);

    expect(document.body.style.overflow).toBe("clip");
    expect(document.body.style.position).toBe("");
    expect(document.body.style.top).toBe("");
    expect(document.body.style.left).toBe("");
    expect(document.body.style.right).toBe("");
    expect(document.body.style.width).toBe("");
    expect(document.body.style.overscrollBehavior).toBe("");
    expect(document.documentElement.style.overflow).toBe("clip");
    expect(document.documentElement.style.overscrollBehavior).toBe("");
    expect(scrollTo).toHaveBeenCalledWith({ top: 240, behavior: "auto" });

    unmount();
  });
});
