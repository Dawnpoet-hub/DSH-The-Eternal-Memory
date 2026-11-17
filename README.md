# DSH-The-Eternal-Memory（长期记忆 · DSH 插件）

让 AI 记住你们聊过的事：**全部存在本地 Markdown 文件里**，可看、可搜、可改、可打包带走。

---

## 安装前需要准备

> **Python 不用自己装**：DSH 桌面版运行时自带 Python 3.12，插件会优先使用它。

| 项目 | 要求 | 说明 |
|---|---|---|
| DSH 桌面版 | 已安装并能正常打开 | 插件通过 profile 的 bundle 机制加载 |
| **Python** | **不用自己装** | DSH 桌面版运行时**自带 Python 3.12**（`~/.dsh/dsh-runtimes/*/dependencies/python`），插件会直接用它建虚拟环境。只有在找不到时才需要自己装 3.11+ |
| 磁盘 | 约 300MB | 依赖 80MB + 向量模型 90MB + 你的记忆 |
| 网络 | 首次需要联网 | 只有第一次要下载，之后完全离线 |

> Windows 目前**未实测**（代码里有 `Scripts/python.exe` 兜底，但没有验证过）。

---

## 安装

### 方式一：插件页一键安装（推荐）

1. 打开 DSH → 左侧 **插件**
2. 点右上角 **＋ 添加插件**
3. 输入框里粘贴仓库地址：

   ```
   https://github.com/Dawnpoet-hub/DSH-The-Eternal-Memory
   ```

4. 点 **安装**，等它下载完
5. **重启 DSH**（patch 里的路径需要下次启动才生效）
6. 打开左侧栏「长期记忆」，按「首次使用」三步走完

> 安装源可以选「中国大陆镜像源」，网络不好时更稳。

### 方式二：手动登记（改代码 / 离线时用）


### 1. 克隆到一个固定位置

```bash
mkdir -p ~/dsh-plugins
git clone https://github.com/Dawnpoet-hub/DSH-The-Eternal-Memory.git ~/dsh-plugins/DSH-The-Eternal-Memory
```

> 路径选定后别随便移动，profile 里记录的是**绝对路径**。

### 2. 在 profile 里登记这个插件

编辑 `~/.dsh/profiles/desktop/package.json`，改两处：

```jsonc
{
  "dependencies": {
    "@local/dsh-the-eternal-memory": "link:/Users/你的用户名/dsh-plugins/DSH-The-Eternal-Memory"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...其他插件...",
        "@local/dsh-the-eternal-memory"
      ]
    }
  }
}
```

- `link:` 后面必须是**绝对路径**
- `bundles` 数组里加上包名，顺序不影响功能

### 3. 建立 node_modules 链接

```bash
cd ~/.dsh/profiles/desktop
mkdir -p node_modules/@local
ln -sfn ~/dsh-plugins/DSH-The-Eternal-Memory node_modules/@local/dsh-the-eternal-memory
```

### 4. 重启 DSH

重启后左侧栏应出现「**长期记忆**」入口。
（第一次可能只出现入口、记忆工具还没注册——按下一步走完再重启一次即可。）

### 验证安装是否成功

```bash
# 应能打印 3.11.x
node -e "console.log(require('$HOME/.dsh/profiles/desktop/node_modules/@local/dsh-the-eternal-memory/package.json').version)"
```

或者直接打开面板：能看到「运行状态」九步和「记忆概览」，说明插件已加载。

---

## 首次使用（三步）

打开左侧栏「长期记忆」，顶部会出现一条橙色引导条，按它走：

| 步骤 | 操作 | 需要重启吗 |
|---|---|---|
| 1 | 点「安装依赖（约 80MB）」 | 不用 |
| 2 | 点「下载向量模型（约 90MB）」 | 不用 |
| 3 | **重启 DSH 一次** | 需要 |

**为什么还要重启一次**：给 AI 用的记忆工具（`mem_search` 等）走 MCP 通道，而 MCP 的启动路径写在 `cordis.patch.yml` 里，这个文件**只在 DSH 启动时读取**。插件会在首次启动时把真实路径写进去，所以要等下一次启动才生效。

重启后引导条消失，右下角运行状态全绿，就绪。

---

## 可选：更准的重排（额外约 560MB）

默认**关闭**。开启后检索会再跑一次交叉编码器重排，结果更准，但**第一次检索会静默下载约 560MB**，所以没默认开。

想开的话，编辑工作区的 `mem.json`：

```json
"rerank": { "enabled": true, "model": "BAAI/bge-reranker-v2-m3-int8", "top": 8 }
```

## 数据放在哪

| 路径 | 内容 | 能不能动 |
|---|---|---|
| `memory/*.md` | **所有记忆**，纯文本 | ✅ 随便改，改完点面板「刷新」 |
| `.mem/index.db` | 索引（可重建） | ⚠️ 删了会自动重建 |
| `.mem/auto.log` | 运行日志 | 可删 |
| `mem.json` | 项目配置 | 可改 |
| `tools/` | Python 引擎 | 别动；丢了会从插件包自动补 |
| `schemas/` | 笔记格式定义 | 可改 |

**记忆就是 `memory/` 里的 Markdown。** 用任何编辑器都能读；删掉这个目录就等于清空记忆。

---

## 它能做什么

- **自动写回**：聊完（攒够 8 轮或停手 60 秒）自动提炼成结构化记忆
- **自动召回**：每次提问前先翻记忆，相关的自动带进上下文
- **面板**：概览统计、活跃度热力图、记忆清单、关联线索关系图、花费与命中率
- **一键搬家**：把所有记忆打包成 zip，换电脑导入
- **体检**：检查格式错误、断链、未整理、丢失

---

## 给开发者：提交前钩子

本仓库带一个 pre-commit 钩子，会**拦下**把本机绝对路径提交上去的情况（`cordis.patch.yml` 必须用 `__LM_*` 占位符）。

```bash
npm run install-hooks     # 启用钩子（每个克隆执行一次）
npm run reset-patch       # 提交前把本机路径换回占位符
git add -A && git commit  # 此时若有本机路径会被拒绝
```

## 常见问题

**引导条一直显示「需要先安装 Python」**

正常情况下不该出现——DSH 运行时自带 Python。如果出现：

1. 确认 DSH 安装完整（`~/.dsh/dsh-runtimes/` 下应有一个运行时目录，里面有 `dependencies/python`）
2. 若确实没有，自己装 Python 3.11+ 后重启 DSH
3. 想指定某个解释器，可设环境变量 `LONG_MEMORY_PYTHON=/path/to/python`

**点了「安装依赖」没反应**
安装是后台任务，约 1–3 分钟。看 `.mem/setup.log`，或重开面板看引导条是否消失。

**记忆会不会上传到云端**
不会。除了你选的大模型本身，**记忆数据不离开这台电脑**。

---

## 许可

MIT License —— 详见 [LICENSE](./LICENSE)。

可以自由使用、修改、分发（包括商用），保留版权声明即可；**不提供任何担保**。
