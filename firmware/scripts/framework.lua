-- 多功能框架 v3：单击 = 进入第一个功能 / 切换下一个；走完最后一个再单击 = 关回主页。
-- 单击即时无延迟（不注册 key_double）；30 秒不碰画布自动回主页（固件保鲜到期）。
-- 语音指令（助手技能 control_screen）：open_timetable / open_env / canvas_close / canvas_next。
-- 固件会等播报结束、画布可见了再派发，不会被语音让位清掉。
-- 加功能：在下面 add("名字", draw) 加一块；draw 只画内容，框架统一 flush。
-- 部署：POST /api/lua 下发 {code}。
local F = {}                       -- 功能表
local cur = 0                      -- 当前功能序号（0 = 还没开过）
local up = false                   -- 画布（大概）还在屏上
local last_draw = 0

local function add(name, draw) F[#F + 1] = { name = name, draw = draw } end

local function show(i)
  cur = (i - 1) % #F + 1
  local f = F[cur]
  local ok, err = pcall(f.draw)
  if not ok then
    display.clear()
    display.text(24, 110, "功能「" .. f.name .. "」出错", 16)
    display.text(24, 140, string.sub(tostring(err), 1, 40), 16)
    sys.log("功能 " .. f.name .. " 出错：" .. tostring(err))
  end
  display.flush()                  -- 画完统一推屏（顺带把页面锚回主页层）
  last_draw = sys.millis()
  up = true
end

local function click()               -- 单击 = 进第一个 / 切下一个 / 走完关闭
  local now = sys.millis()
  if not (up and now - last_draw < 30000) then
    return show(1)                 -- 画布不在屏上（主页）→ 进第一个功能
  end
  if cur >= #F then                -- 最后一个功能上再单击 → 关画布回主页
    up = false
    return display.close()
  end
  show(cur + 1)                    -- 否则切到下一个
end

sys.on("key_click", click)

-- ── 语音/服务器指令（固件播报结束后派发）──────────────────────────
sys.on("canvas_next", click)
sys.on("open_timetable", function() show(2) end)
sys.on("open_env", function() show(3) end)
sys.on("canvas_close", function()
  up = false
  display.close()
end)

-- ── 课表数据（页面 1 的上课状态也用这份）─────────────────────────────
local T = {
  --   周一   周二   周三   周四   周五   周六   周日
  { "24",  nil,   nil,  "1",  "1",  nil,  nil },  -- 1节 07:35
  { "18",  nil,   nil,  "1",  "1",  nil,  nil },  -- 2节 08:25
  { nil,  "20",   nil,  "24", "24",  nil,  nil },  -- 3节 09:15
  { "24",  nil,   nil,  "24", "24",  nil,  nil },  -- 4节 10:25
  { "20",  "20",   nil,  nil,  nil,  nil,  nil },  -- 5节 11:10
  { nil,  "18",   nil,  "18", "18",  nil,  nil },  -- 6节 14:20
  { nil,  nil,    nil,  "18", "18",  nil,  nil },  -- 7节 15:10
  { nil,  nil,    nil,  "1",  "1",   nil,  nil },  -- 8节 16:00
  { nil,  nil,    nil,  nil,  nil,   nil,  nil },  -- 9节 16:50（全周空）
  { "20",  nil,   nil,  "1",  "1",   nil,  nil },  -- 晚1 18:30
  { "24",  nil,   nil,  "24", "24",  nil,  nil },  -- 晚2 19:20
  { "24",  "20",   nil,  "24", "24",  nil,  nil },  -- 晚3 20:15
  { nil,  nil,    nil,  "1",  "1",   nil,  nil },  -- 晚4 21:00
}

local DAYS = { "周一", "周二", "周三", "周四", "周五", "周六", "周日" }
local GUT  = { "1节", "2节", "3节", "4节", "5节", "6节", "7节", "8节", "9节",
               "晚1", "晚2", "晚3", "晚4" }
local PT   = { "07:35", "08:25", "09:15", "10:25", "11:10", "14:20", "15:10",
               "16:00", "16:50", "18:30", "19:20", "20:15", "21:00" }
local PT_MIN = {}
for i = 1, #PT do
  local h, m = string.match(PT[i], "(%d+):(%d+)")
  PT_MIN[i] = tonumber(h) * 60 + tonumber(m)
end
local CLASS_MIN = 45                -- 一节课按 45 分钟算

-- ── 功能 1：上课状态（今天第几节 / 还剩多久）────────────────────────
local function center(y, s, size)
  local n = utf8.len(s) or 1
  local px = (size >= 24) and 32 or 16
  local x = (400 - n * px) // 2
  if x < 0 then x = 0 end
  display.text(x, y, s, size)
end

local function left_txt(mins)
  if mins >= 60 then
    local h, m = mins // 60, mins % 60
    if m == 0 then return h .. " 小时" end
    return h .. " 小时 " .. m .. " 分"
  end
  return mins .. " 分钟"
end

local function draw_status()
  display.clear()
  center(8, "上课状态", 16)

  -- 老固件没有 sys.clock（0.1.27 及以前）：降级显示"读不到时钟"，别整页报错
  local sec, wd = -1, -1
  if sys.clock then sec, wd = sys.clock() end
  if not sec or sec < 0 then
    center(120, "读不到时钟", 16)
    return
  end

  local now = sec // 60
  local col = (wd == 0) and 7 or wd          -- 课表列：1=周一 … 7=周日
  local cur_r, nxt_r, today_n = nil, nil, 0
  for r = 1, #PT_MIN do
    if T[r][col] then
      today_n = today_n + 1
      if now >= PT_MIN[r] and now < PT_MIN[r] + CLASS_MIN then cur_r = r end
      if now < PT_MIN[r] and not nxt_r then nxt_r = r end
    end
  end

  if cur_r then
    local left = PT_MIN[cur_r] + CLASS_MIN - now
    center(46, "正在上课", 16)
    center(72, GUT[cur_r] .. " · " .. PT[cur_r], 16)
    center(104, T[cur_r][col] .. " 班", 24)
    center(160, "还剩 " .. left .. " 分钟", 16)
    if nxt_r then
      center(210, "下一节 " .. PT[nxt_r] .. " · " .. T[nxt_r][col] .. " 班", 16)
    else
      center(210, "这是今天的最后一节", 16)
    end
  elseif nxt_r then
    center(46, "现在没课", 16)
    center(80, "下一节 " .. PT[nxt_r], 16)
    center(112, T[nxt_r][col] .. " 班", 24)
    center(168, "还有 " .. left_txt(PT_MIN[nxt_r] - now), 16)
  else
    center(70, "今天的课都上完了", 16)
    center(110, "辛苦啦，好好休息", 16)
  end

  center(250, DAYS[col] .. " · 今天 " .. today_n .. " 节课", 16)
end

add("上课状态", draw_status)

-- ── 功能 2：政治课表 ────────────────────────────────────────────────
local function put(x, y, w, s)               -- 16px 字水平居中
  local n = utf8.len(s) or 1
  local dx = (w - n * 16) // 2
  if dx < 0 then dx = 0 end
  display.text(x + dx, y, s, 16)
end

local function cls(x, y, w, v)               -- "24班"：数字 + 班
  local dw = #v * 12 - 2
  local dx = (w - (dw + 18)) // 2
  if dx < 0 then dx = 0 end
  display.text(x + dx, y + 1, v, 16)
  display.text(x + dx + dw + 2, y, "班", 16)
end

local function mergable(r)                   -- 午休（5|6）、晚饭（9|晚1）不跨段合并
  return r ~= 5 and r ~= 9
end

add("政治课表", function()
  display.clear()
  display.text(72, 2, "26秋 · 第7周 · 政治课表", 16)

  local gx, gy, lw, cw = 2, 20, 36, 51
  local rh = (300 - gy) // (#GUT + 1)        -- 表头+13 行刚好铺满 300px
  display.rect(gx, gy, lw, rh, false)
  for c = 1, 7 do
    local x = gx + lw + (c - 1) * cw
    display.rect(x, gy, cw, rh, false)
    put(x, gy + 3, cw, DAYS[c])
  end
  for r = 1, #GUT do
    local y = gy + r * rh
    display.rect(gx, y, lw, rh, false)
    put(gx, y + 3, lw, GUT[r])
  end
  for c = 1, 7 do
    local x = gx + lw + (c - 1) * cw
    local r = 1
    while r <= #T do
      local v = T[r][c]
      local y0 = gy + r * rh
      if v then
        local r2 = r
        while r2 < #T and mergable(r2) and T[r2 + 1][c] == v do r2 = r2 + 1 end
        local h = (r2 - r + 1) * rh
        display.rect(x, y0, cw, h, false)
        cls(x, y0 + (h - 16) // 2, cw, v)
        r = r2 + 1
      else
        display.rect(x, y0, cw, rh, false)
        r = r + 1
      end
    end
  end
end)

-- ── 功能 3：环境与电池 ─────────────────────────────────────────────
add("环境与电池", function()
  local t, h = sensor.temp(), sensor.hum()
  local b, mv = sensor.battery(), sensor.voltage()
  display.clear()
  display.text(120, 12, "环境与电池", 24)
  display.text(28, 78, "温度", 16)
  display.text(200, 72, t <= -50 and "--" or string.format("%.1f C", t), 24)
  display.text(28, 138, "湿度", 16)
  display.text(200, 132, h <= -0.5 and "--" or string.format("%.0f %%", h), 24)
  display.text(28, 198, "电量", 16)
  display.text(200, 192, b < 0 and "--" or (b .. " %"), 24)
  display.text(28, 258, "电压", 16)
  display.text(200, 252, mv <= 0 and "--" or string.format("%.2f V", mv / 1000), 24)
  display.text(104, 278, "单击切换 · 走完回主页", 16)
end)

-- 上课状态页每 10 秒自己刷新一次（只在它显示时）
timer.every(10000, function()
  if up and cur == 1 then show(1) end
end)

print("多功能框架就绪：" .. #F .. " 个功能（单击进入/切换，走完回主页）")
