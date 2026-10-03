const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key (支持多 Key 轮换，逗号或换行分隔)",
    value: "sk-dN5QCFzYScHLpG52c7IOeZ3vMJqncEz12BHUhbwDI899AoHV",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "请求地址",
    value: "https://apihub.agnes-ai.com/v1",
    props: { placeholder: "https://apihub.agnes-ai.com/v1" },
  },
] as const;

const version = "1.2.0";

// 预置 D:\agnes-video-app 全量 6 个可用 API Key
const DEFAULT_KEYS = [
  "sk-dN5QCFzYScHLpG52c7IOeZ3vMJqncEz12BHUhbwDI899AoHV",
  "sk-VDX50sWfXbTeLNPtBrCcl0xwc0dpaPqaRDamvSMzysPtdaHQ",
  "sk-NuuE321vBaBtuhDIubSNKTm9uLaVnSmHOJtvHDh1IdLtG9Zk",
  "sk-HU99HgZuT9BPhsNjeA1pslG6cR3ZBDk1I3firYpqJ4tdRJGI",
  "sk-rCduxSA2ZbT5NrCShkOlBygxu5QAekIeWDEzM6ehT68RojBk",
  "sk-5i1wbaa8NiYbi5j45kylG0lnacdlbygoNouz7mFCSxeV96hc",
];

// 全局密钥冷却池与任务绑定状态（在进程内持久）
const keyCooldownMap = new Map<string, { until: number; reason: string }>();
const taskKeyMap = new Map<string, string>();
const urlMirrorCache = new Map<string, string>();
let currentKeyIndex = 0;

function isKeyCoolingDown(key: string): boolean {
  const entry = keyCooldownMap.get(key);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    keyCooldownMap.delete(key);
    return false;
  }
  return true;
}

function getKeyCooldownRemainingSec(key: string): number {
  const entry = keyCooldownMap.get(key);
  if (!entry) return 0;
  const rem = Math.ceil((entry.until - Date.now()) / 1000);
  if (rem <= 0) {
    keyCooldownMap.delete(key);
    return 0;
  }
  return rem;
}

// 统一 40 秒限频冷却
function markKeyCooldown(key: string, seconds = 40, reason = "rate_limit"): void {
  keyCooldownMap.set(key, { until: Date.now() + seconds * 1000, reason });
}

function maskKey(key: string): string {
  if (!key || key.length < 10) return "sk-***";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

function extractErrorMessage(data: unknown): string {
  if (!data) return "未知错误";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.detail === "string") return obj.detail;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (obj.error && typeof obj.error === "object" && typeof (obj.error as Record<string, unknown>).message === "string") {
      return (obj.error as Record<string, unknown>).message as string;
    }
    return JSON.stringify(obj);
  }
  return String(data);
}

function loadPool(userConfigKey?: string): string[] {
  const keys: string[] = [];
  if (userConfigKey && typeof userConfigKey === "string") {
    userConfigKey.split(/[,;\n\r]+/).map(k => k.trim().replace(/^Bearer\s+/i, "")).filter(k => k.startsWith("sk-")).forEach(k => {
      if (!keys.includes(k)) keys.push(k);
    });
  }

  for (const k of DEFAULT_KEYS) {
    if (!keys.includes(k)) keys.push(k);
  }

  return keys;
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** 将本地 Base64、二进制图片上传到 Agnes 可直接下载的公网直链 (Uguu / Litterbox) */
async function uploadToPublicReachableUrl(input: MediaInput, signal: AbortSignal, fetchFn: typeof fetch): Promise<string> {
  if (input.type === "url") {
    let url = input.url;
    if (urlMirrorCache.has(url)) return urlMirrorCache.get(url)!;
    if (url.includes("files.catbox.moe/")) {
      try {
        const r = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal });
        if (r.ok) {
          const buf = await r.arrayBuffer();
          const mime = r.headers.get("content-type") || "image/png";
          const newUrl = await uploadBlobToUguu(new Blob([buf], { type: mime }), "image.png", signal, fetchFn);
          urlMirrorCache.set(url, newUrl);
          return newUrl;
        }
      } catch {}
    }
    return url;
  }

  const bytes = input.type === "binary" ? input.data : Buffer.from(input.data, "base64");
  const blob = new Blob([bytes], { type: input.mimeType || "image/png" });
  return uploadBlobToUguu(blob, "input.png", signal, fetchFn);
}

async function uploadBlobToUguu(blob: Blob, fileName: string, signal: AbortSignal, fetchFn: typeof fetch): Promise<string> {
  // 1. 优先尝试 Uguu.se
  try {
    const fd = typeof FormData !== "undefined" ? new FormData() : null;
    let body: FormData | Blob;
    let headers: Record<string, string> = { "User-Agent": "Mozilla/5.0" };
    if (fd) {
      fd.append("files[]", blob, fileName);
      body = fd;
    } else {
      const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const arrayBuffer = await blob.arrayBuffer();
      body = new Blob([
        `--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="${fileName}"\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
        arrayBuffer,
        `\r\n--${boundary}--\r\n`,
      ]);
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    }

    const res = await fetchFn("https://uguu.se/upload", {
      method: "POST",
      headers,
      body,
      signal,
    });
    if (res.ok) {
      const data = await res.json() as { files?: { url?: string }[] };
      const url = data?.files?.[0]?.url;
      if (url && url.startsWith("http")) return url;
    }
  } catch {}

  // 2. 备选尝试 Litterbox
  try {
    const fd = typeof FormData !== "undefined" ? new FormData() : null;
    let body: FormData | Blob;
    let headers: Record<string, string> = { "User-Agent": "Mozilla/5.0" };
    if (fd) {
      fd.append("reqtype", "fileupload");
      fd.append("time", "72h");
      fd.append("fileToUpload", blob, fileName);
      body = fd;
    } else {
      const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const arrayBuffer = await blob.arrayBuffer();
      body = new Blob([
        `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n72h\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${fileName}"\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
        arrayBuffer,
        `\r\n--${boundary}--\r\n`,
      ]);
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    }

    const res = await fetchFn("https://litterbox.catbox.moe/resources/internals/api.php", {
      method: "POST",
      headers,
      body,
      signal,
    });
    if (res.ok) {
      const url = (await res.text()).trim();
      if (url.startsWith("http")) return url;
    }
  } catch {}

  throw new Error("参考图片直链上传失败，请检查网络连接");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agnes AI 响应格式错误");
  return value as Record<string, unknown>;
}

export default {
  id: "agnesAi",
  label: "Agnes AI",
  version,
  readme: "## Agnes AI 媒体模型\n\n提供 Agnes 图像生成与短剧视频生成服务，内置多 Key 自动轮换、40 秒限频等待与故障转移队列。\n\n- 图片模型：`agnes-image-2.5-flash`、`agnes-image-2.1-flash`、`agnes-image-2.0-flash`\n- 视频模型：`agnes-video-2.5-flash`、`agnes-video-2.5`、`agnes-video-v2.0`",
  rules,
  models: [
    {
      id: "agnes-video-2.5-flash",
      label: "Agnes Video 2.5 Flash",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:5", "audioReference:3"]],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720P"] }],
    },
    {
      id: "agnes-video-2.5",
      label: "Agnes Video 2.5",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:5", "audioReference:3"]],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720P", "1080P"] }],
    },
    {
      id: "agnes-video-v2.0",
      label: "Agnes Video 2.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:5"]],
      durationResolutionMap: [{ duration: [5], resolution: ["720P"] }],
    },
    {
      id: "agnes-image-2.5-flash",
      label: "Agnes Image 2.5 Flash",
      type: "image",
      mode: ["text"],
    },
    {
      id: "agnes-image-2.1-flash",
      label: "Agnes Image 2.1 Flash",
      type: "image",
      mode: ["text"],
    },
    {
      id: "agnes-image-2.0-flash",
      label: "Agnes Image 2.0 Flash",
      type: "image",
      mode: ["text"],
    },
  ],

  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const keyPool = loadPool(this.config.apiKey as string | undefined);
    if (!keyPool.length) throw new Error("没有可用的 Agnes API Key");
    const baseUrl = ((this.config.baseUrl as string | undefined)?.trim() || "https://apihub.agnes-ai.com/v1").replace(/\/$/, "");
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const fetchFn = (typeof this.tool?.fetch === "function" ? this.tool.fetch : fetch);
    const reporter = (this.tool as unknown as { reportProgress?: (data: unknown) => void })?.reportProgress;

    let lastError = "";

    // 自动轮换 Key 提交生图
    for (let attempt = 0; attempt < 20; attempt++) {
      signal.throwIfAborted();

      // 选出一个未冷却的 Key
      let keyToUse = "";
      for (let i = 0; i < keyPool.length; i++) {
        const k = keyPool[(currentKeyIndex + i) % keyPool.length];
        if (!isKeyCoolingDown(k)) {
          keyToUse = k;
          currentKeyIndex = (currentKeyIndex + i + 1) % keyPool.length;
          break;
        }
      }

      // 所有 Key 都在冷却中，等待最短冷却时间
      if (!keyToUse) {
        let minCooldown = 40;
        for (const k of keyPool) {
          const rem = getKeyCooldownRemainingSec(k);
          if (rem > 0 && rem < minCooldown) minCooldown = rem;
        }
        console.log(`[Agnes Image] 所有 Key 处于 40 秒限频冷却中，等待 ${minCooldown} 秒后自动重试...`);
        reporter?.({
          state: "cooling",
          message: `40秒限频冷却等待中，剩余 ${minCooldown} 秒后自动抢位...`,
          cooldownRemaining: minCooldown,
          progress: 15,
        });
        await wait(signal, (minCooldown + 1) * 1000);
        continue;
      }

      try {
        console.log(`[Agnes Image] 正在使用 Key (${maskKey(keyToUse)}) 提交生图任务...`);
        reporter?.({
          state: "submitting",
          message: `正在使用 Key (${maskKey(keyToUse)}) 提交生图任务...`,
          cooldownRemaining: 0,
          progress: 25,
        });

        const response = await fetchFn(`${baseUrl}/images/generations`, {
          method: "POST",
          headers: { Authorization: `Bearer ${keyToUse}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: request.model || "agnes-image-2.5-flash",
            prompt: request.prompt,
            n: request.n ?? 1,
            size: request.size || request.ratio || undefined,
          }),
          signal,
        });

        const data = await response.json();
        if (response.ok && data && Array.isArray((data as Record<string, unknown>).data)) {
          const list = (data as Record<string, unknown>).data as Record<string, unknown>[];
          const url = list[0]?.url;
          if (typeof url === "string" && url) {
            reporter?.({
              state: "completed",
              message: "图片生成成功，正在保存...",
              progress: 100,
              cooldownRemaining: 0,
            });
            return [{ mediaType: "image", type: "url", url }];
          }
        }

        const errDetail = extractErrorMessage(data);
        lastError = errDetail;
        console.warn(`[Agnes Image Key Failed]: ${errDetail}`);

        const isRateLimit = response.status === 429 || /rate_limit|reached the API rate limit|quota/i.test(errDetail);
        if (isRateLimit) {
          markKeyCooldown(keyToUse, 40, "rate_limit");
          continue;
        }
        throw new Error(errDetail);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/rate_limit|reached the API rate limit|429/i.test(message)) {
          markKeyCooldown(keyToUse, 40, "rate_limit");
          continue;
        }
        if (attempt === 19) throw err;
      }
    }

    throw new Error(`图片生成失败：${lastError || "所有 API Key 均限频或请求异常"}`);
  },

  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const keyPool = loadPool(this.config.apiKey as string | undefined);
    if (!keyPool.length) throw new Error("没有可用的 Agnes API Key");
    const baseUrl = ((this.config.baseUrl as string | undefined)?.trim() || "https://apihub.agnes-ai.com/v1").replace(/\/$/, "");
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const fetchFn = (typeof this.tool?.fetch === "function" ? this.tool.fetch : fetch);
    const reporter = (this.tool as unknown as { reportProgress?: (data: unknown) => void })?.reportProgress;

    reporter?.({
      state: "preparing",
      message: "正在预处理参考素材与提示词...",
      progress: 5,
      cooldownRemaining: 0,
    });

    // 格式化公网可访问的图片/首尾帧地址
    const images: string[] = [];
    for (const img of request.images ?? []) {
      images.push(await uploadToPublicReachableUrl(img, signal, fetchFn));
    }
    const audios: string[] = [];
    for (const aud of request.audios ?? []) {
      if (aud.type === "url") audios.push(aud.url);
    }

    let firstFrameUrl: string | undefined;
    if (request.firstFrame) {
      firstFrameUrl = await uploadToPublicReachableUrl(request.firstFrame, signal, fetchFn);
    }
    let lastFrameUrl: string | undefined;
    if (request.lastFrame) {
      lastFrameUrl = await uploadToPublicReachableUrl(request.lastFrame, signal, fetchFn);
    }

    let mode = "text";
    if (firstFrameUrl || lastFrameUrl) {
      mode = "keyframe";
    } else if (images.length > 0 || audios.length > 0) {
      mode = "reference";
    }

    const payload: Record<string, unknown> = {
      model: request.model || "agnes-video-2.5-flash",
      prompt: request.prompt.trim(),
      mode,
      seconds: String(request.duration ?? 5),
      size: request.resolution ?? "720P",
      aspect_ratio: request.ratio ?? "16:9",
      n: 1,
    };

    if (mode === "keyframe") {
      if (firstFrameUrl) payload.first_frame = firstFrameUrl;
      if (lastFrameUrl) payload.last_frame = lastFrameUrl;
    } else if (mode === "reference") {
      if (images.length > 0) payload.images = images.slice(0, 5);
      if (audios.length > 0) payload.audios = audios.slice(0, 3);
    }

    let taskId = "";
    let usedKey = "";
    let lastError = "";

    // 1. 自动轮换 Key 提交视频任务（遇到 429 限频、机房排队满员自动 40 秒冷却避让）
    for (let attempt = 0; attempt < 30; attempt++) {
      signal.throwIfAborted();

      let candidateKey = "";
      for (let i = 0; i < keyPool.length; i++) {
        const k = keyPool[(currentKeyIndex + i) % keyPool.length];
        if (!isKeyCoolingDown(k)) {
          candidateKey = k;
          currentKeyIndex = (currentKeyIndex + i + 1) % keyPool.length;
          break;
        }
      }

      if (!candidateKey) {
        let minCooldown = 40;
        for (const k of keyPool) {
          const rem = getKeyCooldownRemainingSec(k);
          if (rem > 0 && rem < minCooldown) minCooldown = rem;
        }
        console.log(`[Agnes Video 候补排队] 所有 ${keyPool.length} 个 Key 均处于 40 秒限频冷却窗口，等待 ${minCooldown} 秒后自动继续抢位...`);
        reporter?.({
          state: "cooling",
          message: `40秒限频冷却等待中，剩余 ${minCooldown} 秒后自动抢位...`,
          cooldownRemaining: minCooldown,
          progress: 15,
        });
        await wait(signal, (minCooldown + 1) * 1000);
        continue;
      }

      try {
        console.log(`[Agnes Video] 尝试使用 Key (${maskKey(candidateKey)}) 提交视频生成任务...`);
        reporter?.({
          state: "submitting",
          message: `正在使用 Key (${maskKey(candidateKey)}) 提交视频任务...`,
          cooldownRemaining: 0,
          progress: 20,
        });

        const response = await fetchFn(`${baseUrl}/videos`, {
          method: "POST",
          headers: { Authorization: `Bearer ${candidateKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        const data = await response.json() as Record<string, unknown>;
        if (response.ok && (data.video_id || data.id)) {
          taskId = String(data.video_id || data.id);
          usedKey = candidateKey;
          taskKeyMap.set(taskId, usedKey);
          console.log(`[Agnes Video] 任务创建成功！ID: ${taskId}, 绑定轮询密钥: ${maskKey(usedKey)}`);
          reporter?.({
            state: "queued",
            message: `视频任务创建成功！云端排队中...`,
            progress: 30,
            cooldownRemaining: 0,
          });
          break;
        }

        const errDetail = extractErrorMessage(data);
        lastError = errDetail;
        console.warn(`[Agnes Video Key 提示]: ${errDetail}`);

        const isRateLimit = response.status === 429 || /rate_limit|reached the API rate limit|quota/i.test(errDetail);
        const isQueueFull = /queue is full|video_queue_full|queue is unavailable|video queue|please retry later|service unavailable/i.test(errDetail);

        if (isRateLimit) {
          markKeyCooldown(candidateKey, 40, "rate_limit");
          console.log(`[Agnes Video] Key (${maskKey(candidateKey)}) 命中 1 RPM 限频，冷却 40 秒，自动切换至下一 Key 抢位...`);
          reporter?.({
            state: "cooling",
            message: `Key (${maskKey(candidateKey)}) 遇到 1 RPM 限额，冷却 40 秒，切换下一 Key 抢位...`,
            cooldownRemaining: 40,
            progress: 15,
          });
          continue;
        } else if (isQueueFull) {
          markKeyCooldown(candidateKey, 40, "queue_full");
          console.log(`[Agnes Video] 官方机房排队满载，冷却 40 秒，切换下一 Key 抢位...`);
          reporter?.({
            state: "cooling",
            message: `机房排队满员，进入 40 秒冷却排队...`,
            cooldownRemaining: 40,
            progress: 15,
          });
          continue;
        } else {
          // 参数错误直接抛出
          throw new Error(errDetail);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/rate_limit|429/i.test(message)) {
          markKeyCooldown(candidateKey, 40, "rate_limit");
          continue;
        }
        if (/queue is full|queue is unavailable/i.test(message)) {
          markKeyCooldown(candidateKey, 40, "queue_full");
          continue;
        }
        if (attempt === 29) throw err;
      }
    }

    if (!taskId || !usedKey) {
      throw new Error(`视频生成任务创建失败：${lastError || "所有 API Key 均限频或云端机房满员"}`);
    }

    // 2. 使用专有 Key 进行低频安全轮询（间隔 12 秒，防止频繁查询烧光 RPM 额度）
    console.log(`[Agnes Video] 进入安全轮询通道 (每 12 秒检查一次进度)...`);
    const modelParam = request.model || "agnes-video-2.5-flash";
    const queryUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(modelParam)}`;

    while (true) {
      await wait(signal, 12000);
      try {
        const res = await fetchFn(queryUrl, {
          headers: { Authorization: `Bearer ${usedKey}` },
          signal,
        });

        if (!res.ok && res.status === 429) {
          console.warn(`[Agnes Video 轮询] 状态查询遇到短暂 429，等待 15 秒后继续，不中断任务...`);
          reporter?.({
            state: "cooling",
            message: "状态轮询遇到短暂限额，等待 15 秒后继续更新...",
            cooldownRemaining: 15,
          });
          await wait(signal, 15000);
          continue;
        }

        const data = object(await res.json());
        const status = String(data.status ?? "").toLowerCase();
        const rawProgress = typeof data.progress === "number" ? data.progress : 0;
        const displayProgress = Math.max(30, Math.min(99, rawProgress));
        console.log(`[Agnes Video 状态] ${status} (${rawProgress}%)`);

        reporter?.({
          state: status,
          message: status === "in_progress" || status === "processing"
            ? `视频云端渲染中 (${rawProgress}%)...`
            : `云端任务排队中 (${rawProgress}%)...`,
          progress: displayProgress,
          cooldownRemaining: 0,
        });

        if (status === "completed" || status === "success" || status === "succeeded") {
          const url = typeof data.url === "string" ? data.url : (typeof data.video_url === "string" ? data.video_url : undefined);
          if (url) {
            reporter?.({
              state: "completed",
              message: "视频生成完成，正在下载到本地工作区...",
              progress: 100,
              cooldownRemaining: 0,
            });
            return [{ mediaType: "video", type: "url", url }];
          }
          throw new Error("Agnes AI 未返回视频生成地址");
        }

        if (status === "failed" || status === "failure") {
          const errorMsg = (typeof this.tool?.errorMessage === "function" ? this.tool.errorMessage(data) : "") ||
            (typeof data.error === "string" ? data.error : (typeof data.message === "string" ? data.message : "视频生成失败"));
          throw new Error(errorMsg);
        }
      } catch (pollErr: unknown) {
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        if (/429|rate limit/i.test(msg)) {
          console.warn(`[Agnes Video 轮询波动] 状态查询限频，持续等待中...`);
          reporter?.({
            state: "cooling",
            message: "状态轮询限频，等待 15 秒后继续...",
            cooldownRemaining: 15,
          });
          await wait(signal, 15000);
          continue;
        }
        throw pollErr;
      }
    }
  },
} satisfies ProviderDefinition<typeof rules>;
