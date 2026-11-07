/** 项目、会话、版本树 —— 对应原 backend/app/api/projects.py(仅 owner、软删除、越权 404)。 */
import { Hono } from "hono";
import type { Env } from "../types";
import { getOptionalUser, requireActive, getOwnedProject, audit, userOut, type ProjectRow } from "../auth/deps";
import { HttpError, json, naiveUtc } from "../utils/http";
import { all, one, run } from "../storage/db";

export const projectRoutes = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

function projectOut(p: ProjectRow): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    owner_id: p.owner_id,
    permission: "owner",
    created_at: p.created_at,
    updated_at: p.updated_at,
    has_images: false, // 由调用方覆盖
  };
}

projectRoutes.get("/projects", async (c) => {
  const ctx = await getOptionalUser(c);
  const u = ctx.user;
  if (!u) throw new HttpError(401, "未登录或会话已过期");
  const q = (c.req.query("q") || "").trim();
  const rows = await all<ProjectRow & { has_images: number }>(
    c.env.DB,
    "SELECT p.*, EXISTS(SELECT 1 FROM versions v WHERE v.project_id = p.id) AS has_images " +
    "FROM projects p WHERE p.owner_id = ? AND p.status = 'active' " +
    (q ? "AND p.title LIKE ? " : "") +
    "ORDER BY p.updated_at DESC LIMIT 500",
    ...(q ? [u.id, `%${q}%`] : [u.id]),
  );
  return json({
    items: rows.map((p) => ({ ...projectOut(p), has_images: Number(p.has_images) > 0 })),
  });
});

projectRoutes.post("/projects", async (c) => {
  const ctx = await getOptionalUser(c);
  const u = requireActive(ctx);
  const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
  const title = (body.title || "").trim();
  if (!title || title.length > 160) throw new HttpError(422, "项目名称需要 1-160 字");
  const id = crypto.randomUUID();
  await run(
    c.env.DB,
    "INSERT INTO projects (id, owner_id, title, status, version_seq, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    id, u.id, title, nowIso(), nowIso(),
  );
  await audit(ctx, "project_create", { entityId: id, detail: title });
  const p = await one<ProjectRow>(c.env.DB, "SELECT * FROM projects WHERE id = ?", id);
  return json({ ...projectOut(p!), has_images: false }, 201);
});

projectRoutes.get("/projects/:projectId", async (c) => {
  const ctx = await getOptionalUser(c);
  const p = await getOwnedProject(ctx, c.req.param("projectId"));
  const v = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM versions WHERE project_id = ?", p.id);
  return json({ ...projectOut(p), has_images: (v?.n ?? 0) > 0 });
});

projectRoutes.patch("/projects/:projectId", async (c) => {
  const ctx = await getOptionalUser(c);
  requireActive(ctx);
  const p = await getOwnedProject(ctx, c.req.param("projectId"), { write: true });
  const body = await c.req.json<{ title?: string; status?: string }>()
    .catch(() => ({}) as { title?: string; status?: string });
  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) throw new HttpError(400, "项目名称不能为空");
    await run(c.env.DB, "UPDATE projects SET title = ?, updated_at = ? WHERE id = ?", title.slice(0, 160), nowIso(), p.id);
  }
  await audit(ctx, "project_update", { entityId: p.id, detail: `title=${(body.title || p.title).slice(0, 160)}` });
  const fresh = await one<ProjectRow>(c.env.DB, "SELECT * FROM projects WHERE id = ?", p.id);
  return json(projectOut(fresh!));
});

projectRoutes.delete("/projects/:projectId", async (c) => {
  const ctx = await getOptionalUser(c);
  requireActive(ctx);
  const p = await getOwnedProject(ctx, c.req.param("projectId"), { write: true });
  await run(c.env.DB, "UPDATE projects SET status = 'deleted', updated_at = ? WHERE id = ?", nowIso(), p.id);
  await audit(ctx, "project_delete", { entityId: p.id, detail: p.title });
  return json({ ok: true });
});

// ---------------- 会话与版本 ----------------
projectRoutes.get("/projects/:projectId/messages", async (c) => {
  const ctx = await getOptionalUser(c);
  const p = await getOwnedProject(ctx, c.req.param("projectId"));
  const rows = await all<{ id: string; role: string; kind: string; content: string; attachments: string; meta: string; created_at: string }>(
    c.env.DB, "SELECT id, role, kind, content, attachments, meta, created_at FROM messages WHERE project_id = ? ORDER BY created_at",
    p.id,
  );
  return json({
    items: rows.map((m) => ({
      id: m.id, role: m.role, kind: m.kind, content: m.content,
      attachments: JSON.parse(m.attachments || "[]"),
      meta: JSON.parse(m.meta || "{}"),
      created_at: naiveUtc(m.created_at),
    })),
  });
});

projectRoutes.get("/projects/:projectId/versions", async (c) => {
  const ctx = await getOptionalUser(c);
  const p = await getOwnedProject(ctx, c.req.param("projectId"));
  const rows = await all<VersionRow>(c.env.DB, "SELECT * FROM versions WHERE project_id = ? ORDER BY version_no", p.id);
  return json({ items: rows.map(versionOut) });
});

projectRoutes.get("/projects/:projectId/jobs", async (c) => {
  const ctx = await getOptionalUser(c);
  const p = await getOwnedProject(ctx, c.req.param("projectId"));
  const rows = await all<Record<string, string | null>>(
    c.env.DB,
    "SELECT id, status, model, mode, prompt, error, version_id, source_version_id, created_at FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 10",
    p.id,
  );
  return json({
    items: rows.map((j) => ({ ...j, created_at: naiveUtc(String(j.created_at)) })),
  });
});

export interface VersionRow {
  id: string;
  project_id: string;
  message_id: string | null;
  parent_id: string | null;
  source_version_id: string | null;
  version_no: number;
  branch_name: string;
  mode: string;
  model: string;
  prompt: string;
  revised_prompt: string | null;
  params: string;
  rel_path: string;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  mime: string;
  size_bytes: number;
  is_starred: number;
  created_at: string;
}

export function versionOut(v: VersionRow): Record<string, unknown> {
  return {
    id: v.id,
    project_id: v.project_id,
    message_id: v.message_id,
    parent_id: v.parent_id,
    source_version_id: v.source_version_id,
    version_no: v.version_no,
    branch_name: v.branch_name,
    mode: v.mode,
    model: v.model,
    prompt: v.prompt,
    revised_prompt: v.revised_prompt,
    params: JSON.parse(v.params || "{}"),
    width: v.width,
    height: v.height,
    size_bytes: v.size_bytes,
    is_starred: Number(v.is_starred) > 0,
    has_thumb: Boolean(v.thumb_path),
    created_at: naiveUtc(v.created_at),
    url: `/api/v1/versions/${v.id}/image`,
    thumb_url: `/api/v1/versions/${v.id}/thumb`,
  };
}

projectRoutes.get("/versions/:versionId", async (c) => {
  const ctx = await getOptionalUser(c);
  const v = await one<VersionRow>(c.env.DB, "SELECT * FROM versions WHERE id = ?", c.req.param("versionId"));
  if (!v) throw new HttpError(404, "版本不存在");
  await getOwnedProject(ctx, v.project_id);
  return json(versionOut(v));
});

// 仅历史兼容:星标 UI 已下线,端点保留
projectRoutes.patch("/versions/:versionId/star", async (c) => {
  const ctx = await getOptionalUser(c);
  requireActive(ctx);
  const v = await one<VersionRow>(c.env.DB, "SELECT * FROM versions WHERE id = ?", c.req.param("versionId"));
  if (!v) throw new HttpError(404, "版本不存在");
  await getOwnedProject(ctx, v.project_id, { write: true });
  await run(c.env.DB, "UPDATE versions SET is_starred = 1 - is_starred WHERE id = ?", v.id);
  const fresh = await one<VersionRow>(c.env.DB, "SELECT * FROM versions WHERE id = ?", v.id);
  await audit(ctx, "version_star", { entityId: v.id, detail: String(Number(fresh!.is_starred) > 0) });
  return json(versionOut(fresh!));
});
