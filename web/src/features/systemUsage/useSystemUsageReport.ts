import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSystemUsage } from "../../api";

const DEFAULT_SYSTEM_USAGE_LIMIT = 10;

export function useSystemUsageReport(enabled: boolean, limit = DEFAULT_SYSTEM_USAGE_LIMIT) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const query = useQuery({
    queryKey: ["system-usage", limit, refreshNonce],
    queryFn: () => fetchSystemUsage(limit, { refresh: refreshNonce > 0 }),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  return {
    ...query,
    refresh,
  };
}
