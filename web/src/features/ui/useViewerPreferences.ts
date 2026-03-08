import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchViewerPreferences,
  postViewerPreferences,
} from "../../api";
import type { ViewerPreferences } from "../../types";

const VIEWER_PREFERENCES_QUERY_KEY = ["viewer-preferences"] as const;

export function useViewerPreferences() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: VIEWER_PREFERENCES_QUERY_KEY,
    queryFn: fetchViewerPreferences,
  });
  const mutation = useMutation({
    mutationFn: (preferences: ViewerPreferences) => postViewerPreferences(preferences),
    onSuccess: (saved) => {
      queryClient.setQueryData(VIEWER_PREFERENCES_QUERY_KEY, saved);
    },
  });

  const persist = useCallback(
    (preferences: ViewerPreferences) => {
      mutation.mutate(preferences);
    },
    [mutation]
  );

  return {
    ...query,
    persist,
    persistError: mutation.error,
    isPersisting: mutation.isPending,
  };
}
