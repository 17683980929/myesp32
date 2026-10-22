-- 多功能框架 v3：单击=进入/切换/走完关闭；语音事件见 sys.on
local F,cur,up,last_draw={},0,false,0
local function add(n,d) F[#F+1]={name=n,draw=d} end
local function show(i)
  cur=(i-1)%#F+1
  local f=F[cur]
  local ok,err=pcall(f.draw)
  if not ok then
    display.clear()
    display.text(24,110,"功能「"..f.name.."」出错",16)
    display.text(24,140,string.sub(tostring(err),1,40),16)
    sys.log("功能 "..f.name.." 出错："..tostring(err))
  end
  display.flush()
  last_draw=sys.millis()
  up=true
end
local function click()
  local n=sys.millis()
  if not (up and n-last_draw<30000) then return show(1) end
  if cur>=#F then up=false return display.close() end
  show(cur+1)
end
sys.on("key_click",click)
sys.on("canvas_next",click)
sys.on("open_timetable",function() show(2) end)
sys.on("open_env",function() show(3) end)
sys.on("canvas_close",function() up=false display.close() end)

local T={
{"24",nil,nil,"1","1",nil,nil},
{"18",nil,nil,"1","1",nil,nil},
{nil,"20",nil,"24","24",nil,nil},
{"24",nil,nil,"24","24",nil,nil},
{"20","20",nil,nil,nil,nil,nil},
{nil,"18",nil,"18","18",nil,nil},
{nil,nil,nil,"18","18",nil,nil},
{nil,nil,nil,"1","1",nil,nil},
{nil,nil,nil,nil,nil,nil,nil},
{"20",nil,nil,"1","1",nil,nil},
{"24",nil,nil,"24","24",nil,nil},
{"24","20",nil,"24","24",nil,nil},
{nil,nil,nil,"1","1",nil,nil},
}
local DAYS={"周一","周二","周三","周四","周五","周六","周日"}
local GUT={"1节","2节","3节","4节","5节","6节","7节","8节","9节","晚1","晚2","晚3","晚4"}
local PT={"07:35","08:25","09:15","10:25","11:10","14:20","15:10","16:00","16:50","18:30","19:20","20:15","21:00"}
local PM={}
for i=1,#PT do local h,m=string.match(PT[i], "(%d+):(%d+)") PM[i]=h*60+m end

local function center(y,s,size)
  local n=utf8.len(s) or 1
  local px=(size>=24) and 32 or 16
  local x=(400-n*px)//2
  if x<0 then x=0 end
  display.text(x,y,s,size)
end

local function left_txt(m)
  if m>=60 then
    local h,mm=m//60,m%60
    if mm==0 then return h.." 小时" end
    return h.." 小时 "..mm.." 分"
  end
  return m.." 分钟"
end

local function draw_status()
  display.clear()
  center(8,"上课状态",16)
  local sec,wd=-1,-1
  if sys.clock then sec,wd=sys.clock() end
  if not sec or sec<0 then center(120,"读不到时钟",16) return end
  local now=sec//60
  local col=(wd==0) and 7 or wd
  local cr,nx,n= nil,nil,0
  for r=1,#PM do
    if T[r][col] then
      n=n+1
      if now>=PM[r] and now<PM[r]+45 then cr=r end
      if now<PM[r] and not nx then nx=r end
    end
  end
  if cr then
    center(46,"正在上课",16)
    center(72,GUT[cr].." · "..PT[cr],16)
    center(104,T[cr][col].." 班",24)
    center(160,"还剩 "..(PM[cr]+45-now).." 分钟",16)
    if nx then center(210,"下一节 "..PT[nx].." · "..T[nx][col].." 班",16)
    else center(210,"这是今天的最后一节",16) end
  elseif nx then
    center(46,"现在没课",16)
    center(80,"下一节 "..PT[nx],16)
    center(112,T[nx][col].." 班",24)
    center(168,"还有 "..left_txt(PM[nx]-now),16)
  else
    center(70,"今天的课都上完了",16)
    center(110,"辛苦啦，好好休息",16)
  end
  center(250,DAYS[col].." · 今天 "..n.." 节课",16)
end
add("上课状态",draw_status)

local function put(x,y,w,s)
  local n=utf8.len(s) or 1
  local dx=(w-n*16)//2
  if dx<0 then dx=0 end
  display.text(x+dx,y,s,16)
end
local function cls(x,y,w,v)
  local dw=#v*12-2
  local dx=(w-(dw+18))//2
  if dx<0 then dx=0 end
  display.text(x+dx,y+1,v,16)
  display.text(x+dx+dw+2,y,"班",16)
end
add("政治课表",function()
  display.clear()
  display.text(72,2,"26秋 · 第7周 · 政治课表",16)
  local gx,gy,lw,cw=2,20,36,51
  local rh=(300-gy)//(#GUT+1)
  display.rect(gx,gy,lw,rh,false)
  for c=1,7 do
    local x=gx+lw+(c-1)*cw
    display.rect(x,gy,cw,rh,false)
    put(x,gy+3,cw,DAYS[c])
  end
  for r=1,#GUT do
    local y=gy+r*rh
    display.rect(gx,y,lw,rh,false)
    put(gx,y+3,lw,GUT[r])
  end
  for c=1,7 do
    local x=gx+lw+(c-1)*cw
    local r=1
    while r<=#T do
      local v=T[r][c]
      local y0=gy+r*rh
      if v then
        local r2=r
        while r2<#T and (r2~=5 and r2~=9) and T[r2+1][c]==v do r2=r2+1 end
        local h=(r2-r+1)*rh
        display.rect(x,y0,cw,h,false)
        cls(x,y0+(h-16)//2,cw,v)
        r=r2+1
      else
        display.rect(x,y0,cw,rh,false)
        r=r+1
      end
    end
  end
end)

add("环境与电池",function()
  local t,h=sensor.temp(),sensor.hum()
  local b,mv=sensor.battery(),sensor.voltage()
  display.clear()
  display.text(120,12,"环境与电池",24)
  display.text(28,78,"温度",16)
  display.text(200,72,t<=-50 and "--" or string.format("%.1f C",t),24)
  display.text(28,138,"湿度",16)
  display.text(200,132,h<=-0.5 and "--" or string.format("%.0f %%",h),24)
  display.text(28,198,"电量",16)
  display.text(200,192,b<0 and "--" or (b.." %"),24)
  display.text(28,258,"电压",16)
  display.text(200,252,mv<=0 and "--" or string.format("%.2f V",mv/1000),24)
  display.text(104,278,"单击切换 · 走完回主页",16)
end)

timer.every(10000,function()
  if up and cur==1 then show(1) end
end)
print("框架就绪："..#F.." 个功能")
