# 03-APP/new-api-patch · 控制台前端是怎么改的

> 服务器上跑的是**已构建好的产物**（`03-APP/console/`），部署时不需要构建。
> 这个目录是"万一将来要改 UI，怎么重现当初的过程"。

## 里面有什么

| 文件 | 说明 |
|---|---|
| `web.patch` | 相对官方 `v1.0.0-rc.51` 源码的 diff（12 个文件的修改） |
| `new-files/` | 新增的文件（4 个组件 + 1 个样式 + 1 张壁纸），patch 里没有未跟踪文件，所以单独放 |
| `README.md` | 本文件 |

## 改了哪些地方（一句话版）

| 文件 | 改了什么 |
|---|---|
| `web/src/features/dashboard/components/overview/overview-dashboard.tsx` | **重写**：去掉官方的设置引导大卡与「余额/钱包」侧栏，挂上我们的面板 |
| `.../mssk-usage-data.ts`（新） | 区间定义 + `/api/data/flow/self` 聚合逻辑 + 查询 hook |
| `.../mssk-usage-panel.tsx`（新） | 用量概览 KPI、按密钥×模型表、按模型表、时间范围按钮 |
| `.../codex-quota-api.ts`（新） | 读同源 `codex-quota.json` |
| `.../codex-quota-panel.tsx`（新） | 订阅额度卡 |
| `web/src/styles/mssk-internal.css`（新） | 内部部署调色板（深色变量 + 毛玻璃 + 壁纸） |
| `web/src/styles/index.css` | 末尾 import 上面的样式 |
| `web/src/context/theme-provider.tsx` | 默认主题 `system` → `dark` |
| `web/src/lib/theme-customization.ts` | 默认字体 → `sans` |
| `web/src/routes/index.tsx` | 根路径 `/` 从"落地页"改成重定向到控制台（旧版行为） |
| `web/index.html` | 首屏默认深色 + 壁纸样式 |
| `web/src/i18n/locales/*.json` | 新增 31 个 i18n 键（7 种语言） |
| `.../__tests__/setup-guide.test.tsx` | 删除（功能已移除） |

## 重建步骤（只在需要改 UI 时做，服务器上不要做）

```bash
# 1) 取官方源码
git clone --depth 1 --branch v1.0.0-rc.51 https://github.com/QuantumNous/new-api.git
cd new-api

# 2) 应用 patch（注意 patch 是相对仓库根目录的）
git apply /path/to/web.patch

# 3) 复制新增文件
cp -a /path/to/new-files/web/. web/

# 4) 构建
cd web
bun install          # 约 2 分钟，1106 MB 依赖
bun run build        # 产物在 web/dist

# 5) 部署产物（只传 dist，不要在服务器上编译）
tar czf console.tgz -C web/dist .
scp console.tgz root@<新机IP>:/tmp/
ssh root@<新机IP> 'tar xzf /tmp/console.tgz -C /opt/mssk/console && rm -f /tmp/console.tgz'
```

## 三个必须知道的坑

1. **别在生产机上编译**。`bun install` 峰值要 2~4 GB 内存，1.6 GB 的机器会直接失联。
2. **`color-mix()` 会被构建工具算错**。`mssk-internal.css` 里有两个颜色我写成了十六进制实色
   （`#331c27`）而不是 `color-mix(...)`：旧构建用 `color-mix` 时浏览器算出来是粉色，
   而 rsbuild 的 LightningCSS 在构建时预计算成了紫色，肉眼可见的差异。改配色时别改回 `color-mix`。
3. **字体名陷阱**。旧构建声明 `"Public Sans"` 但只注册了 `Public Sans Variable`，
   实际渲染成系统无衬线。`mssk-internal.css` 里刻意保留了这个行为（`--font-body: 'Public Sans', sans-serif`），
   如果你想要真正的 Public Sans，得把字体族名改成 `Public Sans Variable`。

## 版本记录

- 当前部署的产物入口：见 `/opt/mssk/console/index.html` 里引用的 `index.<hash>.js`
- 构建基线：官方 `v1.0.0-rc.51`
- 面板版本标记：页面上「按密钥用量」卡片副标题带 `mssk-v6`（肉眼确认版本用）
