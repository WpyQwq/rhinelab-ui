import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// 本地归档服务：开发与预览都把 /archive-api 代理到 127.0.0.1，并在代理层注入
// 每次启动生成的访问令牌。令牌不进入浏览器，外部网页无法直接调用该服务。
const archiveConfig = JSON.parse(readFileSync("archive.config.json", "utf8"));
const archivePort = Number(archiveConfig.port ?? 43117);
const readArchiveToken = () => {
  try {
    return readFileSync(".archive-token", "utf8").trim();
  } catch {
    return "";
  }
};
const archiveProxy = {
  "/archive-api": {
    target: `http://127.0.0.1:${archivePort}`,
    changeOrigin: false,
    ws: false,
    rewrite: (url: string) => url.replace(/^\/archive-api/, ""),
    configure: (proxy: {
      on: (event: string, handler: (req: { setHeader(name: string, value: string): void }) => void) => void;
    }) => {
      proxy.on("proxyReq", (proxyReq) => {
        const token = readArchiveToken();
        if (token) proxyReq.setHeader("x-archive-token", token);
      });
    },
  },
};

// Keep Blender's stable source/export paths, while production URLs identify
// exact bytes and can be cached without revalidation across deployments.
const models = ["archive-cassette", "archive-assembly"].map(name => {
  const source = readFileSync(`public/assets/${name}.glb`);
  const hash = createHash("sha256").update(source).digest("hex").slice(0,16);
  return { key:`assets/${name}.glb`, fileName:`assets/${name}.${hash}.glb`, source };
});
const hasNovecento = ["Normal", "DemiBold", "Bold"].every(weight =>
  existsSync(`public/fonts/novecento/webFonts/NovecentoSansWide${weight}/font.woff2`),
);
export default defineConfig(({ mode }) => ({
  base: mode === "wallpaper" ? "./" : "/",
  server: { proxy: archiveProxy },
  preview: { proxy: archiveProxy },
  define: {
    __RHINE_MODELS__: JSON.stringify(Object.fromEntries(models.map(model => [model.key,model.fileName]))),
    __RHINE_NOVECENTO__: JSON.stringify(hasNovecento),
  },
  plugins: [{
    name: "versioned-model-assets", apply: "build",
    buildStart() { for (const model of models) this.emitFile({type:"asset",fileName:model.fileName,source:model.source}); },
  }, ...(mode === "wallpaper" ? [{
    name: "wallpaper-host",
    transformIndexHtml(html: string) {
      return { html: html.replace(/\s*<link rel="manifest"[^>]*>/, ""), tags: [{
        tag: "script", children: readFileSync("wallpaper/host.js", "utf8"), injectTo: "head-prepend" as const,
      }] };
    },
  }] : [])],
}));
