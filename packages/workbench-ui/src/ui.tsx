import type { ReactNode } from "react";
import { Icons } from "./icons.tsx";
import { label } from "./labels.ts";

export function PageHeader({
	eyebrow,
	title,
	description,
	actions,
}: {
	eyebrow?: string;
	title: string;
	description?: string;
	actions?: ReactNode;
}) {
	return (
		<header className="page-header">
			<div>
				{eyebrow && <div className="eyebrow">{eyebrow}</div>}
				<h1>{title}</h1>
				{description && <p>{description}</p>}
			</div>
			{actions && <div className="header-actions">{actions}</div>}
		</header>
	);
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
	return (
		<div className="empty-state">
			<div className="empty-icon" aria-hidden="true">
				<Icons.Spark />
			</div>
			<h3>{title}</h3>
			<p>{description}</p>
			{action}
		</div>
	);
}

export function LoadingBlock({ label = "加载中" }: { label?: string }) {
	return (
		<div className="loading-block">
			<span />
			<span />
			<span />
			<small>{label}</small>
		</div>
	);
}

export function ErrorNotice({ error }: { error: unknown }) {
	return (
		<div className="error-notice" role="alert">
			{error instanceof Error ? error.message : String(error)}
		</div>
	);
}

export function StatusPill({ value, children }: { value: string; children?: ReactNode }) {
	return <span className={`status-pill status-${value}`}>{children ?? label(value)}</span>;
}

export function formatRelative(timestamp: string): string {
	const elapsed = Date.now() - new Date(timestamp).getTime();
	const minutes = Math.max(0, Math.floor(elapsed / 60_000));
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return `${Math.floor(hours / 24)} 天前`;
}
