const ALLOWED_KEYS = new Set([
	"ALLUSERSPROFILE",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PSMODULEPATH",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDOMAIN",
	"USERNAME",
	"USERPROFILE",
	"WINDIR",
]);

export function minimalShellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const selected: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(environment)) {
		const normalized = key.toUpperCase();
		if (ALLOWED_KEYS.has(normalized) || normalized.startsWith("LC_")) selected[key] = value;
	}
	return selected;
}
