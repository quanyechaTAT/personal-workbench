import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			{children}
		</svg>
	);
}

export const Icons = {
	Panel: (props: IconProps) => (
		<Icon {...props}>
			<rect x="3" y="4" width="18" height="16" rx="3" />
			<path d="M15 4v16" />
		</Icon>
	),
	Close: (props: IconProps) => (
		<Icon {...props}>
			<path d="m6 6 12 12M6 18 18 6" />
		</Icon>
	),
	Edit: (props: IconProps) => (
		<Icon {...props}>
			<path d="m16 3 5 5-12 12H4v-5Z" />
			<path d="m13 6 5 5" />
		</Icon>
	),
	Trash: (props: IconProps) => (
		<Icon {...props}>
			<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
		</Icon>
	),
	Home: (props: IconProps) => (
		<Icon {...props}>
			<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
		</Icon>
	),
	Chat: (props: IconProps) => (
		<Icon {...props}>
			<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
		</Icon>
	),
	Project: (props: IconProps) => (
		<Icon {...props}>
			<path d="M3 7h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
			<path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h5" />
		</Icon>
	),
	Task: (props: IconProps) => (
		<Icon {...props}>
			<rect x="3" y="3" width="18" height="18" rx="3" />
			<path d="m7 12 3 3 7-7" />
		</Icon>
	),
	Memory: (props: IconProps) => (
		<Icon {...props}>
			<path d="M9 4a3 3 0 0 1 6 0v16a3 3 0 0 1-6 0Z" />
			<path d="M9 6H7a3 3 0 0 0-1 5.8A3.5 3.5 0 0 0 8 18h1M15 6h2a3 3 0 0 1 1 5.8 3.5 3.5 0 0 1-2 6.2h-1" />
		</Icon>
	),
	Skill: (props: IconProps) => (
		<Icon {...props}>
			<path d="m12 3 2.2 4.5L19 8.2l-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8L5 8.2l4.8-.7Z" />
			<path d="M9 19h6" />
		</Icon>
	),
	File: (props: IconProps) => (
		<Icon {...props}>
			<path d="M6 2h8l4 4v16H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
			<path d="M14 2v5h5" />
		</Icon>
	),
	Settings: (props: IconProps) => (
		<Icon {...props}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
		</Icon>
	),
	Plus: (props: IconProps) => (
		<Icon {...props}>
			<path d="M12 5v14M5 12h14" />
		</Icon>
	),
	Send: (props: IconProps) => (
		<Icon {...props}>
			<path d="m22 2-7 20-4-9-9-4Z" />
			<path d="M22 2 11 13" />
		</Icon>
	),
	Stop: (props: IconProps) => (
		<Icon {...props}>
			<rect x="6" y="6" width="12" height="12" rx="1" />
		</Icon>
	),
	Spark: (props: IconProps) => (
		<Icon {...props}>
			<path d="m12 3 1.2 4.3L17.5 9l-4.3 1.7L12 15l-1.2-4.3L6.5 9l4.3-1.7Z" />
			<path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z" />
		</Icon>
	),
	Chevron: (props: IconProps) => (
		<Icon {...props}>
			<path d="m9 18 6-6-6-6" />
		</Icon>
	),
	Moon: (props: IconProps) => (
		<Icon {...props}>
			<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
		</Icon>
	),
	Sun: (props: IconProps) => (
		<Icon {...props}>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</Icon>
	),
	Tool: (props: IconProps) => (
		<Icon {...props}>
			<path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L20 16.4a2.5 2.5 0 0 1-3.6 3.6l-7.7-7.7" />
		</Icon>
	),
	Check: (props: IconProps) => (
		<Icon {...props}>
			<path d="m5 12 4 4L19 6" />
		</Icon>
	),
	Clock: (props: IconProps) => (
		<Icon {...props}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</Icon>
	),
	Refresh: (props: IconProps) => (
		<Icon {...props}>
			<path d="M20 11a8 8 0 1 0-2.3 5.7" />
			<path d="M20 4v7h-7" />
		</Icon>
	),
};
