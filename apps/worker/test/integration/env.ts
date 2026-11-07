/** 测试上下文类型与工厂(集成测试引用以保持文件精简)。 */
import { makeTestEnv, call, login, seedInvite } from "../helpers";
import type { Env } from "../../src/types";

export interface TestCtx {
  env: Env;
  dispose: () => Promise<void>;
}

export async function makeTestCtx(overrides: Record<string, string> = {}): Promise<TestCtx & { call: typeof call; login: typeof login; seedInvite: typeof seedInvite }> {
  const { env, dispose } = await makeTestEnv(overrides);
  return { env, dispose, call, login, seedInvite };
}
export { makeTestEnv, call, login, seedInvite };
export type { Env };
