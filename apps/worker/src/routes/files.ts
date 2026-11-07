/** 文件下载 —— 对应原 api/files.py:全部经会话 + 归属校验后从 R2 流式输出。 */
import { Hono } from "hono";
import type { Env } from "../types";
import { getOptionalUser, getOwnedProject } from "../auth/deps";
import { HttpError } from "../utils/http";
import { one } from "../storage/db";
import { fileResponse } from "../storage/r2";
import type { VersionRow } from "./projects";

export const fileRoutes = new Hono<{ Bindings: Env }>();

async function requireVersion(c: any, versionId: string): Promise<VersionRow> {
  const ctx = await getOptionalUser(c);
  const v = await one<VersionRow>(c.env.DB, "SELECT * FROM versions WHERE id = ?", versionId);
  if (!v) throw new HttpError(404, "版本不存在");
  await getOwnedProject(ctx, v.project_id);
  return v;
}

fileRoutes.get("/versions/:versionId/image", async (c) => {
  const v = await requireVersion(c, c.req.param("versionId"));
  const obj = await c.env.MEDIA.get(v.rel_path);
  if (!obj) throw new HttpError(410, "原图文件已丢失");
  return fileResponse(obj.body, v.mime || "image/png", { cache: "private, max-age=3600" });
});

fileRoutes.get("/versions/:versionId/thumb", async (c) => {
  const v = await requireVersion(c, c.req.param("versionId"));
  // 缩略图由浏览器端生成上传;缺失时回退原图(与原 thumb_path 回退 rel_path 一致)
  const key = v.thumb_path || v.rel_path;
  const obj = await c.env.MEDIA.get(key);
  if (!obj) throw new HttpError(410, "图片文件已丢失");
  const isThumb = Boolean(v.thumb_path);
  return fileResponse(obj.body, isThumb ? "image/jpeg" : (v.mime || "image/png"), { cache: "private, max-age=600" });
});

fileRoutes.get("/versions/:versionId/download", async (c) => {
  const v = await requireVersion(c, c.req.param("versionId"));
  const obj = await c.env.MEDIA.get(v.rel_path);
  if (!obj) throw new HttpError(410, "原图文件已丢失");
  const project = await one<{ title: string }>(c.env.DB, "SELECT title FROM projects WHERE id = ?", v.project_id);
  const safeTitle = (project?.title || "BNS").replace(/["\\/:*?<>|\r\n]/g, "_").slice(0, 48);
  return fileResponse(obj.body, v.mime || "image/png", {
    filename: `BNS_${safeTitle}_v${String(v.version_no).padStart(3, "0")}.${v.mime === "image/jpeg" ? "jpg" : "png"}`,
  });
});

fileRoutes.get("/uploads/:uploadId/image", async (c) => {
  const ctx = await getOptionalUser(c);
  const up = await one<{ id: string; project_id: string; rel_path: string; content_type: string }>(
    c.env.DB, "SELECT id, project_id, rel_path, content_type FROM uploads WHERE id = ?", c.req.param("uploadId"));
  if (!up) throw new HttpError(404, "参考图不存在");
  await getOwnedProject(ctx, up.project_id);
  const obj = await c.env.MEDIA.get(up.rel_path);
  if (!obj) throw new HttpError(404, "参考图文件缺失");
  return fileResponse(obj.body, up.content_type || "image/png", { cache: "private, max-age=3600" });
});
