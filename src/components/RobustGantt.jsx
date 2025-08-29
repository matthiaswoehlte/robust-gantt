import React, { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";

/**
 * RobustGantt.jsx — API‑ready Gantt with overlap lanes, snap, 5‑min grid & drag tooltip
 * Now with precise global hit‑testing so you can grab lower bars in an overlap.
 *
 * This version continues the code you pasted from the other chat ("Gantt Chart Implementierung Hilfe")
 * and integrates the key ideas we discussed:
 * - ✅ Configurable lane offset (2/5/10 px) and max lanes (1–20) via header dropdowns.
 * - ✅ Greedy interval partitioning per resource to assign lanes for overlapping bars.
 * - ✅ Row height expands by (laneCount-1)*laneOffset so shifted bars never clip.
 * - ✅ NEW: Container‑level hit‑testing selects the bar whose vertical center is nearest to the cursor
 *        (even when bars overlap), so you can always grab the lower/shifted bar.
 * - ✅ Edge resize handles preserved; single scrollbar on bars; timeline follows via transform.
 * - ✅ Snap dropdown adapts to Hour/Week/Month; 5‑min grid for 4/6 hours presets; drag tooltip.
 */
// === unified sample data (one base dataset for all views) ===
const SAMPLE_RES_COUNT = 20;           // demo resources
const SAMPLE_TASKS_PER_RESOURCE = 6;   // bars per resource (base density)

function seededRng(seed) {
  let s = seed >>> 0;
  return () => { s^=s<<13; s^=s>>>17; s^=s<<5; return (s>>>0)/0xffffffff; };
}
/** ONE shared task list based on wall-clock (startMs/durationH), independent of view/preset */
function generateBaseSampleTasks(resources, anchorDate, tasksPerRes = 6, seed = 1337) {
  const rnd = seededRng(seed), dayMs = 86400000, hourMs = 3600000;
  const a = new Date(anchorDate);
  const startOfDay = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const tasks = [];
  for (const r of resources) {
    for (let k = 0; k < tasksPerRes; k++) {
      const dayOffset = Math.floor((rnd()*11)-5);     // -5..+5 days
      const startHour = Math.floor(rnd()*20);         // 0..19 h
      const durH = Math.max(1, Math.floor(rnd()*6));  // 1..5 h
      const startMs = startOfDay + dayOffset*dayMs + startHour*hourMs;
      tasks.push({ id: `${r.id}-t${k}`, resourceId: r.id, startMs, durationH: durH });
    }
  }
  return tasks.sort((a,b)=>a.startMs-b.startMs);
}
/** show fewer bars per resource (ratio) – used for hour/day view */
function downsampleByResource(tasks, ratio = 0.5) {
  if (ratio >= 1) return tasks;
  const byRes = new Map();
  for (const t of tasks) {
    if (!byRes.has(t.resourceId)) byRes.set(t.resourceId, []);
    byRes.get(t.resourceId).push(t);
  }
  const out = [];
  for (const arr of byRes.values()) {
    const keep = Math.max(1, Math.floor(arr.length * ratio));
    out.push(...arr.filter((_, i) => i % Math.round(1/ratio) === 0).slice(0, keep));
  }
  return out.sort((a,b)=>a.startMs-b.startMs);
}
// === /unified sample data ===

export default function RobustGantt({
  resources: resourcesProp,
  tasks: tasksProp,
  initialView = 'hour',
  initialPreset,
  initialMonth,
  palette = DEFAULT_PALETTE,
  onTasksChange,
}){
  // ------------ Constants ------------
  const BASE_ROW_PX = 40; // matches --gantt-row-h initial

  // ------------ State ------------
  const [view, setView] = useState(initialView);
  const [preset, setPreset] = useState(() => initialPreset ?? (initialView==='hour' ? '24 Hours' : initialView==='week' ? 'Full Week' : 'Full Month'));
  const [anchorMonth, setAnchorMonth] = useState(() => {
    if (initialMonth) return initialMonth;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  });
  // View-Datum nur für Hour-View (Default: heute 00:00)
	const [hourViewDate, setHourViewDate] = useState(() => {
	  const d = new Date();
	  d.setHours(0,0,0,0);
	  return d;
	});


  // Snap step in *view units* (Hour: hours, Week/Month: fractions of a day)
  const [snapUnits, setSnapUnits] = useState(getSnapOptions(initialView, initialPreset ?? defaultPresetFor(initialView))[0].units);
  useEffect(() => {
    const opts = getSnapOptions(view, preset);
    setSnapUnits(opts[0].units);
  }, [view, preset]);

  // Overlap behavior
  const [laneOffset, setLaneOffset] = useState(5); // px per lane step (2/5/10)
  const [maxLanes, setMaxLanes] = useState(10);    // 1..20
  const [hoveredId, setHoveredId] = useState(null);

  const anchorDate = useMemo(() => {
    const [y,m] = (anchorMonth||'1970-01').split('-').map(Number);
    return new Date(y, (m||1)-1, 1);
  }, [anchorMonth]);

  // ------------ Data (API or sample) ------------
  const resources = useMemo(() => {
    return resourcesProp && resourcesProp.length ? resourcesProp : generateResources(120);
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
 
 const tasks = (view === 'hour' ? downsampleByResource(internalTasks, 0.99) : internalTasks);


  // ------------ Layout Refs ------------
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

  // ------------ Scale computation ------------
  const scale = useGanttScale(view, preset, anchorDate, chartScrollRef);

  // Match content widths and set transform to visually align timeline
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

    const x = view === 'week' ? 0 : cs.scrollLeft; // Week has no H-scroll
    tc.style.transform = `translateX(-${x}px)`;
    tc.style.willChange = 'transform';
  }, [scale, view]);

  // Render timeline ticks/labels
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
      renderWeekTimeline(root, preset);
    }
  }, [view, preset, anchorDate, scale]);

  // Scroll sync: bars (single H scrollbar) → timeline (transform) and left table V sync
  useEffect(() => {
    const cs = chartScrollRef.current;
    if (!cs) return;
    const onScroll = () => {
      const tlc = timelineContentRef.current;
      if (tlc) {
        const x = cs.scrollLeft;
        tlc.style.transform = `translateX(-${x}px)`;
        tlc.style.willChange = 'transform';
      }
      const left = tableLeftRef.current; if (left) left.scrollTop = cs.scrollTop;
      rebuildGeom(); // keep hit map in sync while scrolling
    };
    cs.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(onScroll);
    return () => cs.removeEventListener('scroll', onScroll);
  }, []);

  // Resize → recompute scale (by bumping a tick inside hook)
  useEffect(() => {
    const el = chartScrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => { setView(v => v); rebuildGeom(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Dragging / resizing with tooltip + snapping
  const { onBarMouseDown, beginFromElement } = useBarDrag({ view, anchorDate, scale, onTasksChange, setInternalTasks, snapUnits });

  // ---------- Compute per-row lane layout (memoized) ----------
  const rowLayout = useMemo(() => {
    const byId = new Map();
    for (const r of resources){
      const segs = [];
      for (const t of tasks){
        if (t.resourceId !== r.id) continue;
        const seg = projectTaskToView(t, view, preset, (view==='hour' ? hourViewDate : anchorDate));

        if (!seg) continue;
        segs.push({ task: t, seg });
      }
      // Assign lanes greedily
      const { items, laneCount } = assignLanes(segs, maxLanes);
      const rowHeight = BASE_ROW_PX + Math.max(0, laneCount-1) * laneOffset;
      byId.set(r.id, { items, laneCount, rowHeight });
    }
    return byId;
  }, [resources, tasks, view, preset, anchorDate, maxLanes, laneOffset, BASE_ROW_PX, scale]);

  // ----------------- Global hit‑testing so lower bars are selectable -----------------
  // We build a geometry map of rendered bars (client rects) and select the nearest vertically.
  const geomMapRef = useRef(new Map()); // taskId -> { el, rect }

  const rebuildGeom = () => {
    const map = new Map();
    const root = chartContentRef.current;
    if (!root) return;
    const nodes = root.querySelectorAll('[data-bar="1"]');
    nodes.forEach((el) => {
      const id = el.getAttribute('data-taskid');
      if (!id) return;
      map.set(id, { el, rect: el.getBoundingClientRect() });
    });
    geomMapRef.current = map;
  };

  useLayoutEffect(() => {
    rebuildGeom();
    // Also rebuild on window resize to keep rects fresh
    const on = () => rebuildGeom();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [resources, tasks, view, preset, anchorDate, laneOffset, maxLanes, scale]);

  const pickBarAt = (clientX, clientY) => {
    let best = null;
    let bestDy = Infinity;
    geomMapRef.current.forEach(({ el, rect }, taskId) => {
      // Check horizontal overlap first; vertical we'll rank by center distance
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom){
        const cy = rect.top + rect.height/2;
        const dy = Math.abs(clientY - cy);
        if (dy < bestDy){ bestDy = dy; best = { taskId, el, rect }; }
      }
    });
    return best; // may be null
  };

  const onSurfaceMove = (e) => {
    const hit = pickBarAt(e.clientX, e.clientY);
    setHoveredId(hit?.taskId || null);
    if (hit) {
      const xIn = e.clientX - hit.rect.left;
      const edge = 8;
      const nearEdge = xIn < edge || xIn > hit.rect.width - edge;
      document.body.style.cursor = nearEdge ? 'ew-resize' : 'grab';
    } else {
      document.body.style.cursor = 'default';
    }
  };

  const onSurfaceDown = (e) => {
    const hit = pickBarAt(e.clientX, e.clientY);
    if (!hit) return;
    const xIn = e.clientX - hit.rect.left;
    const edge = 8;
    let mode = 'move';
    if (xIn < edge) mode = 'resize-l'; else if (xIn > hit.rect.width - edge) mode = 'resize-r';
    beginFromElement(hit.el, hit.taskId, mode, e.clientX, e.clientY);
    e.preventDefault();
  };

  return (
    <div id="gantt-root" className="w-full h-full bg-gray-900 text-gray-100 select-none">
      {/* Header */}
      <div id="gantt-header-grid" className="grid" style={{ gridTemplateColumns: 'var(--gantt-left-col) 1fr' }}>
        <div id="gantt-title" className="pl-3 pr-0 py-3 border-b border-gray-700 w-fit">
          <h2 className="text-lg font-semibold text-gray-200 whitespace-nowrap">Resources</h2>
        </div>
        <div id="gantt-header-right" className="border-l border-gray-700">
          <div id="gantt-controls" className="flex flex-wrap gap-3 items-center px-3 py-2">
            {/* View selector */}
            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">View:</label>
              <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={view}
                      onChange={e=>{ const v=e.target.value; setView(v); setPreset(defaultPresetFor(v)); }}>
                <option value="hour">Hour</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </div>

            {/* Preset selector follows the active view */}
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

            {/* Month picker */}
            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Month:</label>
              <input id="gantt-month" type="month" className="bg-gray-800 border border-gray-700 rounded px-2 py-1"
                     value={anchorMonth} onChange={e=>setAnchorMonth(e.target.value)} />
            </div>

            {/* Date label */}
			{view === 'hour' ? (
			  <div className="ctrl flex items-center gap-2">
				<label className="text-sm text-gray-300">View Date:</label>
				<input
				  id="gantt-view-date"
				  type="date"
				  className="bg-gray-800 border border-gray-700 rounded px-2 py-1"
				  value={formatDateISO(hourViewDate)}
				  onChange={(e) => {
					const v = e.target.value; // yyyy-mm-dd
					const [y,m,d] = v.split('-').map(Number);
					const nd = new Date(y, (m||1)-1, d||1);
					nd.setHours(0,0,0,0);
					setHourViewDate(nd);
				  }}
				/>
			  </div>
			) : (
			  <div className="ctrl text-sm text-gray-400">
				<span id="gantt-date-label">{formatDateDisplay(new Date())}</span>
			  </div>
			)}

            {/* Snap selector (adapts to view/preset) */}
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

            {/* Lane offset */}
            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Offset:</label>
              <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={laneOffset}
                      onChange={e=> setLaneOffset(parseInt(e.target.value,10))}>
                {[2,5,10].map(v => <option key={v} value={v}>{v} px</option>)}
              </select>
            </div>

            {/* Max lanes */}
            <div className="ctrl flex items-center gap-2">
              <label className="text-sm text-gray-300">Max lanes:</label>
              <select className="bg-gray-800 border border-gray-700 rounded px-2 py-1" value={maxLanes}
                      onChange={e=> setMaxLanes(parseInt(e.target.value,10))}>
                {Array.from({length:20},(_,i)=>i+1).map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>

          {/* Timeline (purely visual, scrolls via transform) */}
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

        {/* Bars scroller (the ONLY scrollbar) */}
        <div id="gantt-chart-scroll" ref={chartScrollRef} className="relative flex-1 overflow-auto">
          <div id="gantt-chart-content" ref={chartContentRef} className="relative"
               onMouseMove={onSurfaceMove} onMouseDown={onSurfaceDown}
          >
            {resources.map((r, rowIdx) => {
              const info = rowLayout.get(r.id) || { items: [], laneCount: 1, rowHeight: BASE_ROW_PX };
              const rowH = info.rowHeight;
              return (
                <div key={r.id} className="relative border-b border-gray-800"
                     style={{ height: `${rowH}px`, background: rowIdx%2===0? 'var(--gantt-bg-odd)' : 'var(--gantt-bg-even)'}}>
                  {info.items?.map(({ task, seg, lane }) => {
                    const { leftPx, widthPx, label } = segToPixels(seg, scale);
                    const color = task.color || colorFor(resourceHash(task.resourceId), DEFAULT_PALETTE);
                    const topPx = 6 + lane * laneOffset;
                    const isHover = hoveredId === task.id;
                    const heightPx = BASE_ROW_PX - 12;
                    return (
                      <div key={task.id}
                           id={`bar-${task.id}`}
                           data-bar="1"
                           data-taskid={task.id}
                           className="absolute rounded text-xs text-white px-2 flex items-center"
                           style={{ left: leftPx, width: widthPx, top: topPx, height: `${heightPx}px`,
                                    background: color, whiteSpace:'nowrap', overflow:'hidden',
                                    outline: isHover? '2px solid rgba(255,255,255,0.35)' : 'none',
                                    pointerEvents: 'none' /* events handled at container for precise hit‑testing */ }}
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

// ----------------- Helpers -----------------

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

function renderHourTimeline(root, pxPerHour, total, contentWidth, show5min){
  const W = Math.round(contentWidth);
  // Major hour lines
  for (let h=0; h<=total; h++){
    const x = Math.round(h*pxPerHour);
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#4b5563;`;
    root.appendChild(line);
  }
  // Half-hour ticks
  for (let h=0; h<total; h++){
    const x = Math.round(h*pxPerHour + pxPerHour/2);
    if (x < W){
      const m = document.createElement('div');
      m.style.cssText = `position:absolute;left:${x}px;top:0;height:60%;width:1px;background:#374151;`;
      root.appendChild(m);
    }
  }
  // 5-minute minor grid (only for 4/6 hours presets)
  if (show5min){
    const pxPerMin = pxPerHour / 60;
    const totalMinutes = total * 60; // 24h → 1440
    for (let min=0; min<=totalMinutes; min+=5){
      const x = Math.round(min * pxPerMin);
      const isHour = min % 60 === 0;
      const isHalf = min % 30 === 0;
      if (!isHour && !isHalf && x < W){
        const tick = document.createElement('div');
        tick.style.cssText = `position:absolute;left:${x}px;top:0;height:35%;width:1px;background:#2b2f36;opacity:0.7;`;
        root.appendChild(tick);
      }
    }
  }
  // Hour labels 00..24
  for (let h=0; h<=total; h++){
    const x = Math.round(h*pxPerHour);
    const lab = document.createElement('div');
    lab.textContent = String(h).padStart(2,'0');
    lab.style.cssText = `position:absolute;top:4px;left:${x}px;font-size:12px;color:#cbd5e1;white-space:nowrap;`;
    lab.style.transform = (h===0)? 'translateX(0)' : (h===total? 'translateX(-100%)' : 'translateX(-50%)');
    root.appendChild(lab);
  }
}

function renderMonthTimeline(root, pxPerDay, totalDays, contentWidth, anchorDate){
  // weekend bands (Sat/Sun)
  for (let d=1; d<=totalDays; d++){
    const dt = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), d);
    const wd = dt.getDay(); // 0=Sun .. 6=Sat
    if (wd === 0 || wd === 6){
      const left = Math.round((d-1) * pxPerDay);
      const band = document.createElement('div');
      band.style.cssText = `position:absolute;left:${left}px;top:0;bottom:0;width:${Math.round(pxPerDay)}px;background:rgba(56,250,191,0.25);pointer-events:none;`;
      root.appendChild(band);
    }
  }
  // day lines
  for (let d=0; d<=totalDays; d++){
    const x = Math.round(d*pxPerDay);
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#4b5563;`;
    root.appendChild(line);
  }
  // labels 1..N
  for (let d=1; d<=totalDays; d++){
    const cx = Math.round((d-0.5)*pxPerDay);
    const lab = document.createElement('div');
    lab.textContent = String(d);
    lab.style.cssText = `position:absolute;top:4px;left:${cx}px;transform:translateX(-50%);font-size:12px;color:#cbd5e1;white-space:nowrap;`;
    root.appendChild(lab);
  }
}


function renderWeekTimeline(root, preset){
  root.innerHTML = '';
  const isWork = /Work/i.test(preset);
  const days = isWork ? 5 : 7;
  const w = root.clientWidth || 800;
  const cell = w / days;

  // weekend bands for Full Week (Sun=0, Sat=6)
  if (!isWork){
    [0,6].forEach(idx => {
      const left = Math.round(idx*cell);
      const band = document.createElement('div');
      band.style.cssText = `position:absolute;left:${left}px;top:0;bottom:0;width:${Math.round(cell)}px;background:rgba(56,250,191,0.25);pointer-events:none;`;
      root.appendChild(band);
    });
  }

  // grid lines
  for (let i=0;i<=days;i++){
    const x = Math.round(i*cell);
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#4b5563;`;
    root.appendChild(line);
  }
  // labels
  const names = isWork ? ['Mon','Tue','Wed','Thu','Fri'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (let i=0;i<names.length;i++){
    const cx = Math.round((i+0.5)*cell);
    const lab = document.createElement('div');
    lab.textContent = names[i];
    lab.style.cssText = `position:absolute;top:4px;left:${cx}px;transform:translateX(-50%);font-size:12px;color:#cbd5e1;white-space:nowrap;`;
    root.appendChild(lab);
  }
}

function daysInMonth(date){ return new Date(date.getFullYear(), date.getMonth()+1, 0).getDate(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }
function pad2(n){ return String(n).padStart(2,'0'); }
function formatDateDisplay(d){ const dd=pad2(d.getDate()); const mm=pad2(d.getMonth()+1); const yyyy=d.getFullYear(); return `${dd}/${mm}/${yyyy}`; }
function formatDateISO(d){ // yyyy-mm-dd für <input type="date">
  const pad2 = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

/*OLD
function projectTaskToView(task, view, preset, anchorDate){
  if (view==='hour'){
    const startH = task.start.getHours() + task.start.getMinutes()/60;
    const endH   = task.end.getHours()   + task.end.getMinutes()/60;
    return { startUnit: startH, endUnit: Math.max(startH+0.05, endH), label: task.title };
  }
  if (view==='week'){
    // Use fractional days to keep intra-day precision for tooltip and width
    const work = /Work/i.test(preset);
    const start = task.start; const end = task.end;
    // ISO week starting Monday
    const monIdx = (start.getDay()+6)%7; // 0..6 Mon..Sun
    const dayIdx = work ? monIdx : start.getDay(); // for Full Week use native 0..6 Sun..Sat
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
    const endUnit   = Math.max(startUnit + 1/48, eDay + eFrac); // at least 30 min
    return { startUnit, endUnit, label: task.title };
  }
  return null;
}
OLD*/
function projectTaskToView(task, view, preset, anchorDate){
  // task.start / task.end sind Date-Objekte
  const start = task.start;
  const end   = task.end;

  // Hilfs-Konstanten
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS  = 24 * HOUR_MS;

if (view==='hour'){
  // Fenster = ausgewählter Tag 00:00..24:00 (kommt über anchorDate rein)
  const dayStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(), 0,0,0,0);
  const dayEnd   = new Date(dayStart.getTime() + 24*60*60*1000);

  // Schnittmenge Task x Tagesfenster
  const s = new Date(Math.max(task.start.getTime(), dayStart.getTime()));
  const e = new Date(Math.min(task.end.getTime(),   dayEnd.getTime()));
  if (e <= s) return null;

  const startUnit = (s.getTime() - dayStart.getTime()) / 3600000; // Stunden seit 00:00
  const endUnit   = Math.max(startUnit + (5/60), (e.getTime() - dayStart.getTime()) / 3600000); // mind. 5 Min
  return { startUnit, endUnit, label: task.title };
}

  if (view === 'week') {
    const work = /Work/i.test(preset);
    // Wochenstart: Mo 00:00 (Work Week) oder So 00:00 (Full Week)
    const ws = new Date(anchorDate);
    ws.setHours(0,0,0,0);
    if (work) {
      // ISO: Montag = 0
      const monIdx = (ws.getDay() + 6) % 7; // 0..6 (Mo..So)
      ws.setDate(ws.getDate() - monIdx);
    } else {
      // Full Week: Sonntag = Start
      ws.setDate(ws.getDate() - ws.getDay());
    }
    const dayCount = work ? 5 : 7;
    const we = new Date(ws.getTime() + dayCount * DAY_MS);

    // Schnittmenge Task mit Wochenfenster
    const s = new Date(Math.max(start.getTime(), ws.getTime()));
    const e = new Date(Math.min(end.getTime(),   we.getTime()));
    if (e <= s) return null;

    const startUnit = (s.getTime() - ws.getTime()) / DAY_MS;
    const endUnit   = Math.max(startUnit + (0.5/24), (e.getTime() - ws.getTime()) / DAY_MS); // mind. 30 Min
    return { startUnit, endUnit, label: task.title };
  }

  if (view === 'month') {
    // Monatsfenster: 1. 00:00 bis 1. des Folgemonats 00:00
    const ms = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1, 0, 0, 0, 0);
    const me = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1, 0, 0, 0, 0);

    // Schnittmenge Task mit Monatsfenster
    const s = new Date(Math.max(start.getTime(), ms.getTime()));
    const e = new Date(Math.min(end.getTime(),   me.getTime()));
    if (e <= s) return null;

    const startUnit = (s.getTime() - ms.getTime()) / DAY_MS;
    const endUnit   = Math.max(startUnit + (0.5/24), (e.getTime() - ms.getTime()) / DAY_MS); // mind. 30 Min
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

// Lane assignment (interval partitioning)
function assignLanes(items, maxLanes){
  // items: [{ task, seg: {startUnit,endUnit,label} }]
  const sorted = items.slice().sort((a,b) => a.seg.startUnit - b.seg.startUnit || a.seg.endUnit - b.seg.endUnit);
  const laneEnds = []; // endUnit per lane
  const out = [];
  for (const it of sorted){
    let lane = laneEnds.findIndex(end => end <= it.seg.startUnit + 1e-9);
    if (lane === -1){
      if (laneEnds.length < maxLanes) {
        lane = laneEnds.length;
        laneEnds.push(it.seg.endUnit);
      } else {
        // place in last lane if we've hit the cap
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

// --------- API / Data utilities ----------
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
    const count = 5 + Math.floor(Math.random()*11); // 5..15
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

// --------- Drag & Resize with tooltip + snapping ---------
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

  const hideTip = () => {
    const el = tipRef.current; if (el && el.parentNode) el.parentNode.removeChild(el); tipRef.current = null;
  };

  const updateTip = (startUnit, endUnit, clientX, clientY) => {
    const el = ensureTip();
    const { start, end } = unitsToDateRange(view, anchorDate, startUnit, endUnit);
    el.textContent = `${fmtDateTime(start)} → ${fmtDateTime(end)}`;
    const x = clientX + 12, y = clientY + 12;
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
  };

  const snapPx = (px) => {
    if (!scale || !snapUnits) return Math.round(px);
    const units = px / scale.pxPerUnit;               // convert px → view units
    const snappedUnits = Math.round(units / snapUnits) * snapUnits;
    return Math.round(snappedUnits * scale.pxPerUnit); // back to px
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

      // Tooltip update with snapped units
      const leftPx = parseFloat(ds.el.style.left||'0') || 0;
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
      const durationU = Math.max(0.1, widthPx / scale.pxPerUnit);
      const change = { startUnit, durationU, mode: ds.mode, snapUnits };
      if (typeof onTasksChange === 'function') onTasksChange(ds.task, change);
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
    // Show initial tooltip
    const leftPx = parseInt(el.style.left||'0',10) || 0;
    const widthPx= parseInt(el.style.width||'0',10) || rect.width;
    const startUnit = leftPx / scale.pxPerUnit;
    const endUnit   = startUnit + (widthPx / scale.pxPerUnit);
    const evt = e.nativeEvent || e;
    updateTip(startUnit, endUnit, evt.clientX, evt.clientY);
    e.preventDefault();
  };

  // New: start drag directly from a known element + mode (used by global hit‑testing)
  const beginFromElement = (el, taskId, mode, clientX, clientY) => {
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      mode,
      el,
      startX: clientX,
      origLeft: parseInt(el.style.left||'0',10) || 0,
      origWidth: parseInt(el.style.width||'0',10) || rect.width,
      task: { id: taskId }
    };
    document.body.style.cursor = (mode==='move'? 'grabbing' : 'ew-resize');
    const leftPx = parseInt(el.style.left||'0',10) || 0;
    const widthPx= parseInt(el.style.width||'0',10) || rect.width;
    const startUnit = leftPx / scale.pxPerUnit;
    const endUnit   = startUnit + (widthPx / scale.pxPerUnit);
    updateTip(startUnit, endUnit, clientX, clientY);
  };

  return { onBarMouseDown, beginFromElement };
}

// ---------- Unit→Date helpers ----------
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
  // month
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

// ---- Snap options per view/preset (values are in *view units*) ----
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
    // snapping in fractions of a day
    return [
      { label: '15 min', units: 15/1440 },
      { label: '30 min', units: 30/1440 },
      { label: '1 h',    units: 1/24 },
      { label: '2 h',    units: 2/24 },
      { label: '4 h',    units: 4/24 },
    ];
  }
  // Month view: adapt to preset length
  if (/Full Month/i.test(preset||'')){
    return [
      { label: '6 h',  units: 6/24 },
      { label: '12 h', units: 12/24 },
      { label: '1 d',  units: 1 },
      { label: '2 d',  units: 2 },
    ];
  }
  // 7/14 days → finer grid
  return [
    { label: '1 h',  units: 1/24 },
    { label: '3 h',  units: 3/24 },
    { label: '6 h',  units: 6/24 },
    { label: '12 h', units: 12/24 },
    { label: '1 d',  units: 1 },
  ];
}

// ---------- Example parent using API (acts as a manual and edge-case test harness) ----------
export function GanttContainer(){
  const [res, setRes] = useState([]);
  const [tsk, setTsk] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/resources');
        const resources = await r.json();
        const t = await fetch('/api/tasks');
        const rawTasks = await t.json();
        setRes(resources);
        setTsk(rawTasks.map(x => normalizeTask(x, DEFAULT_PALETTE)));
      } catch (e) {
        const now = new Date();
        const rs = generateResources(20); // smaller set for quick visual test
        setRes(rs);
        setTsk(generateSampleTasks(rs, new Date(now.getFullYear(), now.getMonth(), 1), DEFAULT_PALETTE));
      }
    })();
  }, []);

  const handleTasksChange = (task, change) => {
    // For testing, just log; integrate your PATCH here.
    console.log('Task changed', task, change);
  };

  return (
    <div className="h-screen">
      <RobustGantt resources={res} tasks={tsk} initialView="hour" initialPreset="12 Hours"
                   onTasksChange={handleTasksChange} palette={DEFAULT_PALETTE} />
    </div>
  );
}

// Extra edge-case test: crossing day/month boundaries
export function GanttEdgeCases(){
  const resources = useMemo(() => [{ id:'rA', name:'Alice' }, { id:'rB', name:'Bob' }], []);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth()+1, 0);
  const tasks = [
    { id:'t1', resourceId:'rA', title:'Overnight', start:new Date(now.getFullYear(), now.getMonth(), 10, 22, 0), end:new Date(now.getFullYear(), now.getMonth(), 11, 6, 0), color:'#3B82F6' },
    { id:'t2', resourceId:'rA', title:'Edge Start', start:new Date(monthStart.getFullYear(), monthStart.getMonth(), 1, 0, 30), end:new Date(monthStart.getFullYear(), monthStart.getMonth(), 1, 2, 0), color:'#10B981' },
    { id:'t3', resourceId:'rB', title:'Edge End', start:new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate()-1, 12, 0), end:new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate(), 23, 30), color:'#F59E0B' },
  ];
  return (
    <div className="h-screen">
      <RobustGantt resources={resources} tasks={tasks} initialView="month" initialPreset="14 Days" />
    </div>
  );
}
