/** Only a direct request in the user's message can close the accumulated review window. */
export function learningReviewRequest(text: string): "requested" | "declined" | undefined {
	const plain = text
		.replace(/```[\s\S]*?```|`[^`\n]*`/gu, "")
		.replace(/^[\t ]*>.*$/gmu, "")
		.replace(/[“「『][\s\S]*?[”」』]|"[^"\n]*"|'[^'\n]*'/gu, "");
	if (
		/(?:不要|不用|无需|不必|暂不|先不|别|停止).{0,8}(?:复盘|学习|保存.{0,3}(?:记忆|经验|技能))|\b(?:do not|don't|skip)\s+(?:review|reflect|learn|save memories)\b/iu.test(
			plain,
		)
	)
		return "declined";
	const requested = plain.split(/[。！？!?\n；;]/u).some((sentence) => {
		const value = sentence.trim();
		if (/如何|怎么|怎样|什么意思|例如|比如|示例|触发词|how (?:to|does)|what (?:does|is)/iu.test(value)) return false;
		return (
			/^(?:(?:请|帮我|麻烦|现在|最后|先|我们|来|做个|做一下|任务结束了|任务完成了|工作结束了)[，,\s]*)*(?:总结|复盘|回顾)(?:(?:一下|下)?(?:这次|本次|本轮|当前|此次|这个|这段|本段|刚才的|刚才|我们|这|本)(?:的)?(?:任务|对话|会话|工作|执行过程|操作|经验|沟通|结果)|(?:一下|下)?(?:任务|对话|会话|工作|执行过程|操作|经验|沟通|结果)?[，,\s]*$)/u.test(
				value,
			) ||
			/^(?:请|帮我|现在|我们)?(?:对|把|将)(?:这次|本次|本轮|当前|这段)(?:的)?(?:任务|对话|会话|工作)(?:进行|做个|做一次)?(?:总结|复盘|回顾)/u.test(
				value,
			) ||
			/^(?:please\s+)?(?:summari[sz]e|review|reflect on)\s+(?:this|the current|our|the completed)\s+(?:task|session|conversation|work)\b/iu.test(
				value,
			)
		);
	});
	return requested ? "requested" : undefined;
}
