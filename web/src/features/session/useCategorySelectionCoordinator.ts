import { useEffect, useRef } from "react";

interface UseCategorySelectionCoordinatorOptions {
  viewerPreferencesHydrated: boolean;
  preferredInitialCategoryPath: string | null;
  filteredAccountPaths: string[];
  categoryPath: string | null;
  rootVersion: number;
  handleSelectCategory: (path: string) => Promise<void>;
  resetCategory: () => void;
}

export function useCategorySelectionCoordinator({
  viewerPreferencesHydrated,
  preferredInitialCategoryPath,
  filteredAccountPaths,
  categoryPath,
  rootVersion,
  handleSelectCategory,
  resetCategory,
}: UseCategorySelectionCoordinatorOptions) {
  const initialCategoryRestoreAttemptedRef = useRef(false);

  useEffect(() => {
    if (!viewerPreferencesHydrated || initialCategoryRestoreAttemptedRef.current) {
      return;
    }
    if (!filteredAccountPaths.length) {
      return;
    }

    initialCategoryRestoreAttemptedRef.current = true;
    if (
      preferredInitialCategoryPath &&
      filteredAccountPaths.includes(preferredInitialCategoryPath)
    ) {
      if (categoryPath !== preferredInitialCategoryPath) {
        void handleSelectCategory(preferredInitialCategoryPath);
      }
      return;
    }

    if (!categoryPath || !filteredAccountPaths.includes(categoryPath)) {
      void handleSelectCategory(filteredAccountPaths[0]);
    }
  }, [
    categoryPath,
    filteredAccountPaths,
    handleSelectCategory,
    preferredInitialCategoryPath,
    viewerPreferencesHydrated,
  ]);

  useEffect(() => {
    if (viewerPreferencesHydrated && !initialCategoryRestoreAttemptedRef.current) {
      return;
    }
    if (rootVersion === 0) {
      return;
    }
    if (!filteredAccountPaths.length) {
      if (categoryPath) {
        resetCategory();
      }
      return;
    }
    if (!categoryPath) {
      void handleSelectCategory(filteredAccountPaths[0]);
      return;
    }
    if (filteredAccountPaths.includes(categoryPath)) {
      return;
    }
    void handleSelectCategory(filteredAccountPaths[0]);
  }, [
    categoryPath,
    filteredAccountPaths,
    handleSelectCategory,
    resetCategory,
    rootVersion,
    viewerPreferencesHydrated,
  ]);
}
