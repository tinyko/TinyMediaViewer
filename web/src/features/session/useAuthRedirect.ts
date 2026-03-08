import { useEffect, useRef } from "react";

export function useAuthRedirect(requiresAuth: boolean) {
  const authRedirectedRef = useRef(false);

  useEffect(() => {
    if (!requiresAuth) {
      authRedirectedRef.current = false;
      return;
    }
    if (authRedirectedRef.current) return;
    authRedirectedRef.current = true;
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`/__tmv/login?returnTo=${encodeURIComponent(returnTo || "/")}`);
  }, [requiresAuth]);
}
