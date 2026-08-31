-- Genius SetList Bridge Script v3
-- Actions > Load ReaScript > genius_bridge.lua > Run
-- Optional: Actions > Add to startup actions

-- ── Singleton guard: only one instance at a time ────────────────────────────
-- Use a heartbeat timestamp so a crashed instance doesn't block restart.
-- The tick loop updates the heartbeat every cycle; if it's stale (>5s), assume crashed.
if reaper.GetExtState("GeniusSetList", "running") == "1" then
  local last_beat = tonumber(reaper.GetExtState("GeniusSetList", "heartbeat") or "0") or 0
  if os.time() - last_beat < 5 then
    return  -- live instance is running; silently ignore duplicate launch
  end
  -- Heartbeat is stale — previous instance crashed; take over
end
reaper.SetExtState("GeniusSetList", "running", "1", false)  -- false = session only, not persisted
reaper.atexit(function()
  reaper.SetExtState("GeniusSetList", "running", "0", false)
end)
-- ────────────────────────────────────────────────────────────────────────────

local STATE_FILE  = reaper.GetResourcePath() .. "/genius_state.json"
local CMD_FILE    = reaper.GetResourcePath() .. "/genius_cmd.json"
local last_cmd_id = ""
local _should_quit = false

local function write_file(path, data)
  local f = io.open(path, "w")
  if not f then return end
  f:write(data); f:close()
end

local function read_file(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local s = f:read("*a"); f:close()
  return s
end

local function esc(s)
  return (s or ""):gsub('\\', '\\\\'):gsub('"', '\\"')
end

local function color_to_hex(color)
  if not color or color == 0 then return "#4a9eff" end
  -- Windows COLORREF = 0x00BBGGRR
  local r = color        & 0xFF
  local g = (color >> 8) & 0xFF
  local b = (color >>16) & 0xFF
  if r==0 and g==0 and b==0 then return "#4a9eff" end
  return string.format("#%02x%02x%02x", r, g, b)
end

local function collect_regions()
  local out, ri = {}, 0
  local i = 0
  while true do
    local retval, isrgn, pos, rend, name, _, color =
      reaper.EnumProjectMarkers3(0, i)
    if retval == 0 then break end
    if isrgn then
      out[#out+1] = string.format(
        '{"id":"r%d_%d","name":"%s","start":%.4f,"end":%.4f,"color":"%s","index":%d}',
        ri, math.floor(pos*1000), esc(name), pos, rend, color_to_hex(color), ri)
      ri = ri + 1
    end
    i = i + 1
  end
  return "[" .. table.concat(out, ",") .. "]"
end

local function collect_tracks()
  local out = {}
  local n = reaper.CountTracks(0)
  for i = 0, n-1 do
    local tr = reaper.GetTrack(0, i)
    local _, name = reaper.GetTrackName(tr)
    out[#out+1] = string.format('{"index":%d,"name":"%s"}', i, esc(name))
  end
  return "[" .. table.concat(out, ",") .. "]"
end

local function collect_peaks()
  local out = {}
  local n = reaper.CountTracks(0)
  for i = 0, n-1 do
    local tr = reaper.GetTrack(0, i)
    local peak = math.max(
      reaper.Track_GetPeakInfo(tr, 0),
      reaper.Track_GetPeakInfo(tr, 1)
    )
    out[#out+1] = string.format("%.4f", peak)
  end
  return "[" .. table.concat(out, ",") .. "]"
end

local function get_midi_bitmasks()
  -- Reaper stores enabled MIDI devices as bitmasks in the [reaper] section:
  --   midiins / midiins_h  — bit N = input device N enabled
  --   midiouts / midiouts_h — bit N = output device N enabled
  local ins, ins_h, outs, outs_h = 0, 0, 0, 0
  -- Wrap everything in pcall: io.open can succeed but f:lines() can still throw
  -- if Reaper locks reaper.ini between the open and the read.
  pcall(function()
    local ini = reaper.GetResourcePath() .. "/reaper.ini"
    local f = io.open(ini, "r")
    if not f then return end
    local in_section = false
    for line in f:lines() do
      line = line:gsub("\r", "")
      if line == "[reaper]" then
        in_section = true
      elseif line:match("^%[") then
        if in_section then break end
      elseif in_section then
        local v
        v = line:match("^midiins=(%d+)$");    if v then ins    = tonumber(v) end
        v = line:match("^midiins_h=(%d+)$");  if v then ins_h  = tonumber(v) end
        v = line:match("^midiouts=(%d+)$");   if v then outs   = tonumber(v) end
        v = line:match("^midiouts_h=(%d+)$"); if v then outs_h = tonumber(v) end
      end
    end
    f:close()
  end)
  return ins, ins_h, outs, outs_h
end

local function bit_enabled(lo, hi, idx)
  if idx < 32 then return ((lo >> idx) & 1) == 1
  else              return ((hi >> (idx - 32)) & 1) == 1
  end
end

local function collect_midi_devices()
  local ins, ins_h, outs, outs_h = get_midi_bitmasks()
  local out = {}
  local n = reaper.GetNumMIDIInputs()
  for i = 0, n-1 do
    local ok, name = reaper.GetMIDIInputName(i, "")
    if ok then
      out[#out+1] = string.format('{"index":%d,"name":"%s","type":"input","enabled":%s}',
        i, esc(name), bit_enabled(ins, ins_h, i) and "true" or "false")
    end
  end
  local m = reaper.GetNumMIDIOutputs()
  for i = 0, m-1 do
    local ok, name = reaper.GetMIDIOutputName(i, "")
    if ok then
      out[#out+1] = string.format('{"index":%d,"name":"%s","type":"output","enabled":%s}',
        i, esc(name), bit_enabled(outs, outs_h, i) and "true" or "false")
    end
  end
  return "[" .. table.concat(out, ",") .. "]"
end

local function collect_state()
  local play = reaper.GetPlayState()
  local pos  = reaper.GetPlayPosition()
  local proj, proj_path = reaper.EnumProjects(-1, "")
  proj_path = proj_path or ""
  local proj_name = reaper.GetProjectName(proj, "") or ""
  if proj_name == "" and proj_path ~= "" then
    proj_name = proj_path:match("([^/\\]+)%.rpp$") or ""
  end
  return string.format(
    '{"is_playing":%s,"is_paused":%s,"position":%.4f,"proj_path":"%s","proj_name":"%s","regions":%s,"tracks":%s,"peaks":%s,"midi_devices":%s}',
    (play==1) and "true" or "false",
    (play==2) and "true" or "false",
    pos, esc(proj_path), esc(proj_name),
    collect_regions(), collect_tracks(), collect_peaks(), collect_midi_devices())
end

local function process_command()
  local raw = read_file(CMD_FILE)
  if not raw or raw == "" then return end
  local cmd_id = raw:match('"id":"([^"]+)"')
  if not cmd_id or cmd_id == last_cmd_id then return end
  last_cmd_id = cmd_id

  -- Quit command: stops the defer loop so Reaper releases the script file
  if raw:match('"quit":true') then
    _should_quit = true
    write_file(CMD_FILE, "")
    return
  end

  local pos      = raw:match('"pos":([%d%.%-]+)')
  local action   = raw:match('"action":(%d+)')
  local loop_pos = raw:match('"loop_pos":([%d%.%-]+)')

  if loop_pos then
    -- Seek to loop start; if Reaper already stopped at region end, restart playback
    reaper.SetEditCurPos(tonumber(loop_pos), true, true)
    if reaper.GetPlayState() ~= 1 then
      reaper.Main_OnCommand(1007, 0)  -- restart play from new cursor position
    end
  end

  if pos then
    reaper.Main_OnCommand(1016, 0)
    reaper.SetEditCurPos(tonumber(pos), true, false)
  end

  if action then
    reaper.Main_OnCommand(tonumber(action), 0)
  end

  local open_proj = raw:match('"open_project":"([^"]+)"')
  if open_proj then
    reaper.Main_OnCommand(40026, 0)  -- save current
    open_proj = open_proj:gsub("\\\\", "\\")
    reaper.Main_openProject(open_proj)
  end

  write_file(CMD_FILE, "")
end

local function tick()
  process_command()
  if _should_quit then return end  -- stop deferring; Reaper releases the file
  reaper.SetExtState("GeniusSetList", "heartbeat", tostring(os.time()), false)
  write_file(STATE_FILE, collect_state())
  reaper.defer(tick)
end

reaper.defer(tick)
