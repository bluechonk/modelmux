/**
 * 一键接入面板（账号池页）：开关式卡片 —— 开 = 已接入（写客户端配置），关 = 还原到
 * 接入前（自动备份可反悔）。
 *
 * 自包含：state 快照（integrations / integration_updates）与操作 mutation 都在内部，
 * state query 与宿主页同 key（react-query 共享缓存，零额外请求）。
 * 操作中开关禁用并停在目标位置，失败弹回原位 + 卡描边转红 + toast：只弹 toast 会
 * 让人以为状态变了。
 *
 * 已接入的目标由后台按设置间隔**自动同步**（key 轮换 / 模型上下线自动重写客户端），
 * 卡上的「更新」按钮只是同一件事的手动触发，正常使用中不需要点。
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugZap } from "lucide-react";

import { api } from "../lib/api";
import type { IntegrationUpdate } from "../lib/types";
import { errorText } from "../lib/log-format";
import { Switch } from "./Switch";
import { useToast } from "./Toast";

/** 接入目标（与后端 `IntegrationTarget` 同形）。 */
type IntegrationTarget = "zcode" | "dsh";

/** 每个客户端在卡片上展示的静态信息（图标缩写 / 名称）。 */
const INTEGRATE_CLIENTS: Array<{ target: IntegrationTarget; icon: string; name: string }> = [
  { target: "zcode", icon: "zc", name: "zcode" },
  { target: "dsh", icon: "ds", name: "dsh" },
];

/** 开关操作中态：按 target 分键，两张卡可并行操作且互不误标。 */
type PendingActions = Partial<Record<IntegrationTarget, "integrate" | "restore">>;

/** 更新差异的可读措辞（进 aria-label；直显按钮方案保持卡面极简，正文不放差异）。 */
function updateDiffLabel(update: IntegrationUpdate): string {
  const parts: string[] = [];
  if (update.keyRotated) parts.push("密钥已更换");
  if (update.added.length > 0) parts.push(`新增 ${update.added.join("、")}`);
  if (update.removed.length > 0) parts.push(`移除 ${update.removed.join("、")}`);
  return parts.join("；") || "接入配置有变化";
}

/** 单张接入开关卡。 */
function IntegrateSwitchCard({
  target,
  icon,
  name,
  integrated,
  pending,
  error,
  update,
  onToggle,
  onUpdate,
}: {
  target: IntegrationTarget;
  icon: string;
  name: string;
  integrated: boolean;
  /** 该卡片的操作中态（null = 空闲）。 */
  pending: "integrate" | "restore" | null;
  /** 最近一次操作的失败原因（null = 无）。 */
  error: string | null;
  /** 模型有更新明细（null = 无；仅在已接入且空闲时展示更新按钮）。 */
  update: IntegrationUpdate | null;
  onToggle: () => void;
  /** 点「更新」= 重跑同一条接入路径，把客户端清单刷成当前对外模型。 */
  onUpdate: () => void;
}): ReactElement {
  const busy = pending !== null;
  const failed = error !== null;
  /** 操作中开关**先走到目标位置**（接入中停在开、还原中停在关），完成后再由快照定稿。 */
  const shown = pending !== null ? pending === "integrate" : integrated;
  /**
   * 无障碍文案（不直显）：卡面只留开关与更新按钮，状态由开关位置本身表达；
   * 失败态靠卡描边转红 + toast。
   */
  const stateText = pending !== null
    ? pending === "integrate"
      ? "接入中"
      : "还原中"
    : failed
      ? integrated
        ? "还原失败"
        : "接入失败"
      : integrated
        ? "已接入"
        : "未接入";
  return (
    <div
      className={`relative rounded-xl border bg-raised p-3 transition-colors ${
        failed ? "border-danger/45" : "border-line"
      } ${busy ? "opacity-70" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-lg bg-overlay text-xs font-medium text-ink">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{name}</div>
        </div>
        {/*
          「有更新」直显按钮：接入后对外模型清单变了才出现（判据在服务端 diff 好下发）。
          中性描边 + 一颗 warn 语义点。点击重跑接入，成功后随快照消失。
        */}
        {!busy && integrated && update !== null && (
          <button
            type="button"
            onClick={onUpdate}
            aria-label={`${name} 模型有更新（${updateDiffLabel(update)}），点击更新接入`}
            className="tap inline-flex flex-none items-center gap-1.5 rounded-lg border border-line bg-overlay px-2.5 py-[3px] text-xs text-ink transition-colors hover:border-line-strong"
          >
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-warn" aria-hidden="true" />
            更新
          </button>
        )}
        <Switch
          checked={shown}
          disabled={busy}
          onChange={onToggle}
          label={`${name} ${stateText}，点击${shown ? "还原" : "接入"}`}
        />
      </div>
    </div>
  );
}

/** 一键接入面板：标题 + 两张开关卡（窄屏堆叠、sm 起两列）。 */
export function IntegratePanel(): ReactElement {
  const toast = useToast();
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  // 开关式接入：操作中态与每卡失败原因（键 = target）。结果同时走 toast
  // （命令信封 ok:false 是 200 响应，onSuccess 不代表成功）+ 卡描边转红（只记最新一次失败，文案走 toast）。
  const queryClient = useQueryClient();
  const [pendingActions, setPendingActions] = useState<PendingActions>({});
  const [integrateErrors, setIntegrateErrors] = useState<Partial<Record<IntegrationTarget, string>>>({});
  const clearError = (target: IntegrationTarget): void =>
    setIntegrateErrors((prev) => {
      const next = { ...prev };
      delete next[target];
      return next;
    });

  // 接入（开）：把该客户端的模型清单改成网关的对外模型名。
  const integrateMutation = useMutation({
    mutationFn: (target: IntegrationTarget) => api.commands.integrate(target),
    onMutate: (target) => setPendingActions((prev) => ({ ...prev, [target]: "integrate" })),
    onSuccess: async (data, target) => {
      if (data.ok === false) {
        setIntegrateErrors((prev) => ({ ...prev, [target]: String(data.error ?? "未完成任何改动") }));
        toast.error(`接入失败：${String(data.error ?? "未完成任何改动")}`);
        return;
      }
      clearError(target);
      toast.success(`已接入 ${target}`);
      // warnings 是「有东西没做成」（备份清单读不出 / 备份未登记）：不说出来就成了
      // 「已接入」的假象
      for (const note of Array.isArray(data.warnings) ? data.warnings : []) {
        toast.info(typeof note === "string" ? note : String(note));
      }
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err, target) => {
      setIntegrateErrors((prev) => ({ ...prev, [target]: errorText(err) }));
      toast.error(`接入失败：${errorText(err)}`);
    },
    onSettled: (_data, _err, target) =>
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[target];
        return next;
      }),
  });

  /**
   * 还原（关）：把目标恢复成接入前的样子（后端取该目标**最新一次**备份，
   * 并在还原前先把当前状态再备份一份，可反悔）。
   */
  const restoreMutation = useMutation({
    mutationFn: (target: IntegrationTarget) => api.commands.restore(target),
    onMutate: (target) => setPendingActions((prev) => ({ ...prev, [target]: "restore" })),
    onSuccess: async (data, target) => {
      if (data.ok === false) {
        setIntegrateErrors((prev) => ({ ...prev, [target]: String(data.error ?? "没有可用的接入备份") }));
        toast.error(`还原失败：${String(data.error ?? "没有可用的接入备份")}`);
        return;
      }
      clearError(target);
      toast.success(`已还原 ${target}`);
      // 跳过的条目 / 缺失的备份文件必须说出来 —— 否则「已还原」是假象。
      for (const note of Array.isArray(data.notes) ? data.notes : []) {
        toast.info(typeof note === "string" ? note : String(note));
      }
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err, target) => {
      setIntegrateErrors((prev) => ({ ...prev, [target]: errorText(err) }));
      toast.error(`还原失败：${errorText(err)}`);
    },
    onSettled: (_data, _err, target) =>
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[target];
        return next;
      }),
  });

  return (
    <section className="panel p-4">
      <div className="panel-title mb-3">
        <PlugZap className="h-4 w-4 text-ink-faint" />
        一键接入
      </div>
      {state.isError && (
        <p className="mb-2 text-xs text-danger">
          接入状态未知（快照查询失败）：{errorText(state.error)}
        </p>
      )}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {INTEGRATE_CLIENTS.map(({ target, icon, name }) => (
          <IntegrateSwitchCard
            key={target}
            target={target}
            icon={icon}
            name={name}
            integrated={state.data?.integrations?.[target] === true}
            pending={pendingActions[target] ?? null}
            error={integrateErrors[target] ?? null}
            update={
              state.data?.integrations?.[target] ? state.data?.integration_updates?.[target] ?? null : null
            }
            onToggle={() => {
              if (state.data?.integrations?.[target]) restoreMutation.mutate(target);
              else integrateMutation.mutate(target);
            }}
            onUpdate={() => integrateMutation.mutate(target)}
          />
        ))}
      </div>
    </section>
  );
}
