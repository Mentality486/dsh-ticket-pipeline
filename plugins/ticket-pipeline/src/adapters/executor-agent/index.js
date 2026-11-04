/**
 * `executor-agent` —— 真正干活的那个执行器：起一个 agent、在 worktree 里改代码、
 * 跑构建与测试、最后开 draft MR。
 *
 * 状态：**占位**，还未实现（需要一张独立的地图票，见下）。
 *
 * ## 为什么留空
 *
 * 它要串起来的东西比别的三个适配器都多，而且每一段都已经有实测结论，
 * 但把它们拼成一个能真跑的执行器是独立工作量：
 *
 * 1. **起 agent**：进程内 `ctx.agents.create({sessionId, meta:{cwd}, agentOptions, setup})`
 *    （`dsh-headless/lib/index.js:317` 是可直接照抄的实例）。任务书用
 *    `ctx.core.prompt.js` 的 `renderTicketPrompt(ticket, located)` 生成。
 * 2. **推任务**：必须 `agent.followup(userMessage)` —— `inject()` **不唤醒** agent
 *    （`dsh-agent-loop:800-814`：followup=next-turn+唤醒 / steer=next-step+唤醒 /
 *    inject=next-step 不唤醒）。
 * 3. **等结束**：`await agent.whenIdle()` 循环 + `session.seq` 判稳，等 `turn/end`
 *    这类持久事件，不轮询 `agent/status`。
 * 4. **验证**：验证命令从项目配置的 `verify` 字段注入（`build` / `test`），
 *    不在执行器里硬编码任何具体命令。起不来就记 `testOutcome:'skipped'` 并写清
 *    原因，仍然开 draft MR —— 这是契约里明确的合法成功路径。
 * 5. **开 MR**：`git push` 在本机**物理上不可能**（沙箱禁止给 `git-receive-pack`
 *    建 stdin 管道，`fatal: unable to fork`）。所以改动只能用 GitLab **Commits API**
 *    `POST /api/v4/projects/:id/repository/commits` 物化（`branch` + `commit_message`
 *    + `actions[]`），再 `POST /merge_requests` 且标题必须以 `Draft:` 前缀开头
 *    （`draft=true` 参数会被静默忽略）。开 MR 前必须先 `GET /repository/branches/:branch`
 *    探分支存在 —— 分支不存在时 GitLab 也返回 201。
 * 6. **不要提交**含真实凭据的配置文件（如 `application.yml` / `.env`）。
 *
 * ## 为什么现在不写
 *
 * 它需要真连 GitLab、真起 JVM、真跑 181 个后端测试，跑一次几十秒到几分钟；
 * 而且它的验收本身就是「拿一张真工单跑通」。那是 #09（本地跑起来前置）之后的事，
 * 应该单独开一张票，在真实环境里迭代，而不是在骨架票里写个跑不通的版本。
 *
 * 在那之前，`src/index.js` 的 `EXECUTORS` 表里 `agent` 指向这个空壳：选它会立刻
 * 报一条清楚的错，而不是让票默默卡在 `planning`。
 */

import { PipelineError } from '../../contracts/errors.js'
import { assertWorkExecutor } from '../../contracts/work-executor.js'

const NOT_IMPLEMENTED = 'executor-agent 尚未实现（需要单独的地图票）。要跑通链路请把 workExecutor 设为 mock。'

/**
 * @param {Object} [options]
 * @param {any} [options.agents] `ctx.agents`
 * @param {any} [options.worktrees] `ctx.worktrees`
 * @param {any} [options.subprocess] `ctx.subprocess`
 * @param {any} [options.credentials] `ctx.credentials`
 * @returns {import('../../contracts/work-executor.js').WorkExecutor}
 */
export function createAgentExecutor (options = {}) {
  void options

  return assertWorkExecutor({
    id: 'agent',

    async run () {
      // 抛 invalid-input 而不是 internal：这是「配置选错了」，不是「跑挂了」。
      // 内核看到 invalid-input 会直接标 failed 且不重试，正是想要的。
      throw new PipelineError('invalid-input', NOT_IMPLEMENTED)
    },
  })
}
