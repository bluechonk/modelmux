/**
 * 登录/凭证流程：与界面解耦 —— 只通过 `LoginUi` 接口交互（headless 与桌面窗口共用）。
 *
 * 关键约束：
 *  - **无凭证**：非交互模式只报告状态并返回 false；交互模式引导授权
 *  - **凭证被拒**：先刷新；刷新失败**删除本地凭证**，让「重试登录」真正走重新登录
 *  - **网络不通等临时问题**：照常启动，运行期请求失败会自动刷新
 *
 * 渠道差异（cred / upstream / 凭据路径）全部由注册的 `Channel` 提供。
 */

import { unlinkSync } from "node:fs";

import { getChannel, type LoginUi } from "../runtime/channel.js";
import { credentialsPath } from "../runtime/paths.js";

export type { LoginUi };

/**
 * 保证存在可用登录凭证；必要时引导登录。
 *
 * @param interactive 无窗口被动模式下传 false —— 缺凭证**不发起登录**，
 *   只报告状态并返回 false。
 * @param force 重新授权：**即使已有凭据也走一轮新的授权**（拿新的授权链接）。
 *   ⚠ 不删旧凭据 —— 授权没走完时旧凭据仍能服务（2026-10-24 事故：先删导致掉线）。
 * @returns true 表示可以启动网关
 */
export async function ensureLogin(
  ui: LoginUi,
  options: {
    interactive?: boolean;
    baseUrl?: string;
    cid?: string;
    passiveNoProbe?: boolean;
    force?: boolean;
  } = {},
): Promise<boolean> {
  const { interactive = true, baseUrl, cid, passiveNoProbe = false, force = false } = options;
  const { cred, upstream } = getChannel(cid);

  let c: ReturnType<typeof cred.load> | null;
  try {
    c = cred.load();
  } catch (err) {
    if (err instanceof cred.NotLoggedInError) {
      c = null;
    } else {
      ui.setState("login", `读取出错（${String(err)}）；请重新登录。`);
      c = null;
    }
  }

  // `force` 时即使已有凭据也走授权：控制台「添加账号」与 `mx relogin` 要的是
  // **一条新的授权链接**，而不是「探测一下旧凭据还能不能用」（那样点任何已登录
  // 渠道都会立刻报成功、拿不到链接 —— 2026-10-26 实测）。
  if (!c || force) {
    if (!interactive) {
      ui.setState("login", "未登录：请先登录，打开授权链接完成授权后再试。");
      return false;
    }
    ui.setState("login", "正在获取授权链接...");
    try {
      c = await cred.login(baseUrl ?? cred.DEFAULT_BASE_URL, {
        // ⚠ 只说「这个 URL 在哪」，**不**承诺「授权后自动完成」：渠道各有各的
        // 回调方式（本地回调服务器 / 设备码轮询 / 扫码长轮询），自动完成与否
        // 由渠道自己的 onStatus 指引说明。乱承诺会让用户在错误的入口扫码
        // （loomy 实测踩过：授权页每次加载都换 uuid，扫了这边永远等不到）。
        onUrl: (url) => ui.setState("login", "授权链接（在浏览器中打开以完成授权）", url),
        // 二维码图片：扫码必须用这张（授权页每次加载都会换一个新的二维码会话）
        onQr: (qr) => ui.setQr?.(qr),
        onStatus: (msg) => ui.setState("login", msg),
        // 兜底：回调页线上是 404，code 只在地址栏里 —— 由用户粘回来
        pasteCode: () => ui.takePastedCallback?.(),
      });
    } catch (err) {
      ui.setState("error", `登录失败：${String(err)}`);
      return false;
    }
    ui.setState("login", "授权成功，正在初始化...");
    try {
      // 拉一次模型载荷：既验证新凭据可用，也顺便把上游连接配置落盘
      const data = await upstream.fetchModels(c);
      await upstream.saveConfig(upstream.resolveConfig(data));
    } catch {
      /* 模型载荷拉取失败不阻塞登录本身（网关运行期还会再拉） */
    }
    return true;
  }

  // 有凭证：被动启动探测可跳过网络校验（非交互且启用 passiveNoProbe 时，
  // 仅本地凭据存在即视为可用；网络/失效由运行期首请求自动 refresh）
  if (!interactive && passiveNoProbe) return true;
  try {
    await upstream.fetchModels(c);
    return true;
  } catch (err) {
    if (!(err instanceof upstream.UpstreamUnauthorized)) {
      // 网络不通等临时问题：照常启动，运行期请求失败会自动刷新
      ui.setState("error", `login check failed (${String(err)}); continuing to start anyway.`);
      return true;
    }
    try {
      const refreshed = await cred.refresh(c);
      await upstream.fetchModels(refreshed);
      return true;
    } catch (err2) {
      // 刷新失败（刷新令牌可能已被上游消费/作废）：删掉本地凭证，
      // 让「重试登录」真正走重新登录流程，而不是重复同一条失败路径
      try {
        unlinkSync(credentialsPath(cid));
      } catch {
        /* 文件本来就不在 */
      }
      ui.setState(
        "error",
        `credentials expired and refresh failed (${String(err2)}); click "retry login" to log in again.`,
      );
      return false;
    }
  }
}
