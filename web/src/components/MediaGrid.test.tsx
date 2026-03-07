import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MediaGrid } from "./MediaGrid";

const videoItem = {
  name: "clip.mp4",
  path: "account/clip.mp4",
  url: "/media/account/clip.mp4",
  thumbnailUrl: "/thumb/account/clip.mp4?m=123",
  kind: "video" as const,
  size: 1024,
  modified: 123,
};

const imageItem = {
  name: "poster.jpg",
  path: "account/poster.jpg",
  url: "/media/account/poster.jpg",
  thumbnailUrl: "/thumb/account/poster.jpg?m=456",
  kind: "image" as const,
  size: 2048,
  modified: 456,
};

describe("MediaGrid", () => {
  it("renders video thumbnails first and falls back to video on image load failure", () => {
    render(
      <MediaGrid
        items={[videoItem]}
        totalFilteredCount={1}
        hasMore={false}
        loadingMore={false}
        categoryPath="account"
        scrollRef={createRef<HTMLDivElement>()}
        hoveredCardRef={createRef<HTMLButtonElement>()}
        onSelect={() => undefined}
        onReachEnd={() => undefined}
        onVisibleCardsChange={() => undefined}
      />
    );

    const thumbnail = screen.getByAltText("clip.mp4");
    expect(thumbnail).toHaveAttribute("src", videoItem.thumbnailUrl);

    fireEvent.error(thumbnail);

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toContain("/media/account/clip.mp4#t=0.001");
  });

  it("renders image thumbnails first and falls back to the original image on failure", () => {
    render(
      <MediaGrid
        items={[imageItem]}
        totalFilteredCount={1}
        hasMore={false}
        loadingMore={false}
        categoryPath="account"
        scrollRef={createRef<HTMLDivElement>()}
        hoveredCardRef={createRef<HTMLButtonElement>()}
        onSelect={() => undefined}
        onReachEnd={() => undefined}
        onVisibleCardsChange={() => undefined}
      />
    );

    const thumbnail = screen.getByAltText("poster.jpg");
    expect(thumbnail).toHaveAttribute("src", imageItem.thumbnailUrl);

    fireEvent.error(thumbnail);

    expect(screen.getByAltText("poster.jpg")).toHaveAttribute("src", imageItem.url);
  });
});
