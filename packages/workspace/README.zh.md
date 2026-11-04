---
description: "workspace 组地图：持久的工作区记录、对它们进行分组的项目、经会话头验证的会话归属关系，以及本组唯一的包，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/workspace

[English](README.md) | 中文

## 概述

workspace 家族让宿主产品持久保存命名且有序的工作区列表——持久的目录记录——以及其中运行的会话，并持久保存一组把工作区分组为命名分区的项目。用户可以浏览项目、工作区与会话、隐藏会话而不删除它，以及移除工作区或项目而不删除文件夹、文件或会话历史。需要持久工作区与项目界面时选用此家族；它需要会话存储和持久化后端，且不会向模型公开工具、提示词或会话事件。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`workspace`](workspace/README.zh.md) | 提供命名且有序的工作区及其目录中运行的会话，以及对这些工作区进行分组的项目 | `ctx.workspaceRegistry` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Workspace 子系统](../../docs/subsystems/workspace.zh.md)——工作区、项目及其会话的权威功能约定。
- [领域 KV 存储 Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——工作区与项目记录背后的存储设计。
- [Workspace UI 产品流 Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md)——首次启动如何从会话历史构建工作区，以及 GUI 如何排序。
- [历史删除 Workspace 注册记录决策](../../.agents/notes/archived/feature/2026-07-27-workspace-registration-deletion.md)——为什么移除工作区绝不会删除其文件夹或会话。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
