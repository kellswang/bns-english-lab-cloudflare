/** 文件下载 —— 对应原 api/files.py:全部经会话 + 归属校验后从 R2 流式输出。 */
import { Hono } from "hono";
import type { Env } from "../types";
import { getOptionalUser, getOwnedProject, requireActive } from "../auth/deps";
import { HttpError, json } from "../utils/http";
import { one, run } from "../storage/db";
import { fileResponse, R2Keys, putObject } from "../storage/r2";
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
  const safeTitle = (project?.title || "English Lab").replace(/["\\/:*?<>|\r\n]/g, "_").slice(0, 48);
  return fileResponse(obj.body, v.mime || "image/png", {
    filename: `ELAB_${safeTitle}_v${String(v.version_no).padStart(3, "0")}.${v.mime === "image/jpeg" ? "jpg" : "png"}`,
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

/**
 * 缩略图上传(浏览器端生成,P1.2):教师端把原图缩到 420px 宽的 JPEG 后传回,
 * 服务端只做归属校验 + JPEG 魔数 + 大小校验,零解码 CPU。
 * 幂等:重复上传覆盖同 key;has_thumb=false 的版本才需要生成。
 */
fileRoutes.put("/versions/:versionId/thumb", async (c) => {
  const ctx = await getOptionalUser(c);
  requireActive(ctx);
  const v = await one<VersionRow>(c.env.DB, "SELECT * FROM versions WHERE id = ?", c.req.param("versionId"));
  if (!v) throw new HttpError(404, "版本不存在");
  await getOwnedProject(ctx, v.project_id);
  const raw = await c.req.arrayBuffer();
  if (raw.byteLength === 0) throw new HttpError(400, "缩略图为空");
  if (raw.byteLength > 300 * 1024) throw new HttpError(413, "缩略图不能超过 300 KB");
  const head = new Uint8Array(raw.slice(0, 3));
  if (!(head[0] === 0xff && head[1] === 0xd8)) throw new HttpError(400, "缩略图必须是 JPEG");
  const key = R2Keys.versionThumb(v.project_id, v.id);
  await putObject(c.env, key, raw, "image/jpeg", { length: raw.byteLength });
  await run(c.env.DB, "UPDATE versions SET thumb_path = ? WHERE id = ?", key, v.id);
  return json({ ok: true, thumb_url: `/api/v1/versions/${v.id}/thumb` });
});
