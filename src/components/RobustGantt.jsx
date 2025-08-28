import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * RobustGantt — stabiles Restore
 * - Weekend-Overlays (Month + Full Week) im Header UND Bar-Bereich
 * - Exakte Ausrichtung durch identische Pixelbasis (floor-Rundung)
 * - Kein Header-Left-Border (vermeidet 1px-Offset)
 * - Drag/Resize: stabile, einfache Version (wie vorher funktionierend)
 */

export default function RobustGantt({
  resources: resourcesProp,
  tasks: tasksProp,
  initialView = 'month',
  initialPreset,
  initialMonth,
  palette = DEFAULT_PALETTE,
  onTasksChange,
}){
  const BASE_ROW_PX = 40;

  // ---- State ----
  const [view, setView] = useState(initialView);
  const [preset, setPreset] = useState(() => initialPreset ?? defaultPresetFor(initialView));
  const [anchorMonth, setAnchorMonth] = useState(() => {
    if (initialMonth) return initialMonth;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  });

  const [snapUnits, setSnapUnits] = useState(getSnapOptions(initialView, initialPreset ?? defaultPresetFor(initialView))[0].units);
  useEffect(() => { setSnapUnits(getSnapOptions(view, preset)[0].units); }, [view, preset]);

  // Overlap rendering
  const [laneOffset, setLaneOffset] = useState(5);
  const [maxLanes, setMaxLanes] = useState(10);
  const [hoveredId, setHoveredId] = useState(null);

  const anchorDate = useMemo(() => {
    const [y,m] = (anchorMonth||'1970-01').split('-').map(Number);
    return new Date(y, (m||1)-1, 1);
  }, [anchorMonth]);

  // ---- Data ----
  const resources = useMemo(() => {
    return resourcesProp && resourcesProp.length ? resourcesProp : generateResources(30);
  }, [resourcesProp]);

  const [internalTasks, setInternalTasks] = useState([]);
  const normalizedIncoming = useMemo(() => (tasksProp||[]).map(t => normalizeTask(t, palette)), [tasksProp, palette]);

  useEffect(() => {
    if (tasksProp && tasksProp.length){
      setInternalTasks(normalizedIncoming);
    } else {
      setInternalTasks(generateSampleTasks(resources, anchorDate, palette));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources, anchorDate, tasksProp]);

  const tasks = internalTasks;

  // ---- Layout Refs ----
  const timelineContentRef = useRef(null);
  const chartScrollRef     = useRef(null);
  const chartContentRef    = useRef(null);
  const tableLeftRef       = useRef(null);

  // Root CSS vars
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--gantt-left-col', '20%');
    root.style.setProperty('--gantt-row-h', `${BASE_ROW_PX}px`);
    root.style.setProperty('--gantt-bg-odd',  '#1F2937');
    root.style.setProperty('--gantt-bg-even', '#374151');
    root.style.setProperty('--gantt-tooltip-bg', 'rgba(0,0,0,0.9)');
  }, []);

  // ---- Scale ----
  const scale = useGanttScale(view, preset, anchorDate, chartScrollRef);

  // Match content widths & sync transform
  useEffect(() => {
    const tc = timelineContentRef.current;
    const cc = chartContentRef.current;
    const cs = chartScrollRef.current;
    if (!tc || !cc || !cs || !scale) return;

    const W = Math.max(0, Math.round(scale.contentPx));
    tc.style.width = W + 'px';
    tc.style.minWidth = W + 'px';
    cc.style.width = W + 'px';
    cc.style.minWidth = W + 'px';

    const max = Math.max(0, W - cs.clientWidth);
    if (cs.scrollLeft > max) cs.scrollLeft = max;

    const x = view === 'week' ? 0 : cs.scrollLeft; // keine H-Scroll in Week
    tc.style.transform = `translateX(-${x}px)`;
    tc.style.willChange = 'transform';
  }, [scale, view]);

  // ---- Timeline render ----
  useEffect(() => {
    const root = timelineContentRef.current;
    if (!root || !scale) return;
    root.innerHTML = '';
    if (view === 'hour') {
      const fine = preset === '4 Hours' || preset === '6 Hours';
      renderHourTimeline(root, scale.pxPerUnit, scale.totalUnits, scale.contentPx, fine);
    } else if (view === 'month') {
      const days = daysInMonth(anchorDate);
      renderMonthTimeline(root, scale.pxPerUnit, days, scale.contentPx, anchorDate);
    } else {
      renderWeekTimeline(root, preset, scale.pxPerUnit);
    }
  }, [view, preset, anchorDate, scale]);

  // Scroll sync (bars → timeline; left table vertical)
  useEffect(() => {
    const cs = chartScrollRef.current;
    if (!cs) return;
    const onScroll = () => {
      const tlc = timelineContentRef.current;
      if (tlc) tlc.style.transform = `translateX(-${cs.scrollLeft}px)`;
      const left = tableLeftRef.current; if (left) left.scrollTop = cs.scrollTop;
    };
    cs.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(onScroll);
    return () => cs.removeEventListener('scroll', onScroll);
  }, []);

  // Resize → recompute scale
  useEffect(() => {
    const el = chartScrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => { setView(v => v); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Drag & resize (stabile einfache Version)
  const { onBarMouseDown } = useBarDrag({ view, anchorDate, scale, onTasksChange, setInternalTasks, snapUnits });

  // ---- Lane layout per row ----
  const rowLayout = useMemo(() => {
    const byId = new Map();
    for (const r of resources){
      const segs = [];
      for (const t of tasks){
        if (t.resourceId !== r.id) continue;
        const seg = projectTaskToView(t, view, preset, anchorDate);
        if (!seg) continue;
        segs.push({ task: t, seg });
      }
      const { items, laneCount } = assignLanes(segs, maxLanes);
      const rowHeight = BASE_ROW_PX + Math.max(0, laneCount-1) * laneOffset;
      byId.set(r.id, { items, laneCount, rowHeight });
    }
    return byId;
  }, [resources, tasks, view, preset, anchorDate, maxLanes, laneOffset, BASE_ROW_PX, scale]);

  // Bänder für Bars (identische Pixelbasis wie Header)
  const weekendBands = useMemo(
    () => computeWeekendBandsPx(view, preset, anchorDate, scale?.pxPerUnit || 0),
    [view, preset, anchorDate, scale]
  );

  return (
    <div id="gantt-root" className="w-full h-full bg-gray-900 text-gray-100 select-none">
      {/* Header */}
      <div id="gantt-header-grid" className="grid" style={{ gridTemplateColumns: 'var(--gantt-left-col) 1fr' }}>
        <div id="gantt-title" className="pl-3 pr-0 py-3 border-b border-gray-700 w-fit">
          <h2 className="text-lg font-semibold text-gray-200 whitespace-nowrap">Resources</h2>
        </div>
        {/* WICHTIG: KEIN border-l → verhindert 1px-Versatz */}
        <div id="gantt-header-right">
          <div id="gantt-controls" className="flex flex-wrap gap-3 items-center px-3 py-2">
            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">View:</label>
              <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={view}
                      onChange={e=>{ const v=e.target.value; setView(v); setPreset(defaultPresetFor(v)); }}>
                <option value="hour">Hour</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </div>

            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Preset:</label>
              {view==='hour' && (
                <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={preset} onChange={e=>setPreset(e.target.value)}>
                  {['4 Hours','6 Hours','12 Hours','18 Hours','24 Hours'].map(p=> <option key={p} value={p}>{p}</option>)}
                </select>
              )}
              {view==='week' && (
                <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={preset} onChange={e=>setPreset(e.target.value)}>
                  {['Work Week','Full Week'].map(p=> <option key={p} value={p}>{p}</option>)}
                </select>
              )}
              {view==='month' && (
                <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={preset} onChange={e=>setPreset(e.target.value)}>
                  {['7 Days','14 Days','Full Month'].map(p=> <option key={p} value={p}>{p}</option>)}
                </select>
              )}
            </div>

            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Month:</label>
              <input id="gantt-month" type="month" className="bg-gray-800 border border-gray-700 rounded px-2 py-1"
                     value={anchorMonth} onChange={e=>setAnchorMonth(e.target.value)} />
            </div>

            <div className="ctrl text-sm text-gray-400">
              <span id="gantt-date-label">{formatDateDisplay(new Date())}</span>
            </div>

            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Snap:</label>
              <select
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1"
                value={String(snapUnits)}
                onChange={(e)=> setSnapUnits(parseFloat(e.target.value))}
              >
                {getSnapOptions(view, preset).map(o => (
                  <option key={o.label} value={String(o.units)}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Offset:</label>
              <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={laneOffset}
                      onChange={e=> setLaneOffset(parseInt(e.target.value,10))}>
                {[2,5,10].map(v => <option key={v} value={v}>{v} px</option>)}
              </select>
            </div>

            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Max lanes:</label>
              <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={maxLanes}
                      onChange={e=> setMaxLanes(parseInt(e.target.value,10))}>
                {Array.from({length:20},(_,i)=>i+1).map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>

          {/* Timeline */}
          <div id="gantt-timeline-scroll" className="w-full overflow-x-hidden overflow-y-hidden border-b border-gray-700">
            <div id="gantt-timeline-content" ref={timelineContentRef} className="relative h-12" />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex" style={{ height: 'calc(100vh - 120px)' }}>
        {/* Left table */}
        <div id="gantt-table-left" ref={tableLeftRef} className="overflow-hidden border-r border-gray-700"
             style={{ width: 'var(--gantt-left-col)', minWidth: 'var(--gantt-left-col)' }}>
          <div className="h-full">
            {resources.map((r, idx) => {
              const info = rowLayout.get(r.id) || { rowHeight: BASE_ROW_PX };
              return (
                <div key={r.id} className="flex items-center px-4 border-b border-gray-700"
                     style={{ height: `${info.rowHeight}px`, background: idx%2===0? 'var(--gantt-bg-odd)' : 'var(--gantt-bg-even)'}}>
                  <div className="text-sm font-medium text-gray-200 truncate">{r.name}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bars scroller */}
        <div id="gantt-chart-scroll" ref={chartScrollRef} className="relative flex-1 overflow-auto">
          <div id="gantt-chart-content" ref={chartContentRef} className="relative">
            {resources.map((r, rowIdx) => {
              const info = rowLayout.get(r.id) || { items: [], laneCount: 1, rowHeight: BASE_ROW_PX };
              const rowH = info.rowHeight;
              return (
                <div key={r.id} className="relative border-b border-gray-800"
                     style={{ height: `${rowH}px`, background: rowIdx%2===0? 'var(--gantt-bg-odd)' : 'var(--gantt-bg-even)'}}>
                  {/* weekend bands overlay */}
                  {weekendBands.map((b,i)=> (
                    <div key={`wb-${i}`} className="absolute"
                         style={{ left: b.left, width: b.width, top: 0, bottom: 0, background: 'rgba(56, 250, 191, 0.25)', pointerEvents: 'none' }} />
                  ))}
                  {info.items?.map(({ task, seg, lane }) => {
                    const { leftPx, widthPx, label } = segToPixels(seg, scale);
                    const color = task.color || colorFor(resourceHash(task.resourceId), DEFAULT_PALETTE);
                    const topPx = 6 + lane * laneOffset;
                    const z = hoveredId===task.id ? 30 : (lane+1);
                    return (
                      <div key={task.id}
                           className="absolute rounded text-xs text-white px-2 flex items-center cursor-grab"
                           style={{ left: leftPx, width: widthPx, top: topPx, height: `${BASE_ROW_PX - 12}px`,
                                    background: color, whiteSpace:'nowrap', overflow:'hidden', zIndex: z }}
                           onMouseDown={(e) => onBarMouseDown(e, { taskId: task.id })}
                           onMouseEnter={() => setHoveredId(task.id)}
                           onMouseLeave={() => setHoveredId(h => (h===task.id? null : h))}
                      >
                        <span className="truncate w-full text-center">{label}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------- Helpers ----------------- */

function defaultPresetFor(v){
  if (v==='hour') return '24 Hours';
  if (v==='week') return 'Full Week';
  return 'Full Month';
}

function useGanttScale(view, preset, anchorDate, chartScrollRef){
  const [tick, setTick] = useState(0);
  useEffect(() => { const on=()=>setTick(t=>t+1); window.addEventListener('resize', on); return ()=>window.removeEventListener('resize', on); }, []);
  const csW = chartScrollRef.current?.clientWidth || 1200;
  return useMemo(() => {
    let totalUnits = 24, visibleUnits = 24;
    if (view === 'hour'){
      const m = String(preset).match(/([0-9]+)/); visibleUnits = m? clamp(parseInt(m[1],10),1,24) : 24; totalUnits = 24;
    } else if (view === 'week'){
      totalUnits = /Work/i.test(preset) ? 5 : 7; visibleUnits = totalUnits;
    } else {
      totalUnits = daysInMonth(anchorDate); visibleUnits = /14/.test(preset)?14 : /7/.test(preset)?7 : totalUnits;
    }
    const pxPerUnit = csW / Math.max(1, visibleUnits);
    const contentPx = pxPerUnit * totalUnits;
    return { totalUnits, visibleUnits, pxPerUnit, contentPx };
  }, [view, preset, anchorDate, csW, tick]);
}

/* ---- Timeline renderers (pixelgenau mit floor) ---- */

function renderHourTimeline(root, pxPerHour, total, contentWidth, show5min){
  const W = Math.floor(contentWidth);
  const leftOf = (u) => Math.floor(u * pxPerHour);

  for (let h=0; h<=total; h++){
    const x = leftOf(h);
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#4b5563;`;
    root.appendChild(line);
  }
  for (let h=0; h<total; h++){
    const x = leftOf(h + 0.5);
    if (x < W){
      const m = document.createElement('div');
      m.style.cssText = `position:absolute;left:${x}px;top:0;height:60%;width:1px;background:#374151;`;
      root.appendChild(m);
    }
  }
  if (show5min){
    const step = 5/60;
    for (let u=0; u<=total; u+=step){
      const isHour = Math.abs(u - Math.round(u)) < 1e-9;
      const isHalf = Math.abs((u*60)%30) < 1e-9;
      if (!isHour && !isHalf){
        const x = leftOf(u);
        if (x < W){
          const tick = document.createElement('div');
          tick.style.cssText = `position:absolute;left:${x}px;top:0;height:35%;width:1px;background:#2b2f36;opacity:0.7;`;
          root.appendChild(tick);
        }
      }
    }
  }
  for (let h=0; h<=total; h++){
    const x = leftOf(h);
    const lab = document.createElement('div');
    lab.textContent = String(h).padStart(2,'0');
    lab.style.cssText = `position:absolute;top:4px;left:${x}px;font-size:12px;color:#cbd5e1;white-space:nowrap;`;
    lab.style.transform = (h===0)? 'translateX(0)' : (h===total? 'translateX(-100%)' : 'translateX(-50%)');
    root.appendChild(lab);
  }
}

function renderMonthTimeline(root, pxPerDay, totalDays, contentWidth, anchorDate){
  const bandFor = (unitIndex) => {
    const left  = Math.floor(unitIndex * pxPerDay);
    const right = Math.floor((unitIndex + 1) * pxPerDay);
    const width = Math.max(1, right - left);
    return { left, width };
  };
  // weekend bands
  for (let d=1; d<=totalDays; d++){
    const wd = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), d).getDay();
    if (wd === 0 || wd === 6){
      const { left, width } = bandFor(d - 1);
      const band = document.createElement('div');
      band.style.cssText = `position:absolute;left:${left}px;top:0;bottom:0;width:${width}px;background:rgba(56,250,191,0.25);pointer-events:none;`;
      root.appendChild(band);
    }
  }
  for (let d=0; d<=totalDays; d++){
    const x = Math.floor(d*pxPerDay);
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#4b5563;`;
    root.appendChild(line);
  }
  for (let d=1; d<=totalDays; d++){
    const cx = Math.floor((d-0.5)*pxPerDay);
    const lab = document.createElement('div');
    lab.textContent = String(d);
    lab.style.cssText = `position:absolute;top:4px;left:${cx}px;transform:translateX(-50%);font-size:12px;color:#cbd5e1;white-space:nowrap;`;
    root.appendChild(lab);
  }
}

function renderWeekTimeline(root, preset, pxPerDay){
  root.innerHTML = '';
  const isWork = /Work/i.test(preset);
  const days = isWork ? 5 : 7;

  if (!isWork){
    const bandFor = (unitIndex) => {
      const left  = Math.floor(unitIndex * pxPerDay);
      const right = Math.floor((unitIndex + 1) * pxPerDay);
      const width = Math.max(1, right - left);
      return { left, width };
    };
    [0,6].forEach(idx => {
      const { left, width } = bandFor(idx);
      const band = document.createElement('div');
      band.style.cssText = `position:absolute;left:${left}px;top:0;bottom:0;width:${width}px;background:rgba(56,250,191,0.25);pointer-events:none;`;
      root.appendChild(band);
    });
  }
  for (let i=0;i<=days;i++){
    const x = Math.floor(i*pxPerDay);
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#4b5563;`;
    root.appendChild(line);
  }
  const names = isWork ? ['Mon','Tue','Wed','Thu','Fri'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (let i=0;i<names.length;i++){
    const cx = Math.floor((i+0.5)*pxPerDay);
    const lab = document.createElement('div');
    lab.textContent = names[i];
    lab.style.cssText = `position:absolute;top:4px;left:${cx}px;transform:translateX(-50%);font-size:12px;color:#cbd5e1;white-space:nowrap;`;
    root.appendChild(lab);
  }
}

/* ---- General helpers ---- */

function daysInMonth(date){ return new Date(date.getFullYear(), date.getMonth()+1, 0).getDate(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }
function pad2(n){ return String(n).padStart(2,'0'); }
function formatDateDisplay(d){ const dd=pad2(d.getDate()); const mm=pad2(d.getMonth()+1); const yyyy=d.getFullYear(); return `${dd}/${mm}/${yyyy}`; }

function projectTaskToView(task, view, preset, anchorDate){
  if (view==='hour'){
    const startH = task.start.getHours() + task.start.getMinutes()/60;
    const endH   = task.end.getHours()   + task.end.getMinutes()/60;
    return { startUnit: startH, endUnit: Math.max(startH+0.05, endH), label: task.title };
  }
  if (view==='week'){
    const work = /Work/i.test(preset);
    const start = task.start; const end = task.end;
    const monIdx = (start.getDay()+6)%7; // Mon..Sun 0..6
    const dayIdx = work ? monIdx : start.getDay();
    const dayCount = work ? 5 : 7;
    if (dayIdx<0 || dayIdx>=dayCount) return null;
    const startUnit = dayIdx + (start.getHours()+ start.getMinutes()/60)/24;
    const endUnit   = Math.min(dayCount, dayIdx + Math.max(1/24, ((end - start)/86400000)));
    return { startUnit, endUnit, label: task.title };
  }
  if (view==='month'){
    const dim = daysInMonth(anchorDate);
    const sDay = clamp(task.start.getDate(),1,dim) - 1;
    const eDay = clamp(task.end.getDate(),1,dim) - 1;
    const sFrac = (task.start.getHours()+task.start.getMinutes()/60)/24;
    const eFrac = (task.end.getHours()+task.end.getMinutes()/60)/24;
    const startUnit = sDay + sFrac;
    const endUnit   = Math.max(startUnit + 1/48, eDay + eFrac);
    return { startUnit, endUnit, label: task.title };
  }
  return null;
}

function segToPixels(seg, scale){
  if (!seg || !scale) return { leftPx: 0, widthPx: 0, label: seg?.label||'' };
  const { startUnit, endUnit, label } = seg;
  const leftPx  = Math.round(startUnit * scale.pxPerUnit);
  const widthPx = Math.max(4, Math.round((endUnit - startUnit) * scale.pxPerUnit));
  return { leftPx, widthPx, label };
}

// Weekend-Bänder exakt an Grid-Linien (Bar-Bereich nutzt dieselbe pxBasis)
function computeWeekendBandsPx(view, preset, anchorDate, pxPerUnit){
  const out = [];
  if (!pxPerUnit) return out;
  const bandFor = (unitIndex) => {
    const left  = Math.floor(unitIndex * pxPerUnit);
    const right = Math.floor((unitIndex + 1) * pxPerUnit);
    const width = Math.max(1, right - left);
    return { left, width };
  };
  if (view === 'month'){
    const dim = daysInMonth(anchorDate);
    for (let d = 1; d <= dim; d++){
      const wd = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), d).getDay();
      if (wd === 0 || wd === 6) out.push(bandFor(d - 1));
    }
  } else if (view === 'week' && !/Work/i.test(preset || '')){
    out.push(bandFor(0));
    out.push(bandFor(6));
  }
  return out;
}

/* ---- Drag & Resize (stabile, einfache Version) ---- */
function useBarDrag({ view, anchorDate, scale, onTasksChange, setInternalTasks, snapUnits }){
  const dragRef = useRef(null);
  const tipRef = useRef(null);

  const ensureTip = () => {
    if (tipRef.current) return tipRef.current;
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.zIndex = '9999';
    el.style.background = 'var(--gantt-tooltip-bg)';
    el.style.color = '#fff';
    el.style.padding = '6px 8px';
    el.style.borderRadius = '6px';
    el.style.fontSize = '12px';
    el.style.pointerEvents = 'none';
    el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
    document.body.appendChild(el);
    tipRef.current = el;
    return el;
  };
  const hideTip = () => { const el = tipRef.current; if (el && el.parentNode) el.parentNode.removeChild(el); tipRef.current = null; };

  const updateTip = (startUnit, endUnit, clientX, clientY) => {
    const el = ensureTip();
    const { start, end } = unitsToDateRange(view, anchorDate, startUnit, endUnit);
    el.textContent = `${fmtDateTime(start)} → ${fmtDateTime(end)}`;
    el.style.left = (clientX + 12) + 'px';
    el.style.top  = (clientY + 12) + 'px';
  };

  const snapPx = (px) => {
    if (!scale || !snapUnits) return Math.round(px);
    const units = px / scale.pxPerUnit;
    const snappedUnits = Math.round(units / snapUnits) * snapUnits;
    return Math.round(snappedUnits * scale.pxPerUnit);
  };

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current || !scale) return;
      const ds = dragRef.current;
      const dx = e.clientX - ds.startX;

      if (ds.mode === 'move'){
        const targetLeft = ds.origLeft + dx;
        const newLeft = snapPx(targetLeft);
        ds.el.style.left = newLeft + 'px';
      } else if (ds.mode === 'resize-l'){
        const targetLeft = ds.origLeft + dx;
        const newLeft = snapPx(targetLeft);
        const newWidth = Math.max(4, Math.round(ds.origWidth - (newLeft - ds.origLeft)));
        ds.el.style.left = newLeft + 'px';
        ds.el.style.width = newWidth + 'px';
      } else if (ds.mode === 'resize-r'){
        const endTarget = ds.origLeft + ds.origWidth + dx;
        const snappedEnd = snapPx(endTarget);
        const newWidth = Math.max(4, Math.round(snappedEnd - ds.origLeft));
        ds.el.style.width = newWidth + 'px';
      }

      const leftPx  = parseFloat(ds.el.style.left||'0') || 0;
      const widthPx = parseFloat(ds.el.style.width||'0') || ds.el.getBoundingClientRect().width;
      const startUnit = leftPx / scale.pxPerUnit;
      const endUnit   = startUnit + (widthPx / scale.pxPerUnit);
      updateTip(startUnit, endUnit, e.clientX, e.clientY);
    };

    const onUp = () => {
      if (!dragRef.current || !scale) { hideTip(); dragRef.current=null; return; }
      const ds = dragRef.current;
      const el = ds.el;
      const leftPx = parseFloat(el.style.left||'0') || 0;
      const widthPx= parseFloat(el.style.width||'0') || el.getBoundingClientRect().width;
      const startUnit = leftPx / scale.pxPerUnit;
      const endUnit   = startUnit + Math.max(0.1, widthPx / scale.pxPerUnit);
      const change = { startUnit, durationU: endUnit - startUnit, mode: ds.mode, snapUnits };
      if (typeof onTasksChange === 'function') onTasksChange(ds.task, change);
      // State nicht verändern (stabiler Stand)
      setInternalTasks(prev => prev.map(t => t.id===ds.task.id ? t : t));
      dragRef.current = null;
      document.body.style.cursor = 'default';
      hideTip();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [view, anchorDate, scale, onTasksChange, setInternalTasks, snapUnits]);

  const onBarMouseDown = (e, { taskId }) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const xIn = e.clientX - rect.left;
    const edge = 8;
    let mode = 'move';
    if (xIn < edge) mode = 'resize-l'; else if (xIn > rect.width - edge) mode = 'resize-r';
    dragRef.current = {
      mode,
      el,
      startX: e.clientX,
      origLeft: parseInt(el.style.left||'0',10) || 0,
      origWidth: parseInt(el.style.width||'0',10) || rect.width,
      task: { id: taskId }
    };
    document.body.style.cursor = (mode==='move'? 'grabbing' : 'ew-resize');
    const leftPx = parseInt(el.style.left||'0',10) || 0;
    const widthPx= parseInt(el.style.width||'0',10) || rect.width;
    const startUnit = leftPx / scale.pxPerUnit;
    const endUnit   = startUnit + (widthPx / scale.pxPerUnit);
    updateTip(startUnit, endUnit, e.clientX, e.clientY);
    e.preventDefault();
  };

  return { onBarMouseDown };
}

/* ---- Snap options ---- */
function getSnapOptions(view, preset){
  if (view === 'hour'){
    return [
      { label: '1 min',  units: 1/60 },
      { label: '5 min',  units: 5/60 },
      { label: '10 min', units: 10/60 },
      { label: '15 min', units: 15/60 },
    ];
  }
  if (view === 'week'){
    return [
      { label: '15 min', units: 15/1440 },
      { label: '30 min', units: 30/1440 },
      { label: '1 h',    units: 1/24 },
      { label: '2 h',    units: 2/24 },
      { label: '4 h',    units: 4/24 },
    ];
  }
  if (/Full Month/i.test(preset||'')){
    return [
      { label: '6 h',  units: 6/24 },
      { label: '12 h', units: 12/24 },
      { label: '1 d',  units: 1 },
      { label: '2 d',  units: 2 },
    ];
  }
  return [
    { label: '1 h',  units: 1/24 },
    { label: '3 h',  units: 3/24 },
    { label: '6 h',  units: 6/24 },
    { label: '12 h', units: 12/24 },
    { label: '1 d',  units: 1 },
  ];
}

/* ---- Data utils ---- */
const DEFAULT_PALETTE = [
  '#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#06B6D4','#84CC16','#F97316','#E11D48','#14B8A6'
];

function normalizeTask(t, palette){
  const start = (t.start instanceof Date) ? t.start : new Date(t.start);
  const end   = (t.end   instanceof Date) ? t.end   : new Date(t.end);
  const color = t.color || colorFor(resourceHash(t.resourceId), palette);
  return { ...t, start, end, color };
}

function resourceHash(id){ let h=0; for (let i=0;i<id.length;i++){ h=(h*31 + id.charCodeAt(i))|0; } return Math.abs(h); }
function colorFor(h, palette){ return palette[h % palette.length]; }

function generateResources(n){
  const first = ["Alice","Yusuf","Ivan","Leo","Zara","George","Ethan","Iris","Ulrich","Edward","Walter","Petra","Cedric","Delia","Rachel","Maya","Charlie","Xena","Noah","Vera","Diana","Hugo","Julia","Samuel","Kevin","Luna","Bella","Quentin","Marcus","Jake","Nina"]; 
  const last  = ["Robinson","Harris","Nguyen","Johnson","Gonzalez","Flores","Lewis","Young","Hill","Anderson","Wright","Moore","Taylor","Davis","Torres","Perez","Allen","Walker","King","Brown","Sanchez","Williams","Martinez","Ramirez","White","Scott","Clark","Thomas","Nguyen"]; 
  const out=[]; for(let i=0;i<n;i++){ out.push({ id:`r${i}`, name:`${first[i%first.length]} ${last[(i*7)%last.length]}` }); } return out;
}

function generateSampleTasks(resources, anchorDate, palette){
  const tasks = [];
  const dim = daysInMonth(anchorDate);
  for (const r of resources){
    const count = 8 + Math.floor(Math.random()*8);
    for(let i=0;i<count;i++){
      const day = 1 + Math.floor(Math.random()*dim);
      const startH = Math.floor(Math.random()*20);
      const durH = 2 + Math.floor(Math.random()*5);
      const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), day, startH, 0, 0);
      const end   = new Date(start.getTime() + durH*3600*1000);
      const color = colorFor(resourceHash(r.id) + i, palette);
      tasks.push({ id:`${r.id}-t${i}`, resourceId:r.id, title:`T${i+1}`, start, end, color });
    }
  }
  return tasks;
}

/* ---- Unit↔Date helpers ---- */
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function startOfISOWeek(d){ const x=startOfDay(d); const wd=(x.getDay()+6)%7; x.setDate(x.getDate()-wd); return x; }
function addHours(d,h){ const x=new Date(d); x.setTime(x.getTime()+h*3600*1000); return x; }
function addDays(d,dy){ const x=new Date(d); x.setDate(x.getDate()+dy); return x; }

function unitsToDateRange(view, anchorDate, su, eu){
  if (view==='hour'){
    const base = startOfDay(new Date());
    return { start: addHours(base, su), end: addHours(base, eu) };
  }
  if (view==='week'){
    const base = startOfISOWeek(anchorDate);
    const sDay = Math.floor(su); const eDay = Math.floor(eu);
    const sFrac = su - sDay; const eFrac = eu - eDay;
    const s = addHours(addDays(base, sDay), sFrac*24);
    const e = addHours(addDays(base, eDay), Math.max(0.5, eFrac*24));
    return { start: s, end: e };
  }
  const base = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const sDay = Math.floor(su); const eDay = Math.floor(eu);
  const sFrac = su - sDay; const eFrac = eu - eDay;
  const s = addHours(addDays(base, sDay), sFrac*24);
  const e = addHours(addDays(base, eDay), Math.max(0.5, eFrac*24));
  return { start: s, end: e };
}

function fmtDateTime(d){
  const dd=pad2(d.getDate()); const mm=pad2(d.getMonth()+1); const yyyy=d.getFullYear();
  const hh=pad2(d.getHours()); const mi=pad2(d.getMinutes());
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

/* ---- Lane assignment ---- */
function assignLanes(items, maxLanes){
  const sorted = items.slice().sort((a,b) => a.seg.startUnit - b.seg.startUnit || a.seg.endUnit - b.seg.endUnit);
  const laneEnds = [];
  const out = [];
  for (const it of sorted){
    let lane = laneEnds.findIndex(end => end <= it.seg.startUnit + 1e-9);
    if (lane === -1){
      if (laneEnds.length < maxLanes) {
        lane = laneEnds.length;
        laneEnds.push(it.seg.endUnit);
      } else {
        lane = maxLanes - 1;
        laneEnds[lane] = Math.max(laneEnds[lane], it.seg.endUnit);
      }
    } else {
      laneEnds[lane] = it.seg.endUnit;
    }
    out.push({ task: it.task, seg: it.seg, lane });
  }
  return { items: out, laneCount: Math.max(1, laneEnds.length) };
}

/* ---- Example container (optional) ---- */
export function GanttContainer(){
  const [res, setRes] = useState([]);
  const [tsk, setTsk] = useState([]);
  useEffect(() => {
    const now = new Date();
    const rs = generateResources(20);
    setRes(rs);
    setTsk(generateSampleTasks(rs, new Date(now.getFullYear(), now.getMonth(), 1), DEFAULT_PALETTE));
  }, []);
  const handleTasksChange = (task, change) => {
    console.log('Task changed', task, change);
  };
  return (
    <div className="h-screen">
      <RobustGantt resources={res} tasks={tsk} initialView="month" initialPreset="Full Month"
                   onTasksChange={handleTasksChange} palette={DEFAULT_PALETTE} />
    </div>
  );
}
