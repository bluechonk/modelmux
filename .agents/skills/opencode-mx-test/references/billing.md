# 成本与账单核对

## 选模型

`mx model <cid>` 的倍率是唯一标准：倍率 0 优先；没有免费的就选最低档；
显示 `-` 说明渠道没暴露倍率（如 `astudio`），按文档默认档，且无法判断成本时只跑单轮最小对话。

`mx model <cid>` 默认读本地缓存，倍率可能过期；要最新值用 `mx model <cid> --refresh`
（注意：`model <cid> --refresh` 失败非零退出，`model usage --refresh` 失败仍返回 0）。

## 账单核对流程

```bash
CID=<cid>
MODEL=<最低倍率模型>

mx bill "$CID"                      # 测试前
# 跑冒烟 + 工具往返
sleep 8                             # 等上游记账
mx bill "$CID"                      # 测试后
```

要精确比较时用 JSON：

```bash
mx bill "$CID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.total?.remain, o.total?.used)})'
```

- 差值用前后**剩余额度**相减。
- `mx bill` 输出里的「已用 0」是额度桶的 `used` 字段，不代表本次差值；某些渠道在
  `dailyQuota` 缺失时 `used` 天然为 0，不能据此判断「没扣费」。
- 单渠道输出还会带套餐名、百分比、到期天数，不要只看数字。

## opencode 侧的成本闸门

opencode **没有** `--max-steps` / `--max-turns` 这类步数上限。能控的只有：

1. **提示词写短**：只要求必要动作，不要「顺便再做几件事」。
2. **`--auto` 会让 Agent 一路自批准跑下去**，没有人工闸门；跑长任务前先跟用户确认。
3. **`--format json`** 输出原始事件流，便于跑完统计实际 token 消耗。

所以 opencode 跑端到端测试时，**选模型比选 harness 更重要**：免费模型随便跑，
付费模型必须先把倍率说清楚再开跑。

## 判定

| 模型类型 | 账单差值 | 判定 |
| --- | --- | --- |
| 免费（倍率 0） | 0 | 通过；不为 0 说明选错模型或渠道计费异常 |
| 付费（倍率 > 0） | > 0 且量级合理 | 通过；为 0 时等 10 秒重查，仍为 0 记录异常 |
| 倍率未知（`-`） | 只记录 | 报告中注明渠道未暴露倍率 |

可核对的例子：`qoder` 双模型（倍率 0.1）完整跑一轮 Agent 测试，账单 400 → 383，
消耗 17 credits —— 见 `docs/channels/qoder/PROTOCOL.md` 的 2026-10-24 实测。
