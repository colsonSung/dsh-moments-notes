# Moments for DeepSeek Harness

Moments is a local notes workspace for capturing ideas and rediscovering them in a timeline. Its single-column workspace follows the native Harness visual language and needs no separate server, account or build step.

## 使用

1. 安装并启用 `@local/moments-notes`。
2. 在 Harness 左侧全局面板中点击 **Moments**。
3. 在编辑器记录想法；正文内使用 `#工作/项目` 创建层级标签。
4. 通过左侧标签树、顶部搜索、置顶筛选和回收站找回或整理笔记；统计通过工具栏按钮打开。

## 功能

- 新建、编辑、复制、置顶、长文展开、删除确认、软删除、恢复和彻底删除。
- 回收站保留 30 天，可随时恢复；到期后由 Host 在启动时和每日后台任务中自动彻底删除。
- PNG/JPEG/WebP/GIF 图片附件与预览，纯图片笔记也可保存；每条最多 8 张、合计 10 MB。
- 层级标签自动补全与规范化、标签计数、全文搜索、最近搜索与组合筛选。
- Memo / Tag / Day 统计、活跃热力图、随机回顾、往年今日和关联笔记。
- JSON 合并/替换导入、JSON 完整备份、Markdown 导出。
- `moments_memo` Agent 工具通过同一 Host 仓储创建和搜索笔记。
- 桌面浮窗：工具栏 **Float** 按钮让 Host 拉起 `native/bin/moments-float`，一个真正的操作系统级窗口——窗口层级为 `.floating`，跨 Space 跟随，可以停在全屏应用之上，切换到别的应用也不会消失。窗口里可以速记、⌘/Ctrl+Enter 保存、粘贴截图；再次点 **Float** 按钮把它收起来。
- 两种形态：小浮窗（400×430）是 **Harness 输入框同款卡片**——标题行、占满的书写区（占位文字 "What's on your mind?"）、底部工具行（`#` 标签、图片、`Aa` 文字格式、无序列表、有序列表）和右侧的纸飞机发送键；不塞笔记列表。点头部右侧的展开按钮 ⤢ 变成完整面板（760×620）——上方是搜索框（支持正文和 `#标签`），中间是完整笔记记录（每条可置顶或移入回收站，悬停高亮），下方仍是同一张输入卡片；点折叠按钮 ⤡ 收回小浮窗，窗口左上角位置保持不变，切换用 0.22 秒 ease-in-ease-out 曲线。
- 浮窗头部：右侧 **✕** 关闭浮窗（进程退出，Host 随之知道窗口已关）；按住标题或头部空白处可拖动窗口。拖动由 AppKit 的拖动事件逐个跟踪——指针走多少、窗口走多少，实测跟踪误差 0–0.2px、终点不漂移；拖拽面在控件之下，**✕** 和展开键的点击不受影响。
- 工具行是真的能用的：`#` 在光标处插入标签，`Aa` 菜单给选区套上 **加粗/斜体/删除线/行内代码/标题/引用/链接**，两个列表键给当前行加 `- ` 或 `1. `；发送键和 ⌘/Ctrl+Enter 等价。
- 草稿不丢：书写过程中每停 3 秒把草稿交给 Host 存到 `moments-notes/draft.json`，关窗时（**✕**、收起、SIGTERM）先立即落盘再退出。重新打开浮窗时会还原上次的文字、附件（含图片字节）和编辑状态——原本在改某条笔记就继续改那条，笔记已被删则退回成新草稿。发送、取消或把内容清空都会清掉存下的草稿。
- 图片（三条路都能进附件）：图片键打开菜单 **Choose image…**（系统文件选择器，可多选，只列图片）或 **Paste image**（贴剪贴板）；在书写区按 **⌘V** 或走 **Edit ▸ Paste** 也会把截图变成附件（浮窗自带最小菜单栏，⌘V/⌘C/⌘A 因此可用）；把图片文件直接拖到卡片上同样能加。附件保留原文件名，单图 5 MB、单条合计 10 MB、最多 8 张，超限时错误直接显示在工具行上方。
- 应用内浮窗：桌面浮窗不可用时（没有编译 helper 的机器）自动回退，注册在 `shell.overlay`，始终浮在所有面板与新会话之上，可拖动调整位置。位置按视口坐标保存，切换插件或会话后不会跳位。
- 快捷入口：会话头部右侧和文档预览工具栏各有一个 ✎ 按钮，点一下开浮窗，再点一下收起来——不用先切到 Moments 面板。

## Design（原 Canvas）

左侧导航新增 **Design** 项（位于 Daily review 与 Trash 之间），把想法摊在一张没有边界的平面上。画布不是「白板贴便签」——它是一份**场景图**：带类型、带坐标、带层级、带连线的节点集合，存储格式与交互层一次打对，后续加 Figma 词汇只是往同一个模型里加类型。

- **滚轮缩放**：Ctrl/⌘ + 滚轮（触控板捏合同理）缩放画布本身，不是缩放整个页面——实现上用**原生非被动监听**，因为 React 的合成 `wheel` 是 passive 的，`preventDefault` 不生效。缩放锚定在指针位置，一格约 12.7%，deltaMode 会先归一化。
- **拖手柄缩放**：从按下时的原始尺寸重算，不累乘——一次拖动拆成多少帧，结果都一样。
- **缩放与移动都按世界单位**：拖动和缩放的位移都会先除以当前 zoom 再落到节点上，所以 21% 缩放下拖 60px 和 100% 下拖 60px 的视觉距离一致，不会把节点撑大。
- **坐标与撤销**：坐标域 ±1,000,000 px、缩放 0.05×–4×，坐标越界**夹住**而不是拒绝保存（NaN/Infinity 才拒绝——那是文档损坏，不是位置远）；撤销栈记录的是**完整文档**，拖动一个节点再撤销，其余节点一个都不会少。
- **双击编辑**：双击便签 / 文本 / 形状即进入编辑，`⌘/Ctrl + Enter` 提交、`Esc` 取消、失焦也提交。画布的指针捕获会把 `click`/`dblclick` 重定向到画布本身，所以双击是**从两次按下自己判定**的（同节点、无修饰键、第一次未拖动），判定窗口 1200ms 且用事件时间戳计时。
- **拖动容器**：**frame 是一块面**——按它内部任意位置即可选中并拖动，成员跟着走；**group 是一圈虚线**——只有边缘可抓，内部仍是透过它操作下面的内容。空 frame 同样可以拖动。
- **侧栏折叠**：Notes 侧栏标题右侧的 « 按钮把左栏收成 56px 的**图标栏**——Moments 标记 + 展开箭头，下面是全部五个入口（全部笔记 / PinNotes / 每日回顾 / 画布 / 回收站）收成的 32×32 图标键，名称在 `title` 与 `aria-label` 里；选中项带 ember 底色与左侧指示条。标签树、图层树和页脚在折叠时隐藏（56px 放不下）。再点展开恢复完整侧栏；状态记在 `localStorage`，刷新后保持。画布需要横向空间时很有用。
- **入口**：切到画布模式后，标题栏中间的搜索框换成操作提示（Drag to pan · ⌘ + scroll to zoom · V select · N sticky note · C connector）。
- **画布顶栏（一条 44px）**：分三个区——左侧**画板切换器**（你现在在看哪块画板，唯一的一级信息）、中间**工具栏**（选择/手/便签/文本/画框/矩形/椭圆/图片/连线 + 撤销重做，视觉重心）、右侧**保存状态点 + ⋯ 菜单**。低频操作全部收进菜单：New / Rename / Delete board、**铺开**（带来源选择）、**导出**（SVG / PNG），不再占用常驻空间。保存状态从一整句话降为一个点——灰=已保存、琥珀脉冲=保存中、绿=已保存、红=失败，文字留在 `title` 和读屏里。
- **画板**：一个工作区可以有多块画板（board）。当前画板 id 记在 `localStorage` 的 `moments-notes:canvas-active`，画板不存在时回落到列表第一个。
- **节点类型**：`note`（绑定一条 Moments 笔记，正文由实时笔记内容渲染）、`sticky`（画布私有的便签）、`text`（无边框的标题文本）、`shape`（矩形 / 椭圆 / 线段 / 箭头 / 多边形 / 星形）、`image`（粘贴或导入的图片）、`group`（逻辑容器）。便签底色用令牌 `amber` / `rose` / `sage` / `sky`，**无颜色只有 `none` 一个值**——没有「未设置」与「显式无色」两个说法并存。`note` 指向的笔记被删除时节点保留，显示「Note unavailable」，不静默消失。
- **铺开笔记**：画板条上的铺开动作带一个来源选择器——当前时间线的筛选结果 / 某个标签 / 全部笔记；一次把来源里的每条笔记变成一个 `note` 节点，按网格排布（间距 32 世界像素，列数随可视宽度自适应 4~8 列），落点在**当前视口中央**附近而不是世界原点。已经在画布上的同一条笔记**不重复新建**，只移动到新位置。铺开是一次普通编辑：进撤销历史，走自动保存。
- **连线与连线标签**：Connector 工具从一个节点拖到另一个节点即可连线，端点按 `auto` 取节点矩形边界交点，渲染为**三次贝塞尔曲线**加箭头（控制点沿锚点方向偏移，读起来是流向而不是直线）。带 `label` 的连线在曲线中点画出可读标签，空标签不画；双击连线就地编辑标签（⌘/Ctrl+Enter 提交、Esc 取消），写回文档后重新渲染。
- **Frame（画框）**：新工具 **Frame（F）**，或选中 ≥1 个节点后点动作条的 Frame 按钮。Frame 是带**标题**（框外左上，双击就地改名）和**可选背景**的实体容器，成员节点绝对定位、拖动 Frame 边框整体跟随——与 Figma 的 frame 对应。与 `group` 的分工：group 是透明逻辑分组（虚线、无标题），frame 是有边界有标题的内容容器。两者共用一套派生矩形与「点边框选中、拖边框移动、解散留成员」的交互。
- **画板管理**：画板条上的选择器升级为**下拉面板**——搜索框按标题过滤、**星标画板排在最前**、其余按最近更新倒序、底部新建。星标是画板级元数据（`canvas-star` 单独写，不动场景文档）。
- **图层折叠**：图层树里 group / frame 行带 ▶ 展开箭头，折叠状态按画板记住（视图状态，不进文档）。
- **群组**：选中 ≥1 个节点 → 「群组」→ 生成一个 `group` 节点，`members` 是被选中的节点 id；群组只画一层虚线边框 + 标题（取第一个成员的文本前 24 字），**不填充**——它不是一张卡片。拖动群组（点它的边框）→ 成员整体跟随；选中群组 → 「解散」→ 群组节点删除、成员原地留下。群组的矩形是**派生值**：成员包围盒 + 12px 内边距，客户端每次变更后重算回写。
- **概览模式**：缩放 **< 0.35** 时节点只画色块、不画文字，≥ 0.35 恢复文字——几百个节点时画布仍然可读、渲染仍然快；概览态下不能双击进编辑。
- **形状与样式**：新工具 **矩形（R）**、**椭圆（O）**，在空白处点击即落位。选中节点后出现**样式条**：填充色（8 色板 + 无）、描边色、描边粗细、圆角、透明度、文字对齐；色板是固定 8 色 + 无，取自 Moments 既有语义色域，**不新增色系**。
- **图层面板**：画布模式下左侧栏的 Tags 区换成 **Layers** 树——每行是类型图标 + 名称（缺省名按类型生成：`Sticky 1`、`Note 2`…）+ 显隐开关；点选与画布选择双向同步，群组的成员在树上缩进在群组下面。
- **对齐**：选中 ≥2 个节点出现对齐条——左 / 水平居中 / 右 / 上 / 垂直居中 / 下，以及水平分布 / 垂直分布；**以选区的包围盒为基准**，单选时对齐到画布。
- **快捷键**：⌘/Ctrl + 滚轮锚点缩放、⌘0 适配全部、⌘1 复位 100%；单击选择、**Shift/⌘ 单击在选择里切换该节点**（已选则移出、未选则加入）、空白处拖动框选（框选矩形在按住拖动时出现，松开指针后消失，由选中框取代）、Esc 清空、⌘A 全选；Delete/⌫ 删除选中节点及其连线、⌘D 复制选中节点（偏移 24px）；方向键移动 1px、Shift+方向键 8px；双击节点编辑正文、Enter 进入编辑；工具键 V 选择 / H 平移 / N 便签 / T 文本 / R 矩形 / O 椭圆 / C 连线。
- **撤销 / 重做**：⌘Z / ⌘⇧Z，快照式历史，最多 40 步。
- **自动保存**：改动后 **600ms 防抖**自动保存整份文档（`nodes` / `edges` / `camera` 完整提交）；保存成功后用 Host 返回的权威文档回填，保存失败不丢本地状态，芯片显示「保存失败」并可手动重试。
- **笔记联动**：笔记卡片操作区的 **Add to canvas** 把笔记放到当前画板视口中心；`note` 节点就地编辑会回写原笔记，画布节点即时反映新正文。
- **导出**：当前画板（或选区）导出为 **SVG**（矢量，文字转 `<text>`）或 **PNG**（2× 光栅），纯客户端、场景 → SVG 字符串 → PNG 用 `Image` + canvas 绘制，不依赖第三方库；SVG 带背景色，导出结果与画布观感一致。
- **图片（粘贴 / 拖放 / 导入）**：**⌘/Ctrl+V** 把剪贴板里的截图直接放进画布（落在当前视口中央）；把 PNG / JPEG / WebP / GIF / **SVG** 文件拖到画布上会落在指针位置；工具条的图片按钮打开文件选择器，可一次选多张。图片按原比例缩放到 480px 宽以内，节点只存一个 id，字节存在 `moments-notes/assets/<uuid>.<ext>` 并通过 `/api/moments-notes/asset` 读回——画板文档因此保持很小，每次自动保存不会重写图片。
- **Figma 文件导入（`.fig` / `.jam` / `.deck`）**：把 Figma 文件直接拖进画布即可——Design（`.fig`）、**FigJam 白板（`.jam`）**、Slides（`.deck`）都走同一条路。`.fig` 没有官方规范，但它是**自描述格式**——每个文件内嵌自己的 Kiwi schema（约 534 个类型定义），所以第三方可以完整解析。解析在 **Host 侧**完成（`lib/fig-import.js` + `openfig-core`，MIT），客户端只接收结果。映射到本引擎的语义：渐变（两端点 + 角度）、投影（offset/radius/alpha）、自动布局（row/column、gap、padding、对齐）、字族 token 与 100–900 字重；组件与实例仍扁平化为分组，导入报告会写明。
  - **还原范围**：页面 → 垂直排列的内容；frame/SECTION → 我们的 frame（保留标题、填充、圆角、位置尺寸、旋转）；group → group；文字 → text（保留字符、字号、颜色、对齐）；矩形/椭圆/线段/星形/多边形/FigJam 形状 → shape（**带标签**）；**FigJam 便签 → sticky**（文字在节点名里）；**FigJam 连线 → 画布连线**（两端锚点方向也保留）；图片填充 → image；矢量路径 → 转成 SVG 资产（外观 100% 保留，不可编辑）。
  - **明确降级**：组件实例展开成 group；嵌套 frame 压平成同级容器（中间容器会合并掉）；FigJam 的菱形降级成矩形、求和节点降级成椭圆；渐变取首色近似；自动布局、变量、效果、约束不还原；组件定义（SYMBOL）不导入而是计入报告。**每一处降级都会出现在导入报告里**，不静默丢失。
  - **打开即定位**：Figma 白板常常几万像素宽，导入后会自动框住新内容；打开任何画板时若保存的视图里一个节点都看不到，也会自动框住内容，不会打开在空白纸上。
  - **安全边界**：单文件 ≤50MB、节点数 ≤20000、图片 ≤500 张且单张 ≤10MB；只解析不执行；`openfig-core` 懒加载，解析器不可用也不影响插件其它功能；导入在内存里构建完整节点表后一次性写入，不会留下半导入的画板。
  - **不满意时**：Figma 里 Export → SVG 仍然是零成本的高保真路径（保留矢量、可再导出）。
- **右键菜单**：画布上右键弹出上下文菜单。右键未选中的节点会先选中它，菜单里的命令永远作用于指针所指的对象。
  - 节点：Duplicate ⌘D、Delete ⌫、Bring to front ]、Send to back [、Group selection ⌘G、Frame selection ⌥⌘G、Ungroup（选中有容器时）、Hide/Show ⇧H、Lock/Unlock ⇧L、Flip horizontal、Flip vertical。单击时 Group 置灰。
  - 空白处：Select all ⌘A、Zoom to fit ⇧1、Zoom to 100% ⌘0。
  - 菜单贴近视口边缘时会自动向内收，不会被裁掉；点击别处或 Esc 关闭。
- **锁定**：锁定后不能拖动和缩放，但仍可选中（Figma 语义），用于固定背景图或参考框。

数据写在当前 profile 的 `moments-notes/canvases.json`，**与 `notes.json` 完全分离**：画板文件损坏只让画布不可用，笔记照常工作，反之亦然。画板不存在时 Host 回 `CANVAS_NOT_FOUND`（HTTP 400），而不是笼统的 500。

### 画布的格式扩展

- **版本不变**：`version` 仍是 1；新增字段向后兼容，新增节点类型不升版本。
- **新增字段**：`shape`（`rect` / `ellipse` / `line` / `arrow` / `polygon` / `star`）、`sides` / `points`（多边形与星形）、`fill` / `stroke` / `strokeWidth` / `opacity` / `radius` / `textAlign`（样式）、`flipX` / `flipY`（翻转）、`members`（容器成员）、`title`（frame 标题）、`assetId`（图片节点引用的存储资产）；画板级 `starred` 与 `comments`。颜色一律 `#rgb` / `#rrggbb` 小写字面量，不接受颜色名、rgba、hsl。
- **连线是一个对象**：每条连线带 `strokeWidth`（1–8，默认 2）、`dash`（`solid` / `dashed` / `dotted`）、`startArrow` / `endArrow`（`none` / `arrow` / `triangle` / `circle`）、`curve`（`bezier` / `straight` / `elbow`）、`stroke`（线条颜色，空=跟随主题）以及两端的锚点 `fromAnchor` / `toAnchor`（`auto` / `top` / `right` / `bottom` / `left`）。**点选连线**会浮出样式条：粗细 **1/2/3/4/6/8** 六档、线型 3 档（实线 / 虚线 / 点线）、曲线 3 档（弧线 / 直线 / 折线）、**线条颜色**（8 色令牌 + 自定义取色 + 恢复默认）、两端箭头（再点一次取消）、删除。**连线时磁吸**——两端自动吸到离指针最近的连接点，拖动时会高亮将要吸附的点。**吸边即垂直**——`auto` 锚点解析成具体的一条边（宽扁节点优先左右、瘦高优先上下），锚点取边中点，连线沿法线离开与进入，elbow 只出现直角；**箭头按端点切线几何绘制**（不是 SVG marker），任何缩放下屏幕尺寸一致，不会偏离线尾；导出与画布共用同一套画法。
- **图层是树，不是列表**：`group` 与 `frame` **可以互相嵌套**（frame 装 group、group 装 frame、任意层级都行）。成员关系仍是单亲——一个节点只能属于一个容器；且有向无环：容器不能包含自己的祖先。容器的矩形由其成员包围盒自底向上算出（最深的先算），所以父框永远罩住子框；拖动一个容器会带上它的**整棵子树**。
- **容器两种**：`group`（透明逻辑分组）与 `frame`（带标题与背景的实体画框）共用同一套 `members` 规则与派生矩形；**容器永远画在成员之下**，与数组顺序无关。
- **数组顺序即 z 序**：靠前 = 更靠底，靠后 = 更靠顶；「置于顶层 / 底层」= 改数组顺序，不新增 `z` 字段。
- **容器约束**：`members` 里的节点必须存在、不得是容器自身、不得嵌套容器（group/frame 交叉也不行）、一个节点不得同时属于两个容器。
- **星标是画板元数据**：`canvas-star` 单独写，不替换场景文档（与笔记的 `pin` 同款）。
- **批注也是独立通道**：`canvas-comment-add` / `canvas-comment-resolve` / `canvas-comment-delete` 三个方法，`canvas-save` 从不增删批注——场景保存不会误删讨论。
- **图片是文件引用**：节点只存 `assetId`，图片字节存在 `assets/` 目录；删除画板时，不再被任何画板引用的图片会被一并清理。

扩展路线（V2 之后）按「模型先加类型、渲染后加能力」推进：自动布局、组件与实例、矢量路径编辑、约束、协作。新增字段向后兼容，新增节点类型时 `version` 保持 1。完整契约见 `docs/canvas-design.md` 与 `docs/canvas-v2-design.md`。

## Design 引擎：Agent 直接出设计稿（M1）

Design 不只是给人画的画布：Agent 通过四个工具写**同一份**场景文档，产物就是 Design 面板里能打开的板。

- `design_begin({ title, screenTitle, width, height, background })`：建板 + 落一块根 frame（一块屏幕）。
- `design_nodes({ boardId, ops })`：事务式批量 `insert` / `update` / `delete`，`parentId` 把节点放进 frame/group；整批要么全成要么全拒。
- `design_finish({ boardId, title })`：终局校验（空板、无屏幕会被点名）并汇总。
- `design_inspect({ boardId?, view?, nodeIds?, limit?, region?, scale? })`：读回画板或指定节点，后续编辑按 id 精确改，不靠猜。`view` 决定读回来的是什么：
  - `view: "summary"`（默认）：节点清单；
  - `view: "issues"`：**审一遍稿**——文字超出盒子、同级元素互相压住、成员跑出所在 frame、文字与背景对比度不足；每条带 `nodeId`、一句人话和修改建议，最多 40 条；
  - `view: "image"`：**看一眼画面**——请打开着的页面把这块板渲染成 PNG 写进 `snapshots/`，返回路径（可带 `region` 裁一块、`scale` 放大到 3×），Agent 随后读该图判断效果；
  - `view: "import"`：上次 Figma 导入到底进来了什么、跳过了什么。
- **约束**：子节点可声明 `constraints {horizontal, vertical}`（left/right/center/left-right/scale），缩放容器时按约束重新落位；默认 left/top 与旧文档一致。
- **吸附与对齐参考线**：拖动到邻居边缘/中线附近 6 像素内自动吸附并画参考线（Alt 关闭），参考线不落盘。
- **设计语义字段**：`fontFamily`（sans/serif/mono/display）、`fontWeight`（100–900）、`lineHeight`（0.8–3）、`letterSpacing`（px）、`shadow {x,y,blur,color,opacity}`、`gradient {from,to,angle}`；全部可选、缺省为 null，`version` 仍是 1。
- **性能 HUD**：画布右栏开关，实时显示 FPS 与实际绘制节点数（如 `60 FPS · 12/300`），用来判断大板交互是否流畅。
- **大板裁剪**：节点超过 120 个时只渲染视口能触及的部分（选中/编辑节点除外），300 节点铺开只构建 10 个节点 DOM。
- **富文本**：文本节点可用 `spans` 写分段样式（字重、颜色、斜体、下划线），画布/ SVG / HTML 三端一致；编辑器打字会清空分段（当前编辑器写纯文本）。
- **模糊与混合**：节点可设 `blur`（0–200px）与 `blend`（12 种混合模式），画布用 CSS、SVG 导出合并成单条 filter、HTML 导出同样生效。
- **Inspector**：选中节点可一键套用画板颜色/渐变/字体令牌，成员节点可用 Pins 下拉改约束。
- **曲线手柄**：选中路径后可拖 in/out 手柄改弧度，工具条「Curve / Straighten」一键给全部锚点加手柄或清空。
- **钢笔与锚点**：工具条 P 进入钢笔，点出锚点、Enter/双击结束、点回起点闭合；选中路径后拖锚点改形状。
- **矢量路径**：`shape: "path"` + `path { closed, points[] }`，锚点可带 in/out 手柄渲染为三次贝塞尔，闭合可填色、开放只描边。
- **组件与实例**：`type: "component"` 是主组件，实例写 `{ type: "instance", componentId, x, y, overrides }`；每次保存由 Host 展开成真实节点（幂等），改主组件即全实例级联，实例可覆盖文案/颜色/尺寸等。
- `design_tokens({ boardId, colors?, gradients?, type?, mode? })`：定义/更新设计令牌（颜色、渐变、排版），节点用 `fillToken`/`typeToken` 等引用，改令牌即全页重算。
- **工具卡预览**：设计工具的结果在会话里显示画板 SVG 预览，并提供「在 Design 中打开」跳转（预览与导出共用同一个 SVG 渲染器）。
- **截图回读不需要打开画布**：`view: "image"` 的请求由页面里的常驻响应器处理——它读已保存的文档、用导出同一个渲染器画出来、把 PNG 传回 Host；因此人在会话里聊天时 Agent 也能看图，不要求把 Design 面板停在前面。
- **导入报告会留存**：`.fig/.jam/.deck` 导入后，节点数、各类导入量、被跳过的组件/切片/未知节点（带前 20 个样本名）、缩略图警告都写进 `import-reports.json`；Design 顶栏 `⋯ → Last import report` 随时能翻，Agent 也能用 `view: "import"` 读同一份。
- **附带一个设计 skill**：`skills/moments-design/` 随插件安装并注册为 bundled skill，讲的是「怎么画得能改」——栈式布局优先于绝对坐标、令牌优先于硬编码、组件优先于复制、写完必须过 `issues` 与看图两步；工具描述说"能写什么"，skill 说"什么值得写"。
- `design_export({ boardId, format: 'html'|'svg'|'spec', path? })`：导出可交付产物——独立 HTML+CSS 页面、SVG、设计规格 JSON（色板/字号表/圆角/投影/流动容器）；示例见 `docs/examples/`。SVG 与 PNG 走与画布同一套渲染语义：真实字号/字重/行高、自动换行、导入的图片内嵌为 data URL、投影/渐变/矢量路径都画出来（以前文字固定 13px、图片直接缺席）。
- **自动布局**：frame/group 声明 `layout: row|column` + `gap` + `padding` + `align: start|center|end|stretch`，成员坐标在保存时由 Host 算好写回；容器里的成员在画布上只能选中、不能拖动（否则下一次自动保存会被布局重排覆盖）。

写路径是 Host 的 `lib/canvas-repository.js`，合法性仍由 `lib/canvas-domain.js` 独家判定；
因此 Agent 建出来的板与手画的是同一种文档，不存在「生成一张图 + 人工重画」的断层。
完整路线（最终形态、能力矩阵、M2–M6 里程碑与验收）见 [docs/design-engine.md](./docs/design-engine.md)。

## 桌面浮窗是怎么实现的

页面本身开不出系统窗口：Harness 桌面外壳对所有 `window.open` 返回 `deny`。所以桌面浮窗不是网页浮层，而是 Host 拉起的原生进程：

- `native/MomentsFloat.swift`：AppKit/SwiftUI 的 accessory 应用，`NSWindow` 用 `.floating` 层级、`canJoinAllSpaces` + `fullScreenAuxiliary` 行为，无边框透明窗口里画一张圆角卡片，可拖动、可缩放，关闭即退出。卡片用发丝描边 + 收紧的阴影：阴影必须完整落在透明窗口内，否则会被系统裁成一个生硬的灰方块。配色全部用系统语义色（`separatorColor`、`textBackgroundColor`、`controlAccentColor`），因此跟随系统深浅色。头部右侧的 **✕** 和展开/折叠都是普通 SwiftUI 按钮；拖动手势放在头部底层的透明层上，永远不会盖住按钮。
- `native/build.sh`：编译 `native/bin/moments-float`。脚本自己找编译器和 SDK，因此在 Xcode 许可未同意（`xcrun` 不可用）时也能编译。
- `lib/desktop-float.js`：Host 侧进程管理，按 JSONL 与窗口通信。
- `lib/float-bridge.js`：窗口与仓储之间的桥——窗口发 `query`（带搜索词），Host 用同一个仓储过滤后回 `notes`；窗口回传 `create` / `update` / `trash` / `pin`；仓储每次写入（包括 `moments_memo` 工具写入）都会刷新窗口里的列表。

协议细节见 `native/README.md`。

## 平台边界

桌面浮窗是 macOS 原生实现，需要先编译 `native/bin/moments-float`；没有这个二进制时，插件会明确提示，并回退到应用内浮窗。`/api/moments-notes/mini` 的独立页面在普通浏览器中仍可直接打开，它没有置顶按钮——浏览器窗口无法真正常驻最前。

## 数据与迁移

数据写入当前 profile 的 `moments-notes/notes.json`。每次变更采用串行队列和原子替换，重启后重新加载。首次启动时，如果新文件不存在，会依次从旧版 `shiguang-notes/notes.json`、`flomo-notes/notes.json` 复制数据；旧文件保留为备份，不会先删除或覆盖新文件。

页面只通过 Harness 已鉴权的 `/api/moments-notes` 通道访问 Host；不使用 iframe，不加载第三方脚本。普通删除需要确认，30 天保留期到期后不可恢复；替换导入同样需要确认。公开分享、微信同步和云端账号同步不在本地插件范围内。

## 开发验证

```bash
node --test tests/*.test.js
node --check index.js
node --check client.js
native/build.sh && native/bin/moments-float --self-test
```
