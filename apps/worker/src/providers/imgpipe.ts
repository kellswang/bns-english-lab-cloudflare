/**
 * 字节级图像管道 —— P0 核心实现:让大图处理的每一次调用都远低于 10ms CPU。
 *
 * 问题:一张 20MB PNG 的 b64 JSON 响应约 27MB。任何一次调用里做
 * JSON.parse / 全文扫描 / 整体解码都会达到 50-200ms CPU —— 免费套餐必挂。
 *
 * 方案:把处理拆成跨队列调用的五个纯小步骤,每步只碰 ~1MB:
 *   capture : res.body 原始字节流 → R2 raw 对象(管道透传,CPU≈0)
 *   scan    : 每次调用处理 raw 的一个 1MB 窗口(字节级状态机),
 *             把 b64 区间字节直接拷到分块对象,其余小片段累积为可解析 JSON
 *   decode  : 每次调用解码一个 1M 字符 b64 分片(atob 原生 + 定长转换 ≈ 4-8ms)
 *   assemble: 把解码分块用只读串流合成最终对象(纯 I/O,CPU≈0)
 *   persist : D1 版本落库(与原逻辑一致)
 *
 * 所有分块对象完成后即删除;状态存 generation_jobs.params,任一步可由巡检重驱动。
 */

// 窗口/分片大小:在"调用次数少"与"单片 CPU 低"之间取值,线上用 live-cpu-probe 实测后可调
export const RAW_CAPTURE_CHUNK = 2 * 1024 * 1024; // capture 单对象上限(未知长度时)
export const SCAN_WINDOW_BYTES = 1024 * 1024; // 每次调用扫描的 raw 字节数(single 捕获按窗口切)
export const SCAN_MARKER = '"b64_json":"';
export const SCAN_MARKER_BYTES = 12; // 跨窗口携带的尾部重叠字节数(marker 长度-1)
export const B64_INLINE_LIMIT = 500_000; // b64 总长低于此值:扫描完成后单次解码(~4ms CPU)
export const B64_CHUNK_CHARS = 500_000; // 每个解码分片的 b64 字符数(4 对齐;≈375KB 解码/次)
export const META_BYTES_CAP = 1_000_000; // 重建 JSON 的字节上限(正常远小于此)

const MARKER = new TextEncoder().encode(SCAN_MARKER);

/** 顺序读流并落成分块对象;返回 {prefix, chunks, total}。CPU≈纯 I/O。 */
export async function writeStreamToChunks(
  env: { MEDIA: R2Bucket },
  prefix: string,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ prefix: string; chunks: number; total: number }> {
  const reader = body.getReader();
  let idx = 0;
  let total = 0;
  let buf = new Uint8Array(maxBytes);
  let bufLen = 0;
  const flush = async () => {
    if (bufLen === 0) return;
    await env.MEDIA.put(`${prefix}/${idx}`, buf.subarray(0, bufLen), { httpMetadata: { contentType: "application/octet-stream" } });
    total += bufLen;
    idx++;
    bufLen = 0;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bufLen + value.byteLength > maxBytes) {
        await flush();
      }
      if (value.byteLength > maxBytes) {
        // 单块超过分片大小:直接独立成块
        await env.MEDIA.put(`${prefix}/${idx}`, value, { httpMetadata: { contentType: "application/octet-stream" } });
        total += value.byteLength;
        idx++;
      } else {
        buf.set(value, bufLen);
        bufLen += value.byteLength;
      }
    }
    await flush();
  } finally {
    reader.releaseLock();
  }
  return { prefix, chunks: idx, total };
}

/** 把分块对象串流合成单个对象;流式不可用时回退内存合成(≤25MB 图片可接受)。 */
export async function assembleChunks(
  env: { MEDIA: R2Bucket },
  prefix: string,
  chunks: number,
  totalBytes: number,
  outKey: string,
  contentType: string,
): Promise<R2Object> {
  // FixedLengthStream 是 Workers 运行时 API;不存在(纯 Node 测试)时直接内存合成,
  // 避免把 Node 流传给绑定 RPC 触发未处理拒绝。生产 workerd 始终走流式(CPU≈0)。
  if (typeof FixedLengthStream === "undefined") {
    return assembleInMemory(env, prefix, chunks, outKey, contentType);
  }
  try {
    return await assembleStreaming(env, prefix, chunks, totalBytes, outKey, contentType);
  } catch (e) {
    console.warn("assembleChunks: streaming assemble failed, fallback to memory", e instanceof Error ? e.message : e);
  }
  return assembleInMemory(env, prefix, chunks, outKey, contentType);
}

async function assembleInMemory(
  env: { MEDIA: R2Bucket },
  prefix: string,
  chunks: number,
  outKey: string,
  contentType: string,
): Promise<R2Object> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < chunks; i++) {
    const obj = await env.MEDIA.get(`${prefix}/${i}`);
    if (!obj) throw new Error(`assembleChunks: 缺少分块 ${i}`);
    const b = new Uint8Array(await obj.arrayBuffer());
    parts.push(b);
    total += b.byteLength;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.byteLength; }
  const obj = await env.MEDIA.put(outKey, merged, { httpMetadata: { contentType } });
  if (!obj) throw new Error("assembleChunks: put 返回空");
  return obj;
}

async function assembleStreaming(
  env: { MEDIA: R2Bucket },
  prefix: string,
  chunks: number,
  totalBytes: number,
  outKey: string,
  contentType: string,
): Promise<R2Object> {
  let next = 0;
  // 每个分块对象只取一次 reader(流锁定后重复 getReader 会 ERR_INVALID_STATE)
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const openNext = async () => {
    while (next < chunks) {
      const obj = await env.MEDIA.get(`${prefix}/${next}`);
      next++;
      if (obj && obj.body) {
        reader = obj.body.getReader();
        return true;
      }
    }
    return false;
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!reader) {
          if (!(await openNext())) {
            controller.close();
            return;
          }
        }
        const { done, value } = await reader!.read();
        if (done) {
          reader!.releaseLock();
          reader = null;
          return; // pull 会被再次调用取下一块
        }
        if (value) controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
  const fixed = new FixedLengthStream(totalBytes);
  // put 失败时 pipeTo 也会拒绝:立即挂 no-op catch,避免 unhandledRejection
  const pipeDone = stream.pipeTo(fixed.writable);
  pipeDone.catch(() => {});
  const obj = await env.MEDIA.put(outKey, fixed.readable, { httpMetadata: { contentType } });
  await pipeDone;
  if (!obj) throw new Error("assembleChunks: put 返回空");
  return obj;
}

export async function deleteChunkPrefix(env: { MEDIA: R2Bucket }, prefix: string, chunks: number): Promise<void> {
  const keys: string[] = [];
  for (let i = 0; i < chunks; i++) keys.push(`${prefix}/${i}`);
  await env.MEDIA.delete(keys);
}

/**
 * 字节级扫描状态机(跨调用可序列化)。
 * 输入:raw 的一个字节窗口;输出:b64 字节片段(写入分块对象)+ 非b64文本(累积)。
 */
export interface ScanState {
  mode: "scan" | "in-b64";
  carry: number[]; // 跨窗口的字节尾巴(最多 marker 长度-1)
  b64Prefix: string;
  b64ChunkIdx: number;
  b64Buf: number[]; // 当前 b64 分块缓冲(字节)
  b64Total: number;
  metaBytes: number[]; // 重建 JSON 的原始字节(小;超上限即截断)
  metaTruncated: boolean;
}

export function newScanState(b64Prefix: string): ScanState {
  return { mode: "scan", carry: [], b64Prefix, b64ChunkIdx: 0, b64Buf: [], b64Total: 0, metaBytes: [], metaTruncated: false };
}

function putB64Chunk(env: { MEDIA: R2Bucket }, st: ScanState): Promise<void> {
  if (st.b64Buf.length === 0) return Promise.resolve();
  // 4 字符对齐切分:余数留在缓冲,跨块延续(否则 atob 会因长度非 4 倍数拒绝)
  const keep = st.b64Buf.length % 4;
  const cut = st.b64Buf.length - keep;
  if (cut === 0) return Promise.resolve();
  const bytes = new Uint8Array(st.b64Buf.slice(0, cut));
  st.b64Buf = st.b64Buf.slice(cut);
  return env.MEDIA.put(`${st.b64Prefix}/${st.b64ChunkIdx}`, bytes, { httpMetadata: { contentType: "text/plain" } })
    .then(() => { st.b64ChunkIdx++; });
}

/** 处理一个字节窗口;窗口为 raw 的 [winIdx*WIN, ...) 实际字节。 */
export async function scanWindow(
  env: { MEDIA: R2Bucket },
  st: ScanState,
  windowBytes: Uint8Array,
  isLast: boolean,
): Promise<void> {
  // carry + window 组成工作区
  const data = new Uint8Array(st.carry.length + windowBytes.length);
  data.set(st.carry, 0);
  data.set(windowBytes, st.carry.length);
  st.carry = [];

  let i = 0;
  // 非 b64 字节全部累积(完整 UTF-8 序列最后一次性解码,杜绝窗口边界截断)
  const pushMetaByteSafe = (b: number) => {
    if (st.metaBytes.length < META_BYTES_CAP) st.metaBytes.push(b);
    else st.metaTruncated = true;
  };
  const pushMetaBytes = (from: number, to: number) => {
    for (let k = from; k < to; k++) pushMetaByteSafe(data[k]!);
  };
  const pushMarker = () => {
    // '"b64_json":"' 的 marker 字节 + 开引号 + 闭引号(空串),JSON 保持合法
    for (const b of MARKER) pushMetaByteSafe(b);
    pushMetaByteSafe(0x22);
    pushMetaByteSafe(0x22);
  };
  const pushMarkerClose = () => {
    pushMetaByteSafe(0x22);
  };

  while (i < data.length) {
    if (st.mode === "scan") {
      // 在 data 中找 marker(可能跨界,由 carry 保障)
      let hit = -1;
      outer: for (let s = i; s <= data.length - MARKER.length; s++) {
        for (let k = 0; k < MARKER.length; k++) {
          if (data[s + k] !== MARKER[k]) continue outer;
        }
        hit = s;
        break;
      }
      if (hit === -1) {
        // 无 marker:保留末尾 marker长度-1 字节作为 carry,其余进 meta
        const keepFrom = Math.max(i, data.length - (MARKER.length - 1));
        pushMetaBytes(i, keepFrom);
        for (let k = keepFrom; k < data.length; k++) st.carry.push(data[k]!);
        i = data.length;
      } else {
        pushMetaBytes(i, hit);
        // 重建 JSON 中写入空串占位:marker 字节 + 开引号 + 闭引号(b64 值被剥掉后 JSON 仍合法)
        pushMarker();
        i = hit + MARKER.length;
        st.mode = "in-b64";
        st.b64Total = 0;
      }
    } else {
      // in-b64:找结束引号
      let end = -1;
      for (let s = i; s < data.length; s++) {
        if (data[s] === 0x22) { end = s; break; }
      }
      if (end === -1) {
        for (let k = i; k < data.length; k++) st.b64Buf.push(data[k]!);
        st.b64Total += data.length - i;
        i = data.length;
        if (st.b64Buf.length >= B64_CHUNK_CHARS) await putB64Chunk(env, st);
      } else {
        for (let k = i; k < end; k++) st.b64Buf.push(data[k]!);
        st.b64Total += end - i;
        i = end + 1;
        pushMarkerClose();
        st.mode = "scan";
        await putB64Chunk(env, st);
      }
    }
  }
  if (isLast && st.mode === "in-b64") {
    // 异常:流结束仍未闭合 —— 保持现状,由调用方按错误处理
  }
}

/** 扫描完成后的收尾:冲洗 carry、补齐分块、算 padding、重建元数据。 */
export async function finishScan(
  env: { MEDIA: R2Bucket },
  st: ScanState,
): Promise<{ b64Chunks: number; b64Bytes: number; tailPadding: number; payload: any }> {
  // 最后一个窗口的无 marker 尾字节存放在 carry:冲洗回元数据(否则 JSON 尾部被截断)
  if (st.mode === "scan" && st.carry.length > 0) {
    for (const b of st.carry) {
      if (st.metaBytes.length < META_BYTES_CAP) st.metaBytes.push(b);
      else st.metaTruncated = true;
    }
    st.carry = [];
  }
  await putB64Chunk(env, st);
  let tailPadding = 0;
  if (st.b64ChunkIdx > 0) {
    const lastKey = `${st.b64Prefix}/${st.b64ChunkIdx - 1}`;
    const obj = await env.MEDIA.get(lastKey);
    if (obj) {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      let n = 0;
      for (let k = bytes.length - 1; k >= 0 && bytes[k] === 0x3d; k--) n++;
      tailPadding = Math.min(2, n);
    }
  }
  let payload: any = {};
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(new Uint8Array(st.metaBytes)));
  } catch {
    payload = {};
  }
  if (st.metaTruncated) payload.__meta_truncated = true;
  return { b64Chunks: st.b64ChunkIdx, b64Bytes: st.b64Total, tailPadding, payload };
}
