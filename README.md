# Learn From Failure

<div align="center">

![Icon](icon.svg)

**让 AI 助手从错误中学习，治本不治标**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue.svg)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![Version](https://img.shields.io/badge/version-1.0.3-green.svg)](https://github.com/MarbleSoda7/learn-from-failure)

[English](#english) | [中文](#chinese)

</div>

---

## <a id="english"></a>English

### Core Problem Solved

AI models often **treat symptoms instead of root causes**:

**Bad (treating symptoms)**:
- Using try-catch to ignore errors
- Creating fake/empty files to satisfy checks
- Disabling validation or security
- **Starting over** when encountering small issues (wastes time, repeats mistakes)
- Commenting out error-reporting code

**Good (fixing root cause)**:
- Identify **WHY** the error occurred
- Fix the underlying issue (wrong path, wrong config, wrong approach)
- **Build incrementally** on successful baselines
- Freeze stable parts, iterate on new features
- Ask for clarification when root cause is unclear

### Features

#### 1. Experience Recording
Document what works and what doesn't:
- Success/failure tracking
- Root cause analysis (mandatory for workarounds)
- Solution types: root_cause, workaround, temporary
- Context preservation

#### 2. Smart Search
Find relevant past experiences:
- Search both global and project-specific knowledge
- Project experiences prioritized over global
- Pattern recognition for recurring issues

#### 3. System Prompt Integration
Guidance appears automatically:
- Anti-pattern warnings
- Debugging methodology
- Recent error patterns
- Project and global experiences

#### 4. Commands (10 total)
- `/lff-stats` - Overall statistics
- `/lff-global` - Global experiences
- `/lff-project` - Project experiences
- `/lff-failures` - Failure records
- `/lff-patterns` - Error patterns
- `/lff-record` - Manual recording
- `/lff-temp` - Temporary solutions
- `/lff-search` - Search experiences
- `/lff-debug` - Debug info
- `/lff-clear` - Clear data

### Installation

```bash
dsh plugin install github:MarbleSoda7/learn-from-failure
```

### Usage

The plugin works automatically - no configuration needed:

1. **Automatic Recording**: Call `record_experience` when you solve problems
2. **Automatic Search**: The model searches past experiences before trying solutions
3. **Manual Commands**: Use `/lff-*` commands to inspect data

### Tools

- `record_experience` - Record success/failure experiences
- `search_experience` - Search global + project experiences
- `search_learned_errors` - Legacy error search
- `list_temporary_solutions` - Find workarounds needing review
- `report_error_solution` - Legacy error reporting
- `cleanup_temp_files` - Clean debug files

### Storage

- **Global**: `~/.dsh/profiles/<profile>/storage/learn_from_failure/`
- **Project**: `<project>/.experiences/`

### License

MIT

---

## <a id="chinese"></a>中文

### 核心问题

AI 模型经常**治标不治本**：

**❌ 错误做法（治标）**:
- 用 try-catch 忽略错误
- 创建空文件应付检查
- 禁用验证或安全功能
- **遇到小问题就重来**（浪费时间，重复犯错）
- 注释掉错误报告代码

**✅ 正确做法（治本）**:
- 找出**为什么**出错
- 修复根本原因（路径错误、配置错误、方法错误）
- **在成功基础上增量构建**
- 冻结稳定部分，迭代新功能
- 不清楚根因时主动询问

### 功能特性

#### 1. 经验记录
记录成功和失败：
- 成功/失败追踪
- 根因分析（临时方案必填）
- 方案类型：root_cause（治本）、workaround（绕过）、temporary（临时）
- 上下文保存

#### 2. 智能搜索
查找相关经验：
- 同时搜索全局和项目知识
- 项目经验优先
- 识别重复问题模式

#### 3. 系统提示词集成
自动显示指导：
- 反模式警告
- 调试方法论
- 最近错误模式
- 项目和全局经验

#### 4. 命令（10个）
- `/lff-stats` - 整体统计
- `/lff-global` - 全局经验
- `/lff-project` - 项目经验
- `/lff-failures` - 失败记录
- `/lff-patterns` - 错误模式
- `/lff-record` - 手动记录
- `/lff-temp` - 临时方案
- `/lff-search` - 搜索经验
- `/lff-debug` - 调试信息
- `/lff-clear` - 清除数据

### 安装

```bash
dsh plugin install github:MarbleSoda7/learn-from-failure
```

### 使用

插件自动工作，无需配置：

1. **自动记录**：解决问题时调用 `record_experience`
2. **自动搜索**：模型在尝试方案前会搜索经验
3. **手动命令**：使用 `/lff-*` 命令查看数据

### 工具

- `record_experience` - 记录成功/失败经验
- `search_experience` - 搜索全局+项目经验
- `search_learned_errors` - 旧版错误搜索
- `list_temporary_solutions` - 查找需要审查的临时方案
- `report_error_solution` - 旧版错误报告
- `cleanup_temp_files` - 清理调试文件

### 存储位置

- **全局**: `~/.dsh/profiles/<profile>/storage/learn_from_failure/`
- **项目**: `<项目目录>/.experiences/`

### 许可证

MIT