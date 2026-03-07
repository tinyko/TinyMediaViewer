import { fireEvent, render, screen } from "@testing-library/react";
import { MediaPreviewModal } from "./MediaPreviewModal";

const mediaItem = {
  name: "IMG_20260101_120000.jpg",
  path: "account/IMG_20260101_120000.jpg",
  url: "/media/account/IMG_20260101_120000.jpg",
  kind: "image" as const,
  size: 1234,
  modified: Date.now(),
};

describe("MediaPreviewModal", () => {
  it("does not render when media is null", () => {
    render(
      <MediaPreviewModal
        media={null}
        onClose={() => undefined}
        onPrev={() => undefined}
        onNext={() => undefined}
        hasPrev={false}
        hasNext={false}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("triggers prev/next handlers by buttons and keyboard", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onClose = vi.fn();

    render(
      <MediaPreviewModal
        media={mediaItem}
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev
        hasNext
      />
    );

    fireEvent.click(screen.getByLabelText("上一张"));
    fireEvent.click(screen.getByLabelText("下一张"));

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onPrev).toHaveBeenCalledTimes(2);
    expect(onNext).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses pointer gesture only when PointerEvent is supported", () => {
    const onNext = vi.fn();

    render(
      <MediaPreviewModal
        media={mediaItem}
        onClose={() => undefined}
        onPrev={() => undefined}
        onNext={onNext}
        hasPrev={false}
        hasNext
      />
    );

    const content = document.querySelector(".modal__content");
    expect(content).not.toBeNull();
    if (!content) return;

    fireEvent.touchStart(content, { touches: [{ clientX: 200, clientY: 0 }] });
    fireEvent.touchEnd(content, { changedTouches: [{ clientX: 100, clientY: 0 }] });
    fireEvent.pointerDown(content, { pointerType: "touch", pointerId: 7, clientX: 200, clientY: 0 });
    fireEvent.pointerUp(content, { pointerType: "touch", pointerId: 7, clientX: 100, clientY: 0 });

    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("enables loop for video preview", () => {
    const { rerender } = render(
      <MediaPreviewModal
        media={{ ...mediaItem, kind: "video", path: "a.mp4", name: "a.mp4", url: "/a.mp4" }}
        onClose={() => undefined}
        onPrev={() => undefined}
        onNext={() => undefined}
        hasPrev={false}
        hasNext={false}
      />
    );

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("loop");
    expect(video?.getAttribute("src")).toContain("/a.mp4?v=");

    rerender(
      <MediaPreviewModal
        media={{ ...mediaItem, kind: "video", path: "b.mp4", name: "b.mp4", url: "/b.mp4" }}
        onClose={() => undefined}
        onPrev={() => undefined}
        onNext={() => undefined}
        hasPrev={false}
        hasNext={false}
      />
    );

    const nextVideo = document.querySelector("video");
    expect(nextVideo).not.toBeNull();
    expect(nextVideo?.getAttribute("src")).toContain("/b.mp4?v=");
  });
});
