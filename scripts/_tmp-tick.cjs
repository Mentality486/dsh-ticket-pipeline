
(async () => {
  const base = "C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@local/ticket-pipeline";
  const mod = await import("file:///" + base.replace(/\\/g, "/") + "/src/index.js").then(m => m).catch(e => { console.log("IMPORT-FAIL", e.message.slice(0,200)); process.exit(1); });
  console.log("IMPORT-OK exports:", Object.keys(mod).join(","));
  // 找工具构建入口：
  const caps = mod.CAPABILITY_ASSEMBLERS;
  console.log("CAPABILITY_ASSEMBLERS:", caps ? Object.keys(caps).join(",") : "(none)");
})();
