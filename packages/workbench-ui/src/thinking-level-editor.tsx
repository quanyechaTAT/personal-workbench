import {
	type ConfiguredModel,
	defaultThinkingLevelMap,
	MODEL_THINKING_LEVELS,
	type RuntimeThinkingLevelMap,
} from "@earendil-works/workbench-runtime";

export function ThinkingLevelEditor({
	model,
	onChange,
}: {
	model: ConfiguredModel;
	onChange(map: RuntimeThinkingLevelMap): void;
}) {
	const map = { ...defaultThinkingLevelMap(model.thinkingPreset), ...model.thinkingLevelMap };
	return (
		<fieldset className="thinking-level-editor" disabled={!model.reasoning}>
			<legend>思考档位</legend>
			<p className="quiet-copy">启用后可在聊天中选择。填写供应商接受的参数值；留空表示不发送强度参数。</p>
			<div className="thinking-level-rows">
				{MODEL_THINKING_LEVELS.map((level) => {
					const enabled = map[level] !== null;
					return (
						<div className={`thinking-level-row${enabled ? " enabled" : ""}`} key={level}>
							<label className="switch" aria-label={`启用思考档位 ${level}`}>
								<input
									type="checkbox"
									checked={enabled}
									onChange={(event) =>
										onChange({
											...map,
											[level]: event.target.checked ? (level === "off" ? "" : level) : null,
										})
									}
								/>
								<span />
							</label>
							<strong>{level}</strong>
							<input
								aria-label={`思考参数 ${level}`}
								value={typeof map[level] === "string" ? map[level] : ""}
								placeholder="留空 = 不发送"
								disabled={!enabled}
								maxLength={64}
								onChange={(event) => onChange({ ...map, [level]: event.target.value.trim() })}
							/>
						</div>
					);
				})}
			</div>
		</fieldset>
	);
}
