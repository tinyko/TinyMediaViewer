import type { PropsWithChildren, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";

export const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 5 * 60 * 1000,
        staleTime: 60 * 1000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

export const createQueryClientWrapper = (client = createTestQueryClient()) =>
  function QueryClientWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

export const renderWithQueryClient = (
  ui: ReactNode,
  client = createTestQueryClient()
) => ({
  client,
  ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
});
