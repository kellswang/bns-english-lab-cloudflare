#!/usr/bin/env node
/**
 * 平台用量报告(P2.6):用 Cloudflare Analytics GraphQL API 拉取本实例的
 * Workers 请求/CPU 错误、D1 行读写、R2 操作等真实平台指标。
 * 需要 CLOUDFLARE_API_TOKEN(Account Analytics:Read)与 Account ID。
 * 用法: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/usage-report.mjs <worker名> [天数]
 * 站内估算(图片数/对话数/存储)则用管理页 /api/v1/admin/storage 与 /admin/usage-daily。
 */
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const worker = process.argv[2];
const days = Number(process.argv[3] || 7);
if (!token || !account || !worker) {
  console.error("用法: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node usage-report.mjs <worker名> [天数]");
  process.exit(1);
}
const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
const query = `{
  viewer {
    accounts(filter: {accountTag: "${account}"}) {
      workersInvocationsAdaptive(filter: {scriptName: "${worker}", datetime_geq: "${since}"}, limit: 10000, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
      d1AnalyticsAdaptiveGroups(filter: {date_geq: "${since}"}, limit: 10000) {
        dimensions { date }
        sum { readQueries writeQueries rowsRead rowsWritten }
      }
      r2StorageAdaptiveGroups(filter: {date_geq: "${since}"}, limit: 10000) {
        dimensions { date }
        max { payloadSize }
        sum { classAOps classBOps }
      }
    }
  }
}`;
const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ query }),
});
const data = await res.json();
if (!data.data) { console.error(JSON.stringify(data, null, 2)); process.exit(1); }
const a = data.data.viewer.accounts[0];
console.log(`== ${worker} 近 ${days} 天平台用量(以官方 Analytics 为准)==`);
console.log("Workers:", JSON.stringify(a.workersInvocationsAdaptive, null, 1).slice(0, 1200));
console.log("D1:", JSON.stringify(a.d1AnalyticsAdaptiveGroups?.slice(-3), null, 1));
console.log("R2:", JSON.stringify(a.r2StorageAdaptiveGroups?.slice(-3), null, 1));
