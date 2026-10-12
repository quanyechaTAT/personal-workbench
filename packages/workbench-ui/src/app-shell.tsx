import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { Icons } from "./icons.tsx";

const primary = [
	{ to: "/", label: "首页", icon: Icons.Home },
	{ to: "/chat", label: "对话", icon: Icons.Chat },
	{ to: "/assistants", label: "助手", icon: Icons.Spark },
	{ to: "/projects", label: "项目", icon: Icons.Project },
	{ to: "/tasks", label: "任务", icon: Icons.Task },
];

const resources = [
	{ to: "/memory", label: "记忆", icon: Icons.Memory },
	{ to: "/skills", label: "技能", icon: Icons.Skill },
	{ to: "/connections", label: "连接", icon: Icons.Tool },
	{ to: "/files", label: "文件", icon: Icons.File },
];

function NavigationGroup({ items }: { items: typeof primary }) {
	return (
		<nav className="nav-group">
			{items.map((item) => (
				<NavLink
					key={item.to}
					to={item.to}
					aria-label={item.label}
					title={item.label}
					end={item.to === "/"}
					className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
				>
					<item.icon />
					<span>{item.label}</span>
				</NavLink>
			))}
		</nav>
	);
}

export function AppShell() {
	const { pathname } = useLocation();
	const chatting = pathname === "/chat" || /^\/projects\/[^/]+\/chat\/?$/.test(pathname);
	const [dark, setDark] = useState(() => localStorage.getItem("workbench-theme") === "dark");
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	const toggleTheme = () => {
		const next = !dark;
		setDark(next);
		localStorage.setItem("workbench-theme", next ? "dark" : "light");
	};
	return (
		<div className={`app-shell${chatting ? " chat-shell" : ""}`}>
			<aside className="main-sidebar">
				<div className="brand">
					<div className="brand-mark">
						<Icons.Spark />
					</div>
					<div>
						<strong>个人工作台</strong>
					</div>
				</div>
				<NavigationGroup items={primary} />
				<div className="nav-divider" />
				<NavigationGroup items={resources} />
				<div className="sidebar-spacer" />
				<NavLink
					to="/settings"
					aria-label="设置"
					title="设置"
					className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
				>
					<Icons.Settings />
					<span>设置</span>
				</NavLink>
				<button
					type="button"
					className="theme-button"
					onClick={toggleTheme}
					aria-label="切换主题"
					title={dark ? "切换为亮色主题" : "切换为暗色主题"}
				>
					{dark ? <Icons.Sun /> : <Icons.Moon />}
					<span>{dark ? "亮色主题" : "暗色主题"}</span>
				</button>
			</aside>
			<main className="main-content">
				<Outlet />
			</main>
		</div>
	);
}
