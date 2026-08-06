---
name: "Marginalia"
description: "一间把阅读、边注与创作安静连接起来的数字书斋"
colors:
  canvas: "#f4f1ea"
  canvas-ink: "#ebe4d8"
  surface: "#fffdf8"
  surface-raised: "#ffffff"
  surface-muted: "#f8f5ee"
  paper: "#fffaf0"
  ink: "#20231f"
  ink-soft: "#575c50"
  ink-muted: "#87897e"
  line: "#ded6c8"
  line-strong: "#c8bcaa"
  pine: "#2f604a"
  pine-deep: "#244d3b"
  pine-soft: "#e5f0e8"
  antique-gold: "#b8812f"
  secondary-wash: "#fff7e4"
  secondary-ink: "#7c571c"
  danger: "#b34235"
  success: "#2d7d4a"
  highlight-yellow: "#f6d86f"
  highlight-green: "#9ccc90"
  highlight-blue: "#96c3df"
  highlight-pink: "#e8a3b0"
typography:
  display:
    fontFamily: "\"Noto Serif SC\", \"Source Han Serif SC\", \"Songti SC\", Georgia, serif"
    fontSize: "46px"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "0"
  title:
    fontFamily: "\"Noto Serif SC\", \"Source Han Serif SC\", \"Songti SC\", Georgia, serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  highlight: "2px"
  compact: "6px"
  control: "7px"
  surface: "8px"
  status: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  page: "40px"
components:
  button-primary:
    backgroundColor: "{colors.pine}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
    height: "38px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.pine-deep}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "{colors.secondary-wash}"
    textColor: "{colors.secondary-ink}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
    height: "38px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
    height: "38px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "9px 11px"
    height: "40px"
    typography: "{typography.body}"
  note-chip:
    backgroundColor: "{colors.pine-soft}"
    textColor: "{colors.pine}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "24px"
---

# Design System: Marginalia

## Overview

**Creative North Star: "静谧书斋"**

Marginalia 的界面像一间经过整理的私人书斋：温暖但不怀旧，精致但不炫耀。宣纸米白承载长时间阅读，墨松绿只在需要方向与确认时出现，衬线标题带来书卷气，系统无衬线字体保证工具界面的清晰和效率。

界面以精致克制为原则。层次来自纸张色差、细边框和低对比度环境阴影，而不是强烈玻璃效果或夸张悬浮。阅读内容是视觉中心；控件、状态和创作工具以稳定、安静的方式退居其后。

**Key Characteristics:**

- 暖纸色底与深墨色文字形成低刺激、长时间可读的基调。
- 墨松绿是稀有而明确的操作与状态信号。
- 衬线字体负责阅读气质，无衬线字体负责操作清晰度。
- 小圆角、细边框和温和阴影建立克制的层次。
- 中文文字优先保持完整、稳定、清楚的排布。

## Colors

色彩取自纸张、墨迹、松针与旧书装帧，整体低饱和，功能色只在有明确语义时出现。

### Primary

- **墨松绿：** 用于主要操作、活动导航、焦点边框、同步进度和品牌标记；悬停时转为更深的墨松色。
- **墨松浅雾：** 用于轻量选中、幽灵按钮悬停和笔记胶囊，不承担大面积背景。

### Secondary

- **旧金：** 用于眉题和少量编辑提示，为书斋基调加入克制的装帧感。
- **浅金纸：** 仅服务次级操作和强调，不与主操作争夺注意力。

### Neutral

- **宣纸米白：** 全局画布，叠加非常轻的纸纹与纵向明暗。
- **温白纸面：** 卡片、输入框和面板的主要表面。
- **墨黑：** 主文本；柔墨和淡墨分别承担说明与元数据。
- **亚麻线：** 边框、分隔线和结构轮廓；较强版本只用于需要更明确边界的区域。

### Tertiary

- **批注四色：** 柔黄、叶绿、雾蓝与旧粉只用于原文划线和对应的批注状态。
- **成功与危险色：** 只表达真实结果、错误和破坏性操作，不作为装饰。

### Named Rules

**The One Ink Rule.** 墨松绿只用于品牌、主要行动、焦点或当前状态；同一视区不要让多个绿色元素同时争夺主导权。

**The Quiet Paper Rule.** 大面积背景保持低饱和暖中性色，不使用高饱和科技蓝、夸张渐变或彩色玻璃底。

## Typography

**Display Font:** Noto Serif SC / Source Han Serif SC / Songti SC，回退到 Georgia 与系统衬线字体<br>
**Body Font:** 系统无衬线字体，优先 Segoe UI、PingFang SC 与 Microsoft YaHei

**Character:** 衬线标题像书名页与章节题，稳重且有人文感；无衬线正文和控件像整理良好的索引卡，清楚、直接、不抢内容。

### Hierarchy

- **Display**（700，响应式 30–46px，1.12）：仅用于书库与创作工作台的一级标题。
- **Title**（700，18px，1.35）：用于书名、面板标题和重要卡片标题。
- **Body**（400，15px，1.65）：用于说明、笔记与操作内容；移动端可降至 14px。
- **Label**（700，12px，0.08em）：用于英文眉题和短元数据；只在短标签中使用大写。

### Named Rules

**The Chinese First Rule.** 中文文字不得因固定高度、过窄容器或强制单行而乱码、串行、挤压或被意外截断；仅对可恢复的书名和短元数据使用省略。

**The Two Voices Rule.** 衬线用于阅读语境与标题，无衬线用于导航、表单和状态；不要引入第三套装饰字体。

## Layout

产品采用“主界面 → 独立工作页”的页面层级。主界面以自适应书卡网格组织书库，并提供进入创作的唯一入口；点击书籍进入独立阅读页，点击创作入口进入独立创作页。阅读和创作不互相直达，均通过“返回主界面”退出。阅读器以 AI 面板、正文阅读区和笔记面板构成可收放三栏；创作工作台以素材、感想、稿件三栏呈现连续流程。页面横向留白以 40px 为基准，面板间距主要为 16px，内部密度以 8px、12px、16px 递进。

在 1180px 以下，创作工作台从三栏降为两栏并让稿件区占满下一行；在 900px 以下，页头、阅读面板与工作台转为单列，操作区允许换行，阅读控制栏保持覆盖正文的浮层；在 560px 以下，卡片内容和工具条进一步纵向堆叠。响应式变化优先保证文字完整和操作可达，不依赖固定底部导航或横向压缩维持桌面结构。

## Elevation & Depth

系统采用温和分层。静止卡片使用近乎不可见的短阴影，悬停与浮层使用更宽、更柔的棕灰环境阴影；纸面色差和亚麻色边框仍是主要的层次来源。模糊只用于顶栏、选择工具条和模态遮罩等确实位于内容上方的元素。

### Shadow Vocabulary

- **纸面贴合：** `0 1px 2px rgba(55, 45, 31, 0.08)`，用于静止导航、卡片和工作面板。
- **轻柔抬升：** `0 10px 28px rgba(55, 45, 31, 0.12)`，用于悬停卡片和重要状态条。
- **浮层聚焦：** `0 22px 60px rgba(55, 45, 31, 0.18)`，仅用于模态框与 Toast。

### Named Rules

**The Warm Shadow Rule.** 阴影使用带棕色的低透明度环境色，不使用冷黑硬阴影或发光描边。

**The Flat-at-Rest Rule.** 普通表面在静止时接近纸面贴合；只有交互响应或真实浮层才能明显抬升。

## Shapes

形状以小而稳定的圆角为主：主要表面为 8px，按钮为 7px，紧凑控件为 6px。10px 只用于需要更柔和包裹感的状态条；999px 胶囊只用于进度条、计数、颜色选择与极短标签。细边框负责建立秩序，纸张和书封轮廓保持近矩形。

## Components

### Buttons

按钮精致克制，尺寸紧凑但不拥挤。

- **Shape:** 小圆角矩形，默认高度 38px、圆角 7px、内边距 9px 14px。
- **Primary:** 墨松绿底与温白文字，仅用于当前区域的主行动。
- **Hover / Focus:** 悬停上移 1px并出现轻柔阴影；键盘焦点以半透明墨松绿焦点环表达。
- **Secondary / Ghost:** 次级按钮使用浅金纸面；幽灵按钮透明且无静止阴影。
- **Danger:** 危险色只用于明确的删除或不可逆操作。

### Chips

- **Style:** 短标签与计数使用胶囊形；笔记操作采用墨松浅雾背景与墨松绿文字。
- **State:** 彩色圆点只承担划线颜色选择，不承载文字或通用操作。

### Cards / Containers

- **Corner Style:** 主要卡片和工作面板使用 8px 圆角。
- **Background:** 温白纸面配合极轻暖色渐层；感想面板可使用低对比度横线纸纹。
- **Shadow Strategy:** 静止时贴合纸面，悬停时温和抬升。
- **Border:** 使用亚麻色半透明细边框。
- **Internal Padding:** 以 12px 或 16px 为主。

### Inputs / Fields

- **Style:** 温白背景、1px 亚麻边框、8px 圆角；普通输入高度不低于 40px。
- **Focus:** 边框转为墨松绿并出现 3px 低透明度焦点环。
- **Error / Disabled:** 错误使用危险色语义；禁用降低不透明度并取消阴影。

### Navigation

品牌顶栏只出现在主界面，使用半透明温白纸面、细底边和极轻阴影。阅读页和创作页不显示全局标签导航，而是在各自页头提供“返回主界面”。移动端同样不使用固定底部导航，让阅读内容占据完整安全视口。品牌标记是克制的方形墨松绿书章，不改成圆形应用气泡。

### Book Card

书卡以窄书封、书名、作者、元数据和阅读进度建立清晰层级。标题最多显示两行，书封使用深绿装帧渐层与字母标记；只有整张卡片悬停时抬升，删除操作保持局部且克制。

### Selection Toolbar

文字选择工具条是少数允许胶囊轮廓的浮动组件。它只容纳四色圆形划线按钮和短笔记动作，使用半透明纸面、轻模糊与中等环境阴影，不能扩展成通用胶囊按钮语言。

## Do's and Don'ts

### Do:

- **Do** 让宣纸米白、温白纸面和墨色文字承担大部分界面面积。
- **Do** 用墨松绿明确主行动、当前状态和键盘焦点。
- **Do** 通过 8px、12px、16px 的节奏组织局部间距，通过 40px 建立桌面页面留白。
- **Do** 在窄屏把多栏工作区真实重排为单列，并允许中文按钮与状态文字换行。
- **Do** 保持衬线标题与无衬线工具文字的双重声音。

### Don't:

- **Don't** 使用高饱和科技蓝、大面积玻璃拟态或夸张渐变替代现有纸张与墨色体系。
- **Don't** 使用卡通插画、拟物小物件或装饰图标制造“书卷感”。
- **Don't** 把普通按钮、卡片和输入框全面改成过度圆润的胶囊形。
- **Don't** 用强冷黑阴影、霓虹光晕或多层浮动卡片制造高级感。
- **Don't** 为保持桌面布局而压缩、串行或截断关键中文文字。
