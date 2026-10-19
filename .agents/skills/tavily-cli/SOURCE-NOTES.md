# tavily 技能包 — 来源与许可证

- 来源：Claude 官方插件 `tavily` 1.0.0，缓存目录
  `~\.claude\plugins\cache\claude-plugins-official\tavily\1.0.0\skills\`
- 上游仓库：https://github.com/tavily-ai/skills（Tavily Team 官方）
- 许可证：MIT（各 `tavily-*\LICENSE`，Copyright Tavily Team；复制自插件根 LICENSE）
- 复制时间：2026-10-19，整目录原样复制，共 8 个技能：
  tavily-cli（本目录，安装/认证/总览入口）、tavily-search、tavily-extract、
  tavily-map、tavily-crawl、tavily-research、tavily-dynamic-search、
  tavily-best-practices（含 references/ 子目录）
- 说明：技能运行时依赖 `tvly` CLI（安装方式见本 SKILL.md 的 Setup 一节，
  `uv tool install tavily-cli`）；search/extract 支持限额免密钥访问，
  map/crawl/research 需要认证。
