# Freeplane 笔记站（只读 Web 版 · 模板）

把 Freeplane 的 `.mm` 思维导图变成可在线浏览的笔记站：保留层级结构、富文本、详情、图标、颜色、链接和图片，只读、无编辑器、无后端，桌面端和手机端都能用。

仓库本身是一份**空模板**：`public/notes/` 里没有任何笔记，配好路径跑一次同步就能用。

```
Freeplane 目录 ──npm run sync──> public/notes ──npm run build──> dist/ ──> Cloudflare Pages
```

## 目录

```
freeplane-web/                 # 仓库根 = Vite 根
├─ index.html
├─ src/
│  ├─ main.ts                  # 渲染、搜索、详情、灯箱、移动端交互
│  └─ style.css
├─ public/
│  ├─ notes/                   # 笔记放这里（.mm + 图片），模板里是空的
│  └─ data/                    # 构建生成的 JSON，勿手改（已 gitignore）
├─ scripts/
│  ├─ sync-notes.ts            # 笔记同步：初始化 / 增量 / 删除
│  ├─ build-data.ts            # .mm → JSON（含图片路径解析与告警）
│  ├─ check-images.ts          # 图片体检，可挂 CI
│  ├─ clean.ts                 # 删除 dist/ 与 public/data/
│  └─ shared.ts                # 配置加载、glob 匹配、找 .mm
├─ shared/                     # 脚本与前端共用的解析内核
│  ├─ types.ts                 # 唯一数据模型
│  ├─ parser.ts                # .mm 解析（先抽 HTML 再解析结构）
│  └─ refs.ts                  # 图片 / 附件引用收集与路径解析
├─ notes.config.json           # 笔记同步配置：源目录 → 项目目录
├─ tsconfig.json
├─ vite.config.ts
├─ package.json
└─ .trash/                     # 清理回收站（已 gitignore，永不提交）
```

## 从模板开始

```bash
npm install

# 1. 配好源目录（也可以直接手写 notes.config.json）
npm run sync -- --init --from "D:/notes/思维导图" --to "思维导图"

# 2. 本地看效果
npm run dev

# 3. 发布
npm run build
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run sync` | 按 `notes.config.json` 把笔记增量同步进 `public/notes` |
| `npm run sync -- --dry-run` | 只预览同步结果，不写文件 |
| `npm run sync -- --prune` | 同时删除源目录里已删掉的文件 |
| `npm run sync -- --build` | 同步完自动构建 |
| `npm run dev` | 生成数据 + 启动 Vite |
| `npm run data` | 只重新生成 `public/data/*` |
| `npm run build` | 类型检查 → 生成数据 → 打包到 `dist/` |
| `npm run check` | 图片体检（绝对路径 / 缺失文件），不改文件 |
| `npm run typecheck` | 只跑 `tsc --noEmit` |
| `npm run preview` | 本地预览 `dist/` |
| `npm run clean` | 删掉 `dist/` 与 `public/data/` |

交互：滚轮/双指缩放、拖拽/单指平移、点圆点折叠、点节点看详情、点图片开灯箱，`/` 聚焦搜索。

## 笔记同步流程

### 1. 配置源目录

`notes.config.json`：

```json
{
  "notesDir": "public/notes",
  "sources": [{ "from": "../../我的笔记/思维导图", "to": "思维导图" }],
  "extensions": [".mm", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".pdf"],
  "ignore": ["**/~$*", "**/.*", "**/Thumbs.db"],
  "prune": false
}
```

- `from`：Freeplane 里笔记所在目录，可写绝对路径（`D:/notes/思维导图`），相对路径以**配置文件所在目录**为准。
- `to`：导入到 `notesDir` 下的子目录，留空即放在根目录。
- `sources` 可以有多个，一次同步多套笔记。
- `extensions` / `ignore` 是白名单 + 忽略规则（支持 `**`、`*`、`?`）。

### 2. 首次导入

```bash
# 方式一：让脚本生成配置并立刻导入（推荐）
npm run sync -- --init --from "D:/notes/思维导图" --to "思维导图"

# 方式二：先手写 notes.config.json，再
npm run sync

# 方式三：临时指定源，不改配置文件
npm run sync -- --from "D:/notes/思维导图" --to "思维导图"
```

### 3. 日常修改 → 上线

```bash
# Freeplane 里改完并保存（Ctrl+S）
npm run sync          # 只复制新增/改过的文件
npm run check         # 可选：图片体检
npm run build         # 本地确认页面没问题
git add -A && git commit -m "docs: 更新笔记" && git push
```

推送即触发 Cloudflare Pages 构建，站点自动更新。

### 4. 同步是怎么判断的

- 每个源文件记录「大小 + mtime」到 `.notes-sync.json`（已 gitignore，不提交）。
- 目标不存在 → 新增；大小变化或源 mtime 变化 → 更新；否则跳过。
- 源里删掉的文件默认**保留**在目标里，只提示 `待删除`；加 `--prune` 才会真正删除，并顺手清掉空目录。
- 非 `.mm` / 图片 / PDF 的文件（`.log`、`.tmp` 等）不会被复制。

> CI（Cloudflare Pages）只跑 `npm run build`，不跑 `sync`。所以**笔记本体要提交进仓库**，同步状态文件不用提交。

## 清理与回收站

- 清理笔记：直接删 `public/notes/` 下的内容即可（`public/data/` 里的 JSON 是生成物，下次构建自动重建）。
- 项目里的 `.trash/` 是回收站，`gitignore` 已忽略，不会进仓库也不会被打包：
  - `.trash/notes/` —— 模板化时移除的示例笔记
  - `.trash/legacy/` —— 旧压缩包、旧的 report / 截图
  - `.trash/build/` —— 旧的构建产物
- 需要找回某个笔记时，从 `.trash/` 里复制回 `public/notes/` 再 `npm run data` 即可。

## 移动端适配

- **侧栏变抽屉**：≤900px 时侧栏改为滑出抽屉（宽 `min(84vw, 300px)`）+ 半透明遮罩，选完笔记自动收起，点遮罩/`Esc` 关闭。
- **详情变底部抽屉**：桌面是右侧面板，手机上变成贴底、圆角、带拖拽条的 sheet（`max-height: 66vh`），里面有独立滚动区。
- **画布浮动缩放**：手机上没有滚轮，右下角常驻 `＋ / －`，工具栏保留「适应窗口」。
- **手势**：`#mindmap` 设 `touch-action: none`，双指缩放 / 单指平移交给 d3-zoom，不会被浏览器抢走；首次操作后提示条自动淡出。
- **细节**：`100dvh` 避免移动端地址栏导致的高度跳动；`env(safe-area-inset-*)` 适配刘海和手势条；搜索框在手机上 16px，避免 iOS 聚焦时自动放大；≤560px 隐藏顶部面包屑，把宽度留给层级按钮。
- 窄屏下 markmap 的 `maxWidth` / `spacingHorizontal` 会自动收窄，节点文字换行更合理。

## TypeScript

全项目（前端 + 构建脚本 + 解析器）都是 TypeScript，`strict` 开启：

- `shared/types.ts` 是唯一数据模型：`MapNode`（解析结果）、`SiteNode`（前端短键节点）、`MapData`、`Manifest` 等，脚本和浏览器共用，字段不会两边对不上。
- `npm run build` 会先跑 `npm run typecheck`，类型错误直接让构建失败。
- 脚本用 `tsx` 直接执行 `.ts`，不需要先编译；前端由 Vite 处理。
- 关键 DOM 访问走 `must()`（找不到元素直接抛错），避免静默的 `null` 相关 bug。

## 图片怎么处理

### 目录约定

`.mm` 里引用的是**相对于该 .mm 所在目录**的路径，所以保持原有相对关系即可：

```
public/notes/
├─ 技术笔记.mm
├─ Images/diagram.png          # 被 Images/diagram.png 引用
├─ 读书笔记.mm
├─ 读书笔记_files/             # 从网页粘贴图片时 Freeplane 自动生成
└─ sub/
   ├─ 子目录.mm
   └─ Images/chart.png         # 被 Images/chart.png 引用
```

`public/` 会被 Vite 原样复制到 `dist/`，所以不需要写复制逻辑，也不需要改 `.mm`。

### 四种引用都能处理

| 形态 | 位置 | 渲染方式 |
| --- | --- | --- |
| `<img src>` | richcontent NODE | 节点内缩略图（限高 150px） |
| `<img src>` | DETAILS / NOTE | 详情面板内自适应宽度 |
| `<hook NAME="ExternalObject" URI>` | node 下 | 节点缩略图 + 详情大图 + 灯箱 |
| `LINK="xxx.png"` | node 属性 | 忽略（浏览器打不开本地文件） |

### 一个必须先知道的坑

用 **右键 → Insert → Image → Add image…** 插入本地图片时，Freeplane 可能写入**绝对路径**（`C:\...` / `file:///...`），即使偏好设置里把 Hyperlink types 设成了 Relative——这个设置对插入图片不生效。

绝对路径在 Cloudflare 的构建容器里 100% 读不到。所以：

1. 尽量用**粘贴**插图（Freeplane 会先复制到 `mapname_files/`，然后写相对路径）；
2. 提交前跑 `npm run check`，它会列出每个绝对路径 / 缺失文件对应的节点；
3. 构建时也会打印同样的告警，并在侧栏给该笔记标 `⚠ n`。

### 已经内置的处理

- 路径解码（`%20` → 空格）、反斜杠归一、`../` 规范化、越界拦截
- 缺失图片显示虚线占位框，`title` 里保留原始路径
- 图片加载完成后自动重排一次（markmap 在图片撑开前就测量了尺寸，会重叠）
- 25 MiB 单文件限制：超大的截图建议先压到长边 1600px

## Cloudflare Pages

| 配置项 | 值 |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist` |
| 环境变量 | `NODE_VERSION=22`（需 ≥ 22，`tsx` 与 Vite 8 都要求较新的 Node） |

推送 GitHub 即触发构建（免费版 500 次/月，单次上限 20 分钟）。私有仓库可连接，但站点默认公开；需要私密访问时套一层 **Cloudflare Access**。

## 已知边界

- 只读，不回写 `.mm`；同步是单向的（Freeplane → 项目），不会从网页改回笔记。
- 不还原：云（cloud）、跨节点箭头（arrowlink）、自由节点坐标、条件样式的动态规则。
- 正文在右侧面板（手机上是底部抽屉）读，不塞进图里——Freeplane 的长文本通常在 details，这是刻意的设计。
- 默认展开 2–3 层；点「全部」会展开并尝试适应窗口，节点特别多时会停在可读缩放下，再点「适应窗口」看全貌。
- 手机端 pinch 缩放依赖浏览器的 touch 事件，个别老旧 WebView 可能只能靠右下角 `＋ / －`。

## 依赖

- 运行时：`markmap-view`、`dompurify`
- 构建时：`saxes`、`vite`、`typescript`、`tsx`
