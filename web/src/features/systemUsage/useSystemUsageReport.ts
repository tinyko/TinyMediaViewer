import { useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSystemUsage } from "../../api";

const DEFAULT_SYSTEM_USAGE_LIMIT = 10;

export function useSystemUsageReport(enabled: boolean, limit = DEFAULT_SYSTEM_USAGE_LIMIT) {
  const forceRefreshRef = useRef(false);
  const query = useQuery({
    queryKey: ["system-usage", limit],
    queryFn: () => fetchSystemUsage(limit, { refresh: forceRefreshRef.current }),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(() => {
    forceRefreshRef.current = true;
    void query.refetch().finally(() => {
      forceRefreshRef.current = false;
    });
  }, [query]);

  return {
    ...query,
    refresh,
  };
}
