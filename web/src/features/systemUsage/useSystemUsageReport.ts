import { useQuery } from "@tanstack/react-query";
import { fetchSystemUsage } from "../../api";

const DEFAULT_SYSTEM_USAGE_LIMIT = 10;

export function useSystemUsageReport(enabled: boolean, limit = DEFAULT_SYSTEM_USAGE_LIMIT) {
  return useQuery({
    queryKey: ["system-usage", limit],
    queryFn: () => fetchSystemUsage(limit),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
