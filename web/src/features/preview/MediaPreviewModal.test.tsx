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
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onPrev).toHaveBeenCalledTimes(2);
    expect(onNext).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
