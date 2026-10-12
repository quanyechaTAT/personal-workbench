import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("个人工作台页面缺少挂载元素");

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
	},
});

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</StrictMode>,
);
