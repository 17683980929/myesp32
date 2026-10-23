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

-- 三轮补课表：A=1班 B=18班 C=20班 D=24班，"-"=空；每行 周一..周日
local RS={{"-B--A-A","-B--A-A","--C-D-D","--B-D-D","DBC----","C----B-","-----B-","-----A-","-----A-","-B--C--","-C--C--","-D--D--","-A--D--"},{"-B--A--","-B--A--","--C-D--","--B-D--","DBC----","C----C-","-----C-","------C","------C","-B---B-","-C---B-","-D---A-","-A---A-"},{"-B--AD-","-B--AD-","--C-DB-","--B-DB-","DBC----","C------","-------","-------","-------","-B-----","-C-----","-D-----","-A-----"},
}
local CN={A="1",B="18",C="20",D="24"}
local R=1
local function cell(r,c)
  local k=RS[R][r]:sub(c,c)
  if k=="-" then return nil end
  return CN[k]
end
local DAYS={"周一","周二","周三","周四","周五","周六","周日"}
local GUT={"1节","2节","3节","4节","5节","6节","7节","8节","9节","晚1","晚2","晚3","晚4"}
local PT={"07:35","08:25","09:15","10:25","11:10","14:20","15:10","16:00","16:50","18:30","19:20","20:15","21:00"}
local PM={}
for i=1,#PT do local h,m=string.match(PT[i], "(%d+):(%d+)") PM[i]=h*60+m end
local PE={"08:15","09:05","09:55","11:05","11:45","15:00","15:50","16:40","17:40","19:10","20:00","20:55","21:40"}
local PEM={}
for i=1,#PE do local h,m=string.match(PE[i], "(%d+):(%d+)") PEM[i]=h*60+m end

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
  local sec,wd=-1,-1
  if sys.clock then sec,wd=sys.clock() end
  if not sec or sec<0 then center(120,"读不到时钟",32) return end
  local now=sec//60
  local col=(wd==0) and 7 or wd
  local cr,nx,n=nil,nil,0
  for r=1,#PM do
    if cell(r,col) then
      n=n+1
      if now>=PM[r] and now<PM[r]+45 then cr=r end
      if now<PM[r] and not nx then nx=r end
    end
  end
  center(10,DAYS[col].." "..string.format("%02d:%02d",now//60,now%60),32)
  display.rect(0,52,400,2,true)
  if cr then
    center(66,"正在上课",32)
    center(106,cell(cr,col).." 班",32)
    center(146,"还剩 "..(PEM[cr]-now).." 分钟",32)
    display.rect(50,190,300,8)
    local w=math.floor(294*(now-PM[cr])/(PEM[cr]-PM[cr]))
    if w>0 then display.rect(53,193,w,2,true) end
    if nx then center(212,"下节 "..PT[nx].." "..cell(nx,col).."班",32)
    else center(212,"今天的最后一节",32) end
  elseif nx then
    center(66,"现在没课",32)
    center(106,"下节"..cell(nx,col).."班 "..PT[nx],32)
    center(146,"还有 "..(PM[nx]-now).." 分钟",32)
  else
    center(96,"今天的课上完了",32)
    center(140,"辛苦啦",32)
  end
  center(254,"今天 "..n.." 节",32)
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
  center(2,"第"..R.."轮补课 · 课表",16)
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
    while r<=13 do
      local v=cell(r,c)
      local y0=gy+r*rh
      if v then
        local r2=r
        while r2<13 and (r2~=5 and r2~=9) and cell(r2+1,c)==v do r2=r2+1 end
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

local function setR(n) R=n if up then show(cur+1) end end
pcall(sys.on,"round_1",function() setR(1) end)
pcall(sys.on,"round_2",function() setR(2) end)
pcall(sys.on,"round_3",function() setR(3) end)
print("框架就绪："..#F.." 个功能")
