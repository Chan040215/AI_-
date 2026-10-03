import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { activeMediaGenerations } from "@/utils/media/generation";

export default Router().get("/", async (req, res) => {
  const outputDirectory = typeof req.query.outputDirectory === "string" ? req.query.outputDirectory.trim().replace(/^[/\\]+|[/\\]+$/g, "") : "";
  const nodeId = typeof req.query.nodeId === "string" ? req.query.nodeId.trim() : "";

  let task = outputDirectory ? activeMediaGenerations.get(outputDirectory) : undefined;
  if (!task && nodeId) {
    task = activeMediaGenerations.get(`assets/${nodeId}`) || activeMediaGenerations.get(nodeId);
  }
  if (!task && (outputDirectory || nodeId)) {
    for (const [key, val] of activeMediaGenerations.entries()) {
      if ((outputDirectory && key.includes(outputDirectory)) || (nodeId && key.includes(nodeId))) {
        task = val;
        break;
      }
    }
  }

  // 若无指定参数且存在正在进行的生成，返回最近的一个
  if (!task && activeMediaGenerations.size > 0) {
    task = Array.from(activeMediaGenerations.values()).at(-1);
  }

  res.json(success(task ? {
    state: task.state,
    message: task.message,
    progress: task.progress,
    cooldownRemaining: task.cooldownRemaining ?? 0,
    elapsedSeconds: Math.floor((Date.now() - task.startTime) / 1000),
  } : null));
});
