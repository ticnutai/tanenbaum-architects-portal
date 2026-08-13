import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();
  const basepath = typeof window !== "undefined" && window.location.pathname.startsWith("/app")
    ? "/app"
    : "/";

  const router = createRouter({
    routeTree,
    basepath,
    context: { queryClient },
    // TanStack scroll restoration can wedge Electron's renderer while moving
    // from the workflow/recorder pages to the log page. Native scrolling is
    // sufficient here and keeps repeated SPA navigation responsive.
    scrollRestoration: false,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
