import { createBrowserRouter, RouterProvider } from "react-router";
import { AppShell } from "./app-shell.tsx";
import { AssistantDraftWizard } from "./assistant-draft-wizard.tsx";
import { AssistantEditor } from "./assistant-editor.tsx";
import { AssistantsPage } from "./assistants-page.tsx";
import { ChatPage } from "./chat-page.tsx";
import { ConnectionsPage } from "./connections-page.tsx";
import { FilesPage } from "./files-page.tsx";
import { HomePage } from "./home-page.tsx";
import { MemoryPage } from "./memory-page.tsx";
import {
	ProjectChat,
	ProjectFilesRoute,
	ProjectKnowledge,
	ProjectLayout,
	ProjectMemory,
	ProjectOverview,
	ProjectsPage,
	ProjectTasks,
} from "./projects-page.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { SkillsPage } from "./skills-page.tsx";
import { TasksPage } from "./tasks-page.tsx";

const router = createBrowserRouter([
	{
		path: "/",
		element: <AppShell />,
		errorElement: <RouteError />,
		children: [
			{ index: true, element: <HomePage /> },
			{ path: "chat", element: <ChatPage /> },
			{ path: "assistants", element: <AssistantsPage /> },
			{ path: "assistants/new", element: <AssistantEditor /> },
			{ path: "assistants/generate", element: <AssistantDraftWizard /> },
			{ path: "assistants/:profileId", element: <AssistantEditor /> },
			{ path: "connections", element: <ConnectionsPage /> },
			{ path: "projects", element: <ProjectsPage /> },
			{
				path: "projects/:projectId",
				element: <ProjectLayout />,
				children: [
					{ index: true, element: <ProjectOverview /> },
					{ path: "chat", element: <ProjectChat /> },
					{ path: "tasks", element: <ProjectTasks /> },
					{ path: "files", element: <ProjectFilesRoute /> },
					{ path: "memory", element: <ProjectMemory /> },
					{ path: "knowledge", element: <ProjectKnowledge /> },
				],
			},
			{ path: "tasks", element: <TasksPage /> },
			{ path: "memory", element: <MemoryPage /> },
			{ path: "skills", element: <SkillsPage /> },
			{ path: "files", element: <FilesPage /> },
			{ path: "settings", element: <SettingsPage /> },
		],
	},
]);

export function App() {
	return <RouterProvider router={router} />;
}

function RouteError() {
	return (
		<section className="page-container">
			<h1>页面暂时无法显示</h1>
			<p>请重新加载页面。若仍然出现问题，请重启工作台并查看开发者日志。</p>
			<a className="button primary" href="/">
				返回首页
			</a>
		</section>
	);
}
