import { open, opendir, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import u from "@/utils";
import { createCanvasMention, mentionAssetType, mentionNodeOutputs, mentionRecord, queryMentionNodes,
  type MentionAsset, type MentionCanvasNode, type MentionQuery } from "./mentionSources";
import type { AgentMention } from "./runtime/types";

type StoredCanvas = { revision: string; nodes: MentionCanvasNode[]; byId: Map<string, MentionCanvasNode> };
const canvasCache = new Map<string, { revision: string; bytes: number; value: Promise<StoredCanvas> }>();
const assetSearches = new Map<string, { key: string; offset: number; touched: number; busy: boolean; iterator: AsyncGenerator<MentionAsset>; timer: ReturnType<typeof setTimeout> }>();

async function readMentionText(directory: string, relativePath: string) {
  const { path } = await u.workspaceFile.resolveWorkspacePath(directory, relativePath);
  const info = await stat(path);
  if (!info.isFile() || info.size > 400000) throw Object.assign(new Error("文本引用最多支持 100000 个字符，请缩小内容后重试"), { status: 400 });
  const text = await readFile(path, "utf8");
  if (text.length > 100000) throw Object.assign(new Error("文本引用最多支持 100000 个字符，请缩小内容后重试"), { status: 400 });
  return text;
}

async function readCanvas(directory: string, canvasId: string) {
  const { path } = await u.workspaceFile.resolveWorkspacePath(directory, canvasId);
  const info = await stat(path);
  if (!info.isFile() || info.size > 256 * 1024 * 1024) throw Object.assign(new Error("画布文件无效或超过 256 MB 的读取上限"), { status: 400 });
  const revision = `${info.mtimeMs}:${info.size}`;
  const cached = canvasCache.get(path);
  if (cached?.revision === revision) {
    canvasCache.delete(path);
    canvasCache.set(path, cached);
    return cached.value;
  }
  const value = (async () => {
    const canvas: unknown = JSON.parse(await readFile(path, "utf8"));
    const latest = await stat(path);
    if (latest.mtimeMs !== info.mtimeMs || latest.size !== info.size) throw Object.assign(new Error("画布正在保存，请重试"), { status: 409 });
    if (!mentionRecord(canvas) || canvas.toonflowCanvas !== true || !Array.isArray(canvas.nodes)) throw Object.assign(new Error("文件不是有效画布"), { status: 400 });
    const nodes = canvas.nodes.filter((node): node is MentionCanvasNode => mentionRecord(node) && typeof node.id === "string");
    return { revision, nodes, byId: new Map(nodes.map(node => [node.id, node])) };
  })();
  const entry = { revision, bytes: info.size, value };
  canvasCache.set(path, entry);
  // ACT: 离线画布仅在服务端解析；最多缓存两份、源文件合计 256 MB，每次查询重新核对 mtime/size。
  while (canvasCache.size > 2 || [...canvasCache.values()].reduce((total, entry) => total + entry.bytes, 0) > 256 * 1024 * 1024) {
    canvasCache.delete(canvasCache.keys().next().value!);
  }
  void value.catch(() => { if (canvasCache.get(path) === entry) canvasCache.delete(path); });
  return value;
}

export async function listMentionCanvases(directory: string, signal: AbortSignal) {
  const entries = await opendir(directory);
  const canvases: { id: string; name: string }[] = [];
  for await (const entry of entries) {
    signal.throwIfAborted();
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
    const { path } = await u.workspaceFile.resolveWorkspacePath(directory, entry.name);
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(4096);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (/^\s*\{/.test(header.toString("utf8", 0, bytesRead)) && /"toonflowCanvas"\s*:\s*true\s*[,}]/.test(header.toString("utf8", 0, bytesRead))) {
        canvases.push({ id: entry.name, name: entry.name.slice(0, -5) });
      }
    } finally { await file.close(); }
  }
  return canvases.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}

export async function queryStoredMentionNodes(directory: string, canvasId: string, options: MentionQuery) {
  options.signal?.throwIfAborted();
  const canvas = await readCanvas(directory, canvasId);
  options.signal?.throwIfAborted();
  return queryMentionNodes(canvas.nodes, `${canvasId}:${canvas.revision}`, options);
}

export async function storedMentionOutput(directory: string, canvasId: string, nodeId: string, outputId?: string) {
  const canvas = await readCanvas(directory, canvasId);
  const node = canvas.byId.get(nodeId);
  if (!node) throw Object.assign(new Error("节点已删除，请重新选择"), { status: 404 });
  return outputId === undefined ? mentionNodeOutputs(node) : createCanvasMention(node, canvasId, outputId, path => readMentionText(directory, path));
}

async function* walkAssets(directory: string, path: string, recursive: boolean, depth = 0): AsyncGenerator<MentionAsset> {
  if (depth > 64) return;
  const resolved = await u.workspaceFile.resolveWorkspacePath(directory, path);
  const entries = await opendir(resolved.path);
  for await (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const relativePath = path && path !== "." ? `${path}/${entry.name}` : entry.name;
    yield { name: entry.name, path: relativePath, type: entry.isDirectory() ? "directory" : "file",
      ...(entry.isFile() ? { dataType: mentionAssetType(entry.name)?.dataType } : {}) };
    if (recursive && entry.isDirectory()) yield* walkAssets(directory, relativePath, true, depth + 1);
  }
}

export async function queryMentionAssets(options: MentionQuery & { path?: string }) {
  options.signal?.throwIfAborted();
  const directory = await u.assets.getAssetsDirectory();
  const path = options.path || ".";
  await u.workspaceFile.resolveWorkspacePath(directory, path);
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const key = JSON.stringify([directory, path, query]);
  for (const [id, search] of assetSearches) if (Date.now() - search.touched > 60000) {
    assetSearches.delete(id);
    clearTimeout(search.timer);
    void search.iterator.return(undefined).catch(() => {});
  }
  let id: string;
  if (options.cursor) {
    const cursor = options.cursor.split(":");
    id = cursor[0]!;
    const search = assetSearches.get(id);
    if (!search || search.key !== key || String(search.offset) !== cursor[1]) throw Object.assign(new Error("分页已失效，请重新搜索"), { status: 409 });
  } else {
    id = crypto.randomUUID();
    const iterator = walkAssets(directory, path, !!query);
    const timer = setTimeout(() => { assetSearches.delete(id); void iterator.return(undefined).catch(() => {}); }, 60000);
    timer.unref();
    assetSearches.set(id, { key, offset: 0, touched: Date.now(), busy: false, iterator, timer });
    // ACT: 素材搜索保留至多四个短期目录迭代器，避免每页重新递归遍历整个素材库。
    while (assetSearches.size > 4) {
      const oldest = assetSearches.keys().next().value!;
      const removed = assetSearches.get(oldest)!;
      assetSearches.delete(oldest);
      clearTimeout(removed.timer);
      void removed.iterator.return(undefined).catch(() => {});
    }
  }
  const search = assetSearches.get(id)!;
  if (search.busy) throw Object.assign(new Error("上一页仍在读取，请稍后重试"), { status: 409 });
  search.busy = true;
  const items: MentionAsset[] = [];
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  let done = false;
  try {
    for (let scanned = 0; scanned < 2000 && items.length < limit; scanned++) {
      options.signal?.throwIfAborted();
      const next = await search.iterator.next();
      if (next.done) { done = true; break; }
      search.offset++;
      const item = next.value;
      if (!query || (item.type === "file" && `${item.name} ${item.path}`.toLocaleLowerCase().includes(query))) items.push(item);
    }
    search.touched = Date.now();
    search.timer.refresh();
    if (done) { assetSearches.delete(id); clearTimeout(search.timer); }
    return { items, ...(!done ? { nextCursor: `${id}:${search.offset}` } : {}) };
  } catch (error) {
    assetSearches.delete(id);
    clearTimeout(search.timer);
    await search.iterator.return(undefined);
    throw error;
  } finally { search.busy = false; }
}

export async function selectMentionAsset(relativePath: string): Promise<AgentMention> {
  const directory = await u.assets.getAssetsDirectory();
  const { path } = await u.workspaceFile.resolveWorkspacePath(directory, relativePath);
  const info = await stat(path);
  const type = mentionAssetType(relativePath);
  if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) throw Object.assign(new Error("请选择非空且不超过 100 MB 的素材文件"), { status: 400 });
  const value = type.dataType === "STRING" ? await readMentionText(directory, relativePath) : { url: relativePath, mimeType: type.mimeType };
  return { id: crypto.randomUUID(), label: basename(path), source: { kind: "asset", path: relativePath }, dataType: type.dataType, value };
}
