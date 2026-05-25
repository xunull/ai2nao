# Bash 权限规则匹配与行为说明

本文说明 Bash tool 权限规则中的三种匹配方式，以及 `allow` / `ask` / `deny` 三种规则行为的技术语义。

权限规则只决定一个已经通过静态安全检查的命令是否可以直接执行、需要审批，还是被拒绝。它不是 shell parser，也不会扩大 Bash tool 的基础安全边界。

## 规则字段

一条权限规则的核心字段是：

```ts
type BashPermissionRuleInput = {
  behavior: "allow" | "ask" | "deny";
  ruleType?: "exact" | "prefix" | "wildcard";
  ruleContent: string;
  scopeType?: "global" | "directory";
  scopeValue?: string | null;
  note?: string | null;
};
```

- `behavior`：命中规则后采取的行为。
- `ruleType`：`ruleContent` 的匹配方式。
- `ruleContent`：命令匹配表达式。
- `scopeType`：规则作用域，分为全局和目录级。
- `scopeValue`：目录级规则的根目录。

目录级规则只会在当前执行目录等于 `scopeValue`，或位于 `scopeValue` 子目录中时生效。全局规则会在所有目录下参与匹配。

## 执行前的整体判断顺序

Bash tool 的权限判断按下面顺序执行：

1. 先做静态安全检查。
   - 空命令、命令替换、危险重定向、二级解释器、网络工具、破坏性文件命令等会直接拒绝。
   - 结构安全但不属于明确只读命令的普通命令，会标记为 `project-command`，后续默认进入审批。
   - 这一步拒绝的命令不会继续匹配持久化规则。

2. 再按当前 `cwd` 过滤可用规则。
   - 全局规则保留。
   - 目录级规则只在当前目录位于规则目录树内时保留。

3. 对剩余规则做 `exact` / `prefix` / `wildcard` 匹配。

4. 如果多条规则同时命中，行为优先级是：

   ```text
   deny > ask > allow
   ```

5. 同一行为下，排序偏向更具体的规则：

   ```text
   directory > global
   exact > prefix > wildcard
   更深的目录 > 更浅的目录
   更早创建的规则 > 更晚创建的规则
   ```

因此，`deny` 规则可以压过同一个命令上的 `allow` 规则；目录级规则通常比全局规则更适合表达项目内的例外。

## 匹配方式

### exact：精确命令

`exact` 使用字符串相等判断：

```text
command.trim() === ruleContent
```

适合只允许或只拦截一条固定命令。

典型场景：

- 只允许 `git status --short`。
- 只允许 `npm run test`，但不允许 `npm run build`。
- 拒绝某条明确命令，例如 `npm run smoke`。
- 对一条只读命令强制审批，例如 `pwd`。

示例：

| 规则 | 命令 | 是否命中 |
|---|---|---|
| `exact: npm run test` | `npm run test` | 是 |
| `exact: npm run test` | `npm run test:unit` | 否 |
| `exact: git status --short` | `git status --short` | 是 |
| `exact: git status --short` | `git status` | 否 |

注意：精确匹配关注后端看到的规范化命令字符串。参数变了、子命令变了，通常就应该视为另一条命令。

### prefix：命令前缀

`prefix` 用命令开头做边界匹配。规则内容如果以 `:*` 结尾，会先去掉这个后缀：

```text
ruleContent = "npm run:*"
prefix = "npm run"
```

命中条件是：

```text
command === prefix || command.startsWith(prefix + " ")
```

适合管理同一类命令族，尤其是由稳定前两个 token 组成的命令。

典型场景：

- `npm run:*`：覆盖 `npm run test`、`npm run build`、`npm run lint` 这类项目脚本。
- `git status:*`：覆盖 `git status` 及其带参数形式。
- `rg:*`：覆盖以 `rg` 开头的检索命令。

示例：

| 规则 | 命令 | 是否命中 |
|---|---|---|
| `prefix: npm run:*` | `npm run test` | 是 |
| `prefix: npm run:*` | `npm run build` | 是 |
| `prefix: npm run:*` | `npm install` | 否 |
| `prefix: git status:*` | `git status --short` | 是 |
| `prefix: git status:*` | `git show HEAD` | 否 |

注意：`prefix` 只是规则匹配方式，不代表这些命令一定能执行。命令仍然必须先通过静态安全检查。例如某条 `npm run <script>` 如果不在 Bash tool 允许的项目脚本范围内，即使命中 `npm run:*` 规则，也会先被静态安全检查拒绝。

### wildcard：通配表达式

`wildcard` 把规则内容里的未转义 `*` 当作任意字符匹配，并且要求整条命令完整匹配。

内部等价于：

```text
* -> .*
^pattern$
```

如果要匹配字面量星号，可以写成 `\*`。

适合无法只靠固定前缀表达的命令形状，例如变量出现在中间或结尾。

典型场景：

- `git show *`：匹配查看任意 revision 或对象的命令。
- `rg * src`：匹配在 `src` 下做不同关键词搜索的命令。
- `git diff * -- package.json`：匹配针对不同 revision 的同一文件 diff。

示例：

| 规则 | 命令 | 是否命中 |
|---|---|---|
| `wildcard: git show *` | `git show HEAD` | 是 |
| `wildcard: git show *` | `git show main:package.json` | 是 |
| `wildcard: git show *` | `git status --short` | 否 |
| `wildcard: rg * src` | `rg Bash src` | 是 |
| `wildcard: rg * src` | `rg Bash test` | 否 |

注意：这里的 `*` 是权限规则自己的字符串通配符，不是 shell glob。它不会展开文件路径，也不会改变最终执行的命令。

## ruleType 省略时的推断

创建规则时如果没有显式传 `ruleType`，后端会根据 `ruleContent` 推断：

| `ruleContent` 形态 | 推断结果 |
|---|---|
| 以 `:*` 结尾 | `prefix` |
| 包含未转义 `*` | `wildcard` |
| 其他情况 | `exact` |

因此：

- `npm run:*` 会被推断为 `prefix`。
- `git show *` 会被推断为 `wildcard`。
- `npm run test` 会被推断为 `exact`。

手动管理规则时仍建议显式选择匹配方式，这样读规则列表时更清楚。

## 规则行为

### allow：允许执行

`allow` 表示命中规则后，不再创建交互式审批请求，直接进入执行阶段。

适合：

- 用户已经明确认可的重复性验证命令。
- 项目目录内常用的 `npm run test` / `npm run build` / `npm run lint`。
- 可信目录下频繁运行的只读检查命令。

重要限制：

- `allow` 不会绕过静态安全检查。
- `allow` 不会绕过 `deny` 规则。
- 在 `plan` permission mode 下，`project-command` 仍会被拒绝，不会因为 `allow` 规则直接执行。

例子：

```text
behavior: allow
ruleType: prefix
ruleContent: npm run:*
scopeType: directory
scopeValue: /Users/quincy/project-a
```

这表示在 `/Users/quincy/project-a` 目录树内，命中 `npm run:*` 的已允许项目脚本可以不再询问。

### ask：总是询问

`ask` 表示命中规则后必须进入交互式审批。

适合：

- 命令本身可以通过静态检查，但用户希望每次都确认。
- 某个目录下的命令风险比默认判断更高。
- 临时观察一类命令，不想直接放行，也不想直接拒绝。

`ask` 对只读命令也有效。例如 `pwd` 默认会直接执行，但如果有一条 `ask + exact + pwd` 规则，就会进入审批。

重要限制：

- 在 `dontAsk` permission mode 下，需要审批的命令会被拒绝。
- 在 `bypassPermissions` permission mode 下，通过静态安全检查的命令会直接执行，`ask` 规则不会强制弹审批。
- 对 `project-command`，`plan` mode 会先拒绝，不进入审批。

例子：

```text
behavior: ask
ruleType: exact
ruleContent: npm run build
scopeType: directory
scopeValue: /Users/quincy/project-a
```

这表示在该目录树内，`npm run build` 每次都要用户确认。

### deny：拒绝执行

`deny` 表示命中规则后直接拒绝，不创建审批请求，也不启动子进程。

适合：

- 某个目录下永远不希望 AI 执行的命令。
- 对全局规则做收紧，例如拒绝某个项目脚本。
- 覆盖之前过宽的 `allow` 规则。

`deny` 是持久化规则里的最高优先级。即使同一个命令也命中了 `allow` 或 `ask`，最终仍然拒绝。

例子：

```text
behavior: deny
ruleType: exact
ruleContent: npm run smoke
scopeType: directory
scopeValue: /Users/quincy/project-a
```

这表示在该目录树内，`npm run smoke` 会被规则层直接拒绝。

## 行为与 permission mode 的关系

`permissionMode` 是本轮运行模式，规则行为是在模式内参与决策。常见关系如下：

| 命中规则 | default / acceptEdits | plan | dontAsk | bypassPermissions |
|---|---|---|---|---|
| `deny` | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| `ask` + read-only | 审批 | 审批 | 拒绝 | 允许 |
| `ask` + project-command | 审批 | 拒绝 | 拒绝 | 允许 |
| `allow` + read-only | 允许 | 允许 | 允许 | 允许 |
| `allow` + project-command | 允许 | 拒绝 | 允许 | 允许 |
| 无规则 + read-only | 允许 | 允许 | 允许 | 允许 |
| 无规则 + project-command | 审批 | 拒绝 | 拒绝 | 允许 |

所有“允许”都以静态安全检查通过为前提。

## 选择建议

优先选择更窄的规则：

1. 如果只想处理一条固定命令，选 `exact`。
2. 如果想处理同一命令族，选 `prefix`。
3. 如果命令变化位置不在末尾，或无法用稳定前缀表达，选 `wildcard`。

优先选择目录级作用域：

1. 项目脚本通常应该保存为目录级规则。
2. 全局 `allow` 应该谨慎使用。
3. 全局 `deny` 适合表达明确禁止的命令类别。

优先用 `ask` 做不确定状态：

1. 不确定是否应该长期允许时，用 `ask`。
2. 已经确认高频且低风险时，再改成 `allow`。
3. 确认不该执行时，用 `deny`。

## 相关文档

- [ai2nao_run_shell 受控 Bash 工具](./llm-bash-tool.md)
- [Bash Tool 安全设计](./bash-tool-security-design.md)
