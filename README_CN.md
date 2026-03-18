[English](README.md) | [中文](README_CN.md)

# w2agent

**每个网站本身就是一个 Agent。** w2agent 能够审计、生成并将任意网站部署为一个实时 Agent 服务器——可被 Claude、GPT 及任何兼容 MCP 的 AI 工具发现和查询。

<!-- gif: cli-audit — terminal running `npx w2agent audit https://stripe.com`, score output scrolling in -->

```bash
npx w2agent audit https://your-site.com     # 评分检测
npx w2agent agentize https://your-site.com  # 部署为 Agent 服务器
```

```
  w2agent audit — AI 就绪性报告
  ────────────────────────────────────

  URL: https://your-site.com
  已扫描页面数: 12
  平台: WordPress (置信度 95%)
  耗时: 4.2s

  总体评分: 72/100 (C)

  Bot 可访问性          ████████░░  82/100
  结构化数据            ██████░░░░  64/100
  内容质量              ████████░░  78/100
  Agent 发现            ███░░░░░░░  35/100
  Agent 协议            ██░░░░░░░░  22/100
  技术基础              █████████░  91/100

  主要问题:
  ✗ 未找到 llms.txt                          (修复后可获 +15 分)
  ✗ 8/12 个页面缺少 Schema.org JSON-LD       (修复后可获 +12 分)
  ✗ 缺少 /.well-known/agent-card.json        (修复后可获 +8 分)
```

## 为什么选择 w2agent？

大多数网站对 AI Agent 来说是不可见的。Agent 无法找到你的文档，会在你的定价上产生幻觉，甚至完全跳过你的网站——因为你的内容与试图使用它的工具之间没有机器可读的契约。w2agent 填补了这个空白。

| 没有 w2agent | 有了 w2agent |
|----------------|-------------|
| Agent 在你的文档上产生幻觉——基于过时的爬取数据训练 | `agentize` 提供实时内容；Agent 始终查询当前网站 |
| 在用户投诉之前，无法知道你的网站对 Agent 不可访问 | `audit` 在几秒内评估 60 项检查，精准显示阻碍 Agent 的问题 |
| AI 找不到你的菜单、营业时间或预订页面 | 结构化数据 + `agentize` 将这些内容作为可查询工具暴露出来 |

## 处理流程

四个步骤，将任意网站变成可查询的 AI Agent：

| 步骤 | 命令 | 执行内容 |
|------|---------|-------------|
| **1. 审计** | `npx w2agent audit <url>` | 通过 47+ 项检查评估 AI 就绪性，找出阻碍 Agent 的问题。 |
| **2. 生成** | `npx w2agent generate <url>` | 生成 llms.txt、agent-card.json、schema-org.json 等文件。 |
| **3. 集成** | `npx w2agent integrate <url>` | 安装平台原生文件（WordPress 插件、Next.js 中间件）。 |
| **4. 部署** | `npx w2agent agentize <url>` | 将网站托管为实时 Agent 服务器，地址为 `<slug>.agent.w2agent.dev`。 |

完整的分步方法论——网站分析、Agent 架构决策、输出验证和质量评估——请参阅 [AGENTIZE.md](AGENTIZE.md)。

## Agent 网络

每个已部署的网站都会加入共享网络——可通过 [w2agent 目录](https://w2agent.dev/directory)和 **Meta Agent** 发现服务器访问。

<!-- gif: meta-agent-discovery — Claude Desktop showing `search_websites` tool call, returning a list of 5 dev-tool agents -->

**在 Claude Desktop 中使用任意 Agent**，添加 Meta Agent 端点：

```json
{
  "mcpServers": {
    "w2agent-meta": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agent.w2agent.dev"]
    }
  }
}
```

连接后，Claude 可以发现并查询目录中 100+ 个网站中的任意一个：

> "我正在构建一个 SaaS 应用。你有哪些关于 Next.js、Supabase 和 Stripe 的 Agent？"

<!-- gif: env-synthesis — Claude synthesizing a .env.example from 3 different site-agents in one response -->

**单个 Agent** 可直接访问：
- 托管版：`https://<slug>.agent.w2agent.dev`
- 自托管版：将生成的 Agent 服务器部署到 Vercel 或 Cloudflare Workers

6 个类别共 18 个已部署网站示例（2026 年 3 月）：

| 网站 | 类别 | 工具数 | 知识页面数 | 评分 |
|------|----------|-------|----------------|-------|
| [vercel.com](https://w2agent.dev/sites/vercel-com) | 开发工具 | 3 | 1,999 | B 63 |
| [sentry.io](https://w2agent.dev/sites/sentry-io) | 开发工具 | 3 | 50 | B 62 |
| [linear.app](https://w2agent.dev/sites/linear-app) | 开发工具 | 3 | 805 | B 60 |
| [launchdarkly.com](https://w2agent.dev/sites/launchdarkly-com) | 开发工具 | 3 | 67 | B 63 |
| [heroku.com](https://w2agent.dev/sites/heroku-com) | SaaS | 3 | 36 | B 73 |
| [twilio.com](https://w2agent.dev/sites/twilio-com) | SaaS | 4 | 128 | B 69 |
| [plaid.com](https://w2agent.dev/sites/plaid-com) | SaaS | 3 | 1,085 | B 68 |
| [mailchimp.com](https://w2agent.dev/sites/mailchimp-com) | SaaS | 4 | 82 | B 69 |
| [nextjs.org](https://w2agent.dev/sites/nextjs-org) | 文档 | 3 | 612 | B 64 |
| [nuxt.com](https://w2agent.dev/sites/nuxt-com) | 文档 | 3 | 291 | C 52 |
| [fastapi.tiangolo.com](https://w2agent.dev/sites/fastapi-tiangolo-com) | 文档 | 3 | 153 | C 53 |
| [kotlinlang.org](https://w2agent.dev/sites/kotlinlang-org) | 文档 | 3 | 439 | B 62 |
| [ikea.com](https://w2agent.dev/sites/ikea-com) | 电商 | 4 | 142 | C 58 |
| [zappos.com](https://w2agent.dev/sites/zappos-com) | 电商 | 4 | 62 | C 50 |
| [bbc.com](https://w2agent.dev/sites/bbc-com) | 内容媒体 | 4 | 189 | C 52 |
| [techcrunch.com](https://w2agent.dev/sites/techcrunch-com) | 内容媒体 | 4 | 128 | C 51 |
| [panerabread.com](https://w2agent.dev/sites/panerabread-com) | 本地商业 | 3 | 17 | C 52 |
| [subway.com](https://w2agent.dev/sites/subway-com) | 本地商业 | 3 | 72 | C 48 |

_标准工具：`list-pages`、`get-page`、`search-site`。具有原生搜索功能的网站额外添加 `site-search`（显示为 4 个工具）。_

[浏览目录 →](https://w2agent.dev/directory)

## 适用场景

w2agent 适用于任何公开网站。只要人可以浏览，Agent 就可以使用。

| 类别 | 示例网站 | Agent 能做什么 |
|---|---|---|
| 开发工具 | vercel.com, sentry.io, linear.app, launchdarkly.com | 回答配置问题、获取更新日志、搜索 Issue |
| SaaS 平台 | hubspot.com, mailchimp.com, asana.com, zendesk.com | 查询定价、检索帮助文档、导航功能开关 |
| 文档站 | nextjs.org, kotlinlang.org, nuxt.com, fastapi.tiangolo.com | 回答 API 问题、获取代码示例、解析版本信息 |
| 电商 | ikea.com, amazon.com, target.com, zappos.com | 查询库存、比较规格、查找退货政策 |
| 餐饮 | starbucks.com, mcdonalds.com, chipotle.com | 获取菜单、营业时间、营养信息、查找门店 |
| 新闻媒体 | bbc.com, techcrunch.com, arstechnica.com | 摘要报道、搜索档案、提取头条 |
| 旅游住宿 | marriott.com, hilton.com | 获取设施、政策、按房产查询可用性 |
| 医疗健康 | webmd.com, zocdoc.com | 查找医生、解释病情、查询诊所时间 |
| 房产 | zillow.com, redfin.com | 获取房源、社区统计、估价详情 |
| 金融科技 | plaid.com, twilio.com, gusto.com | 解答 API 文档问题、解释定价、导航指南 |
| 非营利组织 | habitat.org, charitywater.org, doctorswithoutborders.org | 介绍项目、定位办公室、说明捐款影响 |
| 本地服务 | angi.com, thumbtack.com | 按类别查找服务商、获取评价、询价 |

## 功能特性

| 没有 w2agent | 有了 w2agent |
|----------------|-------------|
| Agent 在你的文档上产生幻觉——基于过时快照训练 | `agentize` 提供实时内容；Agent 始终查询当前网站 |
| 在用户投诉之前，无法知道你的网站对 Agent 不可访问 | `audit` 在几秒内评估 60 项检查，精准显示阻碍 Agent 的问题 |
| 每个平台需要不同的集成文件 | 自动检测平台，一条命令生成对应的原生文件（WordPress 插件、Next.js 中间件、Shopify Liquid） |
| 手写 llms.txt 繁琐且容易出错 | `generate` 自动生成 llms.txt、agent-card.json、schema-org.json 等 10 种格式 |
| 部署 Agent 服务器需要自行搭建基础设施 | `npx w2agent agentize` 直接托管你的网站为 Agent 服务器，无需管理服务器 |
| CI/CD 流水线无法以 AI 就绪性作为门控条件 | `--ci --threshold 80` 在评分下降时返回退出码 1，阻断构建 |
| AI 框架期望不同格式（llms.txt、OpenClaw、WebMCP、Skill.md） | 一次爬取生成 10 种输出格式，按需全部生成或选择特定格式 |

## 安装与使用

### 审计、生成、集成（无需 API Key）

```bash
# 审计网站 AI 就绪性
npx w2agent audit https://example.com
npx w2agent audit https://example.com --depth 10 --verbose
npx w2agent audit https://example.com --ci --threshold 80  # CI 门控

# 生成 llms.txt 及所有 AI 就绪文件
npx w2agent generate https://example.com
npx w2agent generate https://example.com --format llms-txt
npx w2agent generate https://example.com --max-pages 200 --output ./output/

# 生成平台专用集成文件
npx w2agent integrate https://example.com
npx w2agent integrate https://example.com --platform wordpress
npx w2agent integrate https://example.com --install        # 安装到项目中
```

### 部署——在 w2agent.dev 上托管 Agent

将你的网站托管为实时 Agent 服务器（需要免费 API Key）：

```bash
npx w2agent login                             # 一次性授权
npx w2agent agentize https://example.com      # 部署 → example-com.agent.w2agent.dev
npx w2agent agentize https://example.com --slug my-docs
```

你的 Agent 端点立即上线。将其添加到 Claude Desktop：
```json
{
  "mcpServers": {
    "my-site": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://my-docs.agent.w2agent.dev"]
    }
  }
}
```

### 自托管 Agent 服务器（无需 API Key，部署到自有基础设施）

```bash
# 生成可部署的 MCP 服务器项目
npx w2agent mcp deploy https://example.com --self-host vercel
npx w2agent mcp deploy https://example.com --self-host cf   # Cloudflare Workers

# 在 ./w2agent-output/ 输出一个随时可部署的项目
# vercel deploy ./w2agent-output/   或   wrangler deploy ./w2agent-output/
```

## 托管版 vs 自托管版

| | 托管版（`agentize`） | 自托管版（`mcp deploy`） |
|---|---|---|
| **部署方式** | `npx w2agent login` + 一条命令 | 生成后部署到自有基础设施 |
| **域名** | `<slug>.agent.w2agent.dev` | 自定义域名 |
| **重新爬取** | 自动（通过控制台按需触发） | 手动（再次运行 `wrangler deploy`） |
| **目录收录** | 支持（可选加入） | 不支持 |
| **是否需要授权** | 免费 API Key | 无需 |
| **适用场景** | 快速部署、目录曝光 | 自定义域名、离线环境、企业级 |

## 平台适配器

w2agent 自动检测你的平台并生成原生集成代码：

| 平台 | 检测方式 | 生成的集成内容 | 测试状态 |
|----------|-----------|----------------------|--------|
| **WordPress** | Generator meta、wp-content、wp-json | 从 WP 数据库动态生成 llms.txt 的 PHP 插件、管理页面、robots.txt 过滤器 | 语法 + 结构 |
| **Next.js** | `__NEXT_DATA__`、`_next/static` | 带 ISR 的路由处理器、用于内容协商的中间件、构建脚本 | 构建 + 实时审计 |
| **Nuxt** | `__NUXT`、Nuxt meta 标签 | Nitro 服务器路由、自动导入的中间件 | 构建 + 实时审计 |
| **Astro** | Generator meta、astro 静态资源 | 静态文件 + 用于内容协商的中间件 | 构建 + 实时审计 |
| **Shopify** | cdn.shopify.com、Shopify 响应头 | Liquid 片段、robots.txt.liquid、产品 JSON-LD | 语法 + 结构 |
| **Docusaurus** | Generator meta、html class | 从文档目录生成 llms.txt 的构建插件 | 构建 + 实时审计 |

审计期间平台专用检查自动执行：

- **WordPress**（4 项）：REST API、安全插件拦截、robots.txt AI 规则、页面构建器标记
- **Next.js**（3 项）：.well-known 服务、静态生成、metadata API 使用情况
- **Nuxt**（3 项）：Nitro 兼容性、服务器路由服务、中间件集成
- **Astro**（3 项）：静态输出结构、中间件支持、构建集成
- **Shopify**（3 项）：robots.txt 定制、产品 Schema、主题应用块
- **Docusaurus**（2 项）：侧边栏覆盖率、版本化文档发现

## 评分体系

六个类别的加权评分：

| 类别 | 权重 | 衡量内容 |
|----------|--------|-----------------|
| **Bot 可访问性** | 20% | AI 爬虫能否访问你的内容？（robots.txt、sitemap、响应时间） |
| **结构化数据** | 20% | 内容是否机器可读？（Schema.org、OpenGraph、语义化 HTML） |
| **内容质量** | 20% | 内容是否针对 AI 优化？（Token 效率、引用、时效性） |
| **Agent 发现** | 15% | Agent 能否找到你的能力描述？（llms.txt、agent card、.well-known） |
| **Agent 协议** | 15% | 网站是否支持 Agent 标准？（MCP、表单、action schema） |
| **技术基础** | 10% | 基础要素：HTTPS、安全响应头、规范 URL、非 JS 内容 |

**评级：** A（90-100）· B（80-89）· C（70-79）· D（60-69）· F（0-59）

完整检查项参考见 [docs/CHECKS.md](docs/CHECKS.md)。

## CLI 选项

```
w2agent audit <url> [options]

选项:
  -d, --depth <number>     最大扫描页面数（默认: 20）
  -f, --format <format>    输出格式: terminal, json（默认: terminal）
  -o, --output <file>      将报告写入文件
  -c, --category <cat>     仅审计单个类别
  -v, --verbose            显示所有检查项及详情
  --ci                     CI 模式：低于阈值时返回退出码 1
  --threshold <score>      CI 模式的最低分数（默认: 70）
  --timeout <ms>           请求超时时间，单位毫秒（默认: 10000）
```

```
w2agent generate <url> [options]

选项:
  -o, --output <dir>       输出目录（默认: ./w2agent-output）
  -f, --format <format>    输出格式: llms-txt, full, markdown, robots-txt, schema-org, agent-card, faq, mcp-server, skill-md, webmcp, openclaw, all（默认: all）
  -m, --max-pages <n>      最大爬取页面数（默认: 100）
  -s, --sections <list>    仅包含这些 URL 路径（逗号分隔）
  --from-audit             先运行审计，仅为失败的检查项生成修复内容
  --timeout <ms>           请求超时时间，单位毫秒（默认: 10000）
```

```
w2agent integrate <url> [options]

选项:
  -o, --output <dir>       输出目录（默认: ./w2agent-output）
  -p, --platform <name>    强制指定平台: wordpress, nextjs, shopify, docusaurus
  -m, --max-pages <n>      最大爬取页面数（默认: 100）
  --timeout <ms>           请求超时时间，单位毫秒（默认: 10000）
```

```
w2agent agentize <url> [options]

选项:
  --api-key <key>    API Key（`w2agent login` 的替代方式）
  --slug <slug>      自定义 Slug（默认: 从域名派生）
```

```
w2agent mcp deploy <url> [options]

选项:
  --self-host <platform>   vercel | cf（Cloudflare Workers）
  -o, --output <dir>       输出目录（默认: ./w2agent-output）
  -m, --max-pages <n>      最大爬取页面数（默认: 50）
```

详细生成参考见 [docs/GENERATE.md](docs/GENERATE.md)。

## 项目结构

```
packages/core     审计引擎、生成器、MCP 服务器构建器、平台适配器
                  （发布为 w2agent-core）
packages/cli      CLI 工具——audit、generate、integrate、agentize、mcp
                  （发布为 w2agent）
```

## 开发

```bash
pnpm install
pnpm build          # 构建所有包
pnpm test           # 单元测试
pnpm dev            # 开发模式（监听变更）

# 集成测试——构建真实的平台项目并对其进行审计
pnpm --filter w2agent-core test:integration
```

贡献指南、测试架构及如何添加新平台，请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## CI/CD 集成

```yaml
# GitHub Actions
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: 18
  - run: npx w2agent audit ${{ vars.SITE_URL }} --ci --threshold 80
```

## 许可证

MIT
