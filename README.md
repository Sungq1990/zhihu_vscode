# Zhihu VS Code Theme（知乎 VS Code 换肤插件）

一个本地使用的 Chrome 插件（Manifest V3），把知乎变成 **VS Code**：

- **首页**：`recommend.ts / following.ts / hot_rank.ts` —— 信息流代码化（推荐 / 关注 / 热榜），点击字符串跳转原文，「加载更多」
- **问题详情页**：`{问题名}.ts` —— `TargetQuestion` 接口 + 每个回答一个 `answer_N` 代码块；正文图片折叠成 `[图片]` token，**点击展开 / 再点收起**（可在设置里改默认态）；`💬 评论/回复区` 按钮在底部打开 **终端风评论面板**（`zhihu-cli comments …`，走知乎官方 API，含楼中楼）；**下滑到底自动加载更多回答**（与知乎信息流同逻辑）；`▲ 赞同` 跳转原回答
- **专栏文章**（zhuanlan.zhihu.com）：`{标题}.md` —— front-matter（title/author/url）+ 正文 + 图片 token 折叠 + 评论面板（`article/{id}`）
- **搜索**：点侧边栏 `search.json`（或活动栏放大镜）弹出搜索框，回车后以 `search.json` 代码视图展示结果
- **设置**：侧边栏 `settings.json`（或活动栏齿轮）—— 点击值循环修改并自动保存：
  - `answersPerView`：详情页初始回答数（跟知乎一致（默认）/ 1 / 3 / 5 / 10，之后下滑自动加载）
  - `imageDefault`：正文图片默认收起 / 展开
  - `theme`：皮肤 **Dark+（默认，字符串浅黄）/ Light+ / Monokai / GitHub Dark**，阅读模式与 IDE 视图同步换色
- **老板键**：活动栏 Vue 绿色图标（设置按钮上方）或 `Alt+V` —— 右侧内容变成一段完整的假
  `App.vue`（template/script setup/scoped style，语法高亮齐全），再点复原——老板走过时假装在写代码
- **命令面板**：`Ctrl/Cmd+Shift+P`（输入 `>` 只看命令；直接输入则搜索当前列表）
- 弹窗总开关：即时生效、状态持久、首屏无闪烁
- **防闪现**：刷新或站内跳转（首页 ↔ 详情 ↔ 搜索）全程由 VS Code 界面覆盖——
  `document_start` 先挂出内联样式的全屏 Loader（不依赖任何 CSS 文件），ide.js 就绪后
  毫秒级无缝接管（Loader 只在脚本启动的几十毫秒内出现）；知乎是 SPA、站内导航不重载页面，
  插件轮询检测地址变化（带防误判：启动宽限 + 双次确认，不会陷入刷新循环）自动整页刷新重建视图；
  ide.js 异常时 Loader 1.5 秒后自动放行，页面不会卡死

## 快捷键

| 按键 | 作用 |
|---|---|
| `Alt+V` | 老板键：右侧内容 ↔ 假 Vue 代码 |
| `Ctrl/Cmd+Shift+P` | 命令面板 |
| `Esc` | 关闭命令面板 / 搜索框 / 评论面板 |

## 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 打开右上角「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」，选择本目录
   - Chrome 装在 Windows 上时，路径选择 `\\wsl.localhost\<发行版名>\www\my\zhihu_vscode`（本机 WSL 为 Ubuntu 24.04，通常是 `\\wsl.localhost\Ubuntu-24.04\www\my\zhihu_vscode`）
   - 若通过 WSL 网络路径加载异常，把整个目录拷贝到 Windows 本地磁盘后再选
4. 访问 [zhihu.com](https://www.zhihu.com/) 即可

## 覆盖范围

| 页面 | 视图 |
|---|---|
| `www.zhihu.com/`、`/hot` | IDE 视图（信息流三个文件 + settings.json） |
| `www.zhihu.com/question/*` | IDE 视图（详情页代码化） |
| `www.zhihu.com/search?q=*` | IDE 视图（search.json） |
| `zhuanlan.zhihu.com/p/*` | IDE 视图（{标题}.md） |
| 其他知乎页面 | 阅读模式（纯换肤） |

## 目录结构

```
├── manifest.json      # MV3 清单：内容脚本注入 + storage 权限 + 弹窗
├── css/skin.css       # 阅读模式换肤规则（作用域限定 html[data-zvsc="on"]，含 4 套皮肤变量）
├── css/ide.css        # IDE 视图 overlay 样式（CSS 变量化，4 套皮肤）
├── js/content.js      # 总开关状态管理（localStorage 缓存防闪烁 + storage 实时联动）
├── js/parse.js        # 知乎 DOM 解析器（信息流 / 热榜 / 搜索 / 问题详情 / 富文本摘行）
├── js/ide.js          # IDE 视图渲染与交互（文件树 / 代码 / 图片折叠 / 评论面板 / 设置 / Boss Key）
├── popup/             # 工具栏弹窗（总开关）
├── tools/gen_icons.py # 可选的图标生成脚本（默认不用图标，可删除）
└── README.md
```

## 原理

- IDE 视图是固定定位 overlay，**原知乎 DOM 完整保留**，数据全部来自页面解析与知乎官方
  Web API（`/api/v4/questions/{id}/answers`、`/api/v4/answers/{id}/root_comments`，
  同源 fetch 自带登录态）；Boss Key 只是 display 切换，瞬时完成
- IDE 视图在 `document_start` 立即构建（挂在 `documentElement` 上），设置经 localStorage
  同步缓存，**刷新时不再闪现原页面**；DOM 就绪后再解析渲染真实内容
- 详情页正文用 `parse.js` 的 `extractRich` 摘成代码行：文本转义、`<img>` 变成带索引的
  `[图片]` token，点击在对应行后插入/移除图片行实现折叠（重渲染后保持展开状态与滚动位置）
- 换肤 CSS 作用域限定 `html[data-zvsc="on"]`；皮肤经 `html[data-zvsc-theme]` 与
  `.zvsc-ov.zvsc-theme-*` 两组 CSS 变量切换，IDE 与阅读模式同步
- `content.js` 在 `document_start` 同步设属性（无闪烁）；弹窗与设置经
  `chrome.storage.onChanged` 联动所有打开的标签页

## 已知限制

- 知乎改版类名可能导致解析不到（代码区会显示注释提示），把新类名补进 `js/parse.js` 即可
- 评论接口依赖知乎 v4 API，若被风控 / 未登录，面板会显示错误注释行
- 不做代码块语法高亮（换肤范围之外）


