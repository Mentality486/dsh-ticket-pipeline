
const fs = require("fs");
const path = require("os").homedir() + "/.dsh/.credentials.yaml";
const yaml = fs.readFileSync(path, "utf8");
const refs = {};
let inRefs = false;
for (const line of yaml.split(/\r?\n/)) {
  if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
  if (inRefs) {
    const m = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*(.+)$/);
    if (m) refs[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    else if (/^\S/.test(line)) inRefs = false;
  }
}
(async () => {
  const auth = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ app_id: refs.FEISHU_APP_ID, app_secret: refs.FEISHU_APP_SECRET }),
  }).then(r => r.json());
  const token = auth.tenant_access_token;
  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const app = "RZZQbY4SkaY6z0shZaBcVpQCnhh";
  const tbl = "tblWhRSGf0osJqrE";
  // 带最后修改时间字段排序（模拟插件 sort 行为）
  const body = { page_size: 20, automatic_fields: true, sort: [{ field_name: "最后修改时间", desc: true }] };
  let r = await fetch("https://open.feishu.cn/open-apis/bitable/v1/apps/" + app + "/tables/" + tbl + "/records/search", { method: "POST", headers: H, body: JSON.stringify(body) }).then(x => x.json());
  console.log("with-sort:", r.code, r.msg);
  if (r.code !== 0) {
    delete body.sort;
    r = await fetch("https://open.feishu.cn/open-apis/bitable/v1/apps/" + app + "/tables/" + tbl + "/records/search", { method: "POST", headers: H, body: JSON.stringify(body) }).then(x => x.json());
    console.log("no-sort:", r.code, r.msg, "rows=", r.data?.items?.length ?? 0);
    if (r.code === 0 && r.data?.items?.length) {
      for (const it of r.data.items.slice(0, 5)) {
        const f = it.fields || {};
        const keys = Object.keys(f).join("|");
        console.log("  record:", it.record_id.slice(0,8), "fields:", keys.slice(0, 200));
      }
    }
  }
})();
