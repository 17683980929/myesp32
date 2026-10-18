/**
 * lua_runtime.h — Lua 解释器运行时（M5）
 *
 * 服务器通过 WS 下发 {"t":"lua","id":12,"code":"...脚本..."}，
 * 这里在专用任务里执行（白名单 API + 2 秒超时 + 128KB 内存上限），
 * 结果经回调回执 {"t":"lua","id":12,"ok":true,"out":"..."}。
 *
 * 脚本持久化在 fatfs 分区：/fatfs/scripts/active.lua，开机自动执行；
 * 下发的新脚本执行成功才覆盖持久化文件（执行失败保留旧版 = 回滚）。
 */
#pragma once
#include <stdbool.h>

/** 运行结果回调（可能在 Lua 任务或 WS 任务上下文调用；out 已是文本，可为空串） */
typedef void (*lua_result_cb_t)(int id, bool ok, const char *out);

/** 启动运行时：创建任务、挂载 fatfs、开机执行 active.lua（不阻塞） */
void lua_runtime_start(void);

/** 注册结果回调（应在 start 前设置） */
void lua_runtime_set_result_cb(lua_result_cb_t cb);

/** 下发脚本（从 WS 事件里调用；内部复制 code，排队执行） */
void lua_runtime_deploy(int id, const char *code);

/** 投递事件给脚本（sys.on 注册的处理器；没有处理器时静默忽略）。
 *  可在任意任务调用（非 ISR）。 */
void lua_runtime_event(const char *name);

/** 作废队列里还没执行的某类事件（早于此刻入队的）。
 *  单击关掉脚本画布后调用，清掉排队中的 key_double，防止画布刚关又被重画。 */
void lua_runtime_event_drop_pending(const char *name);

/** 是否已有脚本注册了该事件的处理器（主循环据此开关按键双击识别） */
bool lua_runtime_has_event(const char *name);
