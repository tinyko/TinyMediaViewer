import { renderHook, waitFor } from "@testing-library/react";
import { useCategorySelectionCoordinator } from "./useCategorySelectionCoordinator";

describe("useCategorySelectionCoordinator", () => {
  it("falls back to the first visible account when the restored category is filtered out", async () => {
    const handleSelectCategory = vi.fn().mockResolvedValue(undefined);
    const resetCategory = vi.fn();
    type Props = {
      viewerPreferencesHydrated: boolean;
      preferredInitialCategoryPath: string | null;
      filteredAccountPaths: string[];
      categoryPath: string | null;
      rootVersion: number;
    };
    const { rerender } = renderHook<void, Props>(
      (props: Props) =>
        useCategorySelectionCoordinator({
          ...props,
          handleSelectCategory,
          resetCategory,
        }),
      {
        initialProps: {
          viewerPreferencesHydrated: true,
          preferredInitialCategoryPath: "beta",
          filteredAccountPaths: ["beta", "alpha"],
          categoryPath: null,
          rootVersion: 0,
        },
      }
    );

    await waitFor(() => {
      expect(handleSelectCategory).toHaveBeenCalledWith("beta");
    });

    handleSelectCategory.mockClear();
    rerender({
      viewerPreferencesHydrated: true,
      preferredInitialCategoryPath: "beta",
      filteredAccountPaths: ["alpha"],
      categoryPath: "beta",
      rootVersion: 1,
    });

    await waitFor(() => {
      expect(handleSelectCategory).toHaveBeenCalledWith("alpha");
    });
    expect(resetCategory).not.toHaveBeenCalled();
  });
});
