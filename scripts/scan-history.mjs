// P7: git 历史 -p 全文扫描(全部分支)。运行:node scripts/scan-history.mjs
// 自动探测本机 git(MinGit 或系统 git)。
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const gitExe = existsSync("D:/Z bns/_tools/MinGit/cmd/git.exe")
  ? "D:/Z bns/_tools/MinGit/cmd/git.exe"
  : "git";

const PATTERNS = [
  { name: "学校域名 YOUR_SCHOOL_DOMAIN.example", re: /bns\.cn/gi },
  { name: "学校站点 your-site.example", re: /bnslearn\.top/gi },
  { name: "OpenAI 风格密钥", re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "Resend 密钥", re: /re_[A-Za-z0-9]{20,}/g },
  { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
];

const out = execFileSync(gitExe, ["log", "--all", "-p", "--unified=0"], {
  encoding: "utf-8",
  maxBuffer: 512 * 1024 * 1024,
});

let total = 0;
for (const p of PATTERNS) {
  const m = out.match(p.re);
  const n = m ? m.length : 0;
  total += n;
  console.log(`${n ? "HIT" : "OK "} ${p.name}: ${n} 处`);
}
console.log(total === 0
  ? "HISTORY_SCAN_CLEAN(全部分支历史无泄漏特征)"
  : `HISTORY_SCAN_HITS: ${total}(请逐条核对是否为文档示例/测试占位)`);
