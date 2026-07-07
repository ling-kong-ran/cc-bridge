/**
 * wiki-graph.js — 知识图谱力导向图渲染器
 * 纯 Canvas 实现，无外部依赖
 * 依赖：全局 viewMemoryFile() (定义于 memory.js)
 */

// ─── 常量 ────────────────────────────────────────────────────
var REPULSION = 12000;       // 库仑斥力常数
var ATTRACTION = 0.008;      // 胡克引力常数
var DAMPING = 0.94;          // 速度阻尼系数
var CENTER_GRAVITY = 0.012;  // 向心力系数
var MAX_ITERATIONS = 420;    // 最大迭代步数
var VELOCITY_THRESHOLD = 0.35; // 停止阈值（平均速度）
var NODE_RADIUS_MIN = 8;     // 最小节点半径
var NODE_RADIUS_MAX = 24;    // 最大节点半径
var LABEL_FONT_SIZE = 11;    // 标签字号
var LABEL_OFFSET = 8;        // 标签与节点间距

// ─── 状态 ────────────────────────────────────────────────────
var wikiGraphNodes = [];       // {id, name, title, size, x, y, vx, vy, radius, degree}
var wikiGraphEdges = [];       // {source, target}
var wikiGraphSimulation = null; // requestAnimationFrame id
var wikiGraphIteration = 0;
var wikiGraphStable = false;
var _lastGraphNodePositions = {}; // 内存缓存：上次模拟收敛后的节点位置 {id: {x, y}}
var _graphSaveTimer = 0;       // debounce timer for localStorage save

// ─── 位置持久化（localStorage）────────────────────────────────
function _graphStorageKey() {
  var cwd = "";
  try { cwd = (typeof cwdInput !== "undefined" && cwdInput) ? cwdInput.value.trim() : ""; } catch(e) {}
  return "ccb_graph_pos_" + (cwd || "default");
}

function saveGraphPositions() {
  if (!wikiGraphNodes || !wikiGraphNodes.length) return;
  var data = {};
  wikiGraphNodes.forEach(function(n) { data[n.id] = { x: n.x, y: n.y }; });
  try { localStorage.setItem(_graphStorageKey(), JSON.stringify(data)); } catch(e) {}
}

function loadGraphPositions() {
  try {
    var raw = localStorage.getItem(_graphStorageKey());
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

// 交互状态
var wikiGraphHovered = null;      // hover 的节点 index
var wikiGraphDragged = null;      // 拖拽的节点 index
var wikiGraphDragOffsetX = 0;
var wikiGraphDragOffsetY = 0;
var wikiGraphIsPanning = false;
var wikiGraphPanStartX = 0;
var wikiGraphPanStartY = 0;

// 变换
var wikiGraphScale = 1;
var wikiGraphOffsetX = 0;
var wikiGraphOffsetY = 0;
var wikiGraphCanvas = null;
var wikiGraphCtx = null;

// ─── 初始化 ──────────────────────────────────────────────────
var _wikiGraphReady = false;
var wikiGraphDragStartPos = null;
var wikiGraphDragStartNode = null;
var wikiGraphDragDidMove = false;
var wikiGraphFocused = null;

function initWikiGraph() {
  if (_wikiGraphReady) {
    // 已初始化，只刷新数据，不重复绑定事件
    var cwd = getCurrentCwdForGraph();
    fetchWikiGraphData(cwd);
    return;
  }

  var canvas = document.getElementById("wiki-graph-canvas");
  if (!canvas) {
    var container = document.getElementById("memory-graph-panel");
    if (!container) return;
    canvas = document.createElement("canvas");
    canvas.id = "wiki-graph-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.cursor = "grab";
    container.appendChild(canvas);
  }
  wikiGraphCanvas = canvas;
  wikiGraphCtx = canvas.getContext("2d");

  resizeWikiGraphCanvas();
  window.addEventListener("resize", resizeWikiGraphCanvas);

  canvas.addEventListener("mousedown", onWikiGraphMouseDown);
  canvas.addEventListener("mousemove", onWikiGraphMouseMove);
  canvas.addEventListener("mouseup", onWikiGraphMouseUp);
  canvas.addEventListener("mouseleave", onWikiGraphMouseUp);
  canvas.addEventListener("wheel", onWikiGraphWheel, { passive: false });
  canvas.addEventListener("dblclick", onWikiGraphDoubleClick);
  canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Memory knowledge graph. Drag to pan, scroll to zoom, click nodes to open memory files.");

  var resetBtn = document.getElementById("btn-graph-reset");
  if (resetBtn) resetBtn.addEventListener("click", resetWikiGraphView);

  _wikiGraphReady = true;

  var cwd = getCurrentCwdForGraph();
  fetchWikiGraphData(cwd);
}

function getCurrentCwdForGraph() {
  // 尝试从全局 cwdInput 获取
  if (typeof cwdInput !== "undefined" && cwdInput) {
    return encodeURIComponent(cwdInput.value.trim() || "");
  }
  return "";
}

function resizeWikiGraphCanvas() {
  if (!wikiGraphCanvas) return;
  var rect = wikiGraphCanvas.parentElement.getBoundingClientRect();
  wikiGraphCanvas.width = rect.width * window.devicePixelRatio;
  wikiGraphCanvas.height = rect.height * window.devicePixelRatio;
  wikiGraphCanvas.style.width = rect.width + "px";
  wikiGraphCanvas.style.height = rect.height + "px";
  wikiGraphCtx = wikiGraphCanvas.getContext("2d");
  wikiGraphCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  wikiGraphCanvas._width = rect.width;
  wikiGraphCanvas._height = rect.height;
  drawWikiGraph();
}

// ─── 数据获取 ────────────────────────────────────────────────
async function fetchWikiGraphData(cwd) {
  var url = "/api/memory/graph";
  if (cwd) url += "?cwd=" + cwd;
  try {
    var resp = await fetch(url);
    var data = await resp.json();
    renderGraph(data);
  } catch (e) {
    console.error("Wiki graph load failed:", e);
  }
}

// ─── 渲染入口 ────────────────────────────────────────────────
function renderGraph(data) {
  if (!data || !data.nodes || !data.edges) return;
  if (!wikiGraphCanvas) return;

  var nodes = data.nodes;
  var edges = data.edges;

  // 停止旧模拟
  stopWikiGraphSimulation();

  // 确保尺寸正确（面板可能刚被显示，需要重新读布局）
  resizeWikiGraphCanvas();

  // 计算每个节点的度
  var degreeMap = {};
  edges.forEach(function(e) {
    degreeMap[e.source] = (degreeMap[e.source] || 0) + 1;
    degreeMap[e.target] = (degreeMap[e.target] || 0) + 1;
  });

  var maxDegree = 1;
  nodes.forEach(function(n) {
    n.degree = degreeMap[n.id] || 0;
    if (n.degree > maxDegree) maxDegree = n.degree;
  });

  var w = wikiGraphCanvas._width || wikiGraphCanvas.width;
  var h = wikiGraphCanvas._height || wikiGraphCanvas.height;

  // 用节点 id 哈希生成确定性初始坐标，避免每次渲染形状不同
  function hashString(str) {
    var value = 0;
    for (var i = 0; i < str.length; i++) {
      value = ((value << 5) - value + str.charCodeAt(i)) | 0;
    }
    return Math.abs(value);
  }

  function initialNodePosition(node, index, total) {
    var ring = Math.max(80, Math.min(w, h) * 0.28);
    var jitter = (hashString("j:" + node.id) % 100) / 100;
    var angle = ((index / Math.max(1, total)) * Math.PI * 2) + jitter * 0.7;
    var distance = ring * (0.72 + jitter * 0.42);
    return {
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance
    };
  }

  // 查缓存位置：localStorage > 内存缓存 > 哈希生成
  var storedPositions = loadGraphPositions();
  // 把 localStorage 数据合并进内存缓存，保证新渲染也能用
  for (var k in storedPositions) {
    if (!_lastGraphNodePositions[k]) {
      _lastGraphNodePositions[k] = storedPositions[k];
    }
  }
  var hasCache = Object.keys(_lastGraphNodePositions).length > 0;

  wikiGraphNodes = nodes.map(function(n, index) {
    var radius = NODE_RADIUS_MIN;
    if (maxDegree > 0 && n.degree > 0) {
      radius = NODE_RADIUS_MIN + Math.sqrt(n.degree / maxDegree) * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
    }
    var cached = hasCache ? _lastGraphNodePositions[n.id] : null;
    var initial = cached || initialNodePosition(n, index, nodes.length);
    return {
      id: n.id,
      name: n.name,
      title: n.title || n.name,
      size: n.size || 0,
      file: n.file || '',
      path: n.path || n.file || '',
      updated_at: n.updated_at || 0,
      degree: n.degree,
      radius: radius,
      x: initial.x,
      y: initial.y,
      vx: 0,
      vy: 0,
      pinned: false,
    };
  });

  // 建立 id -> index 映射
  var idToIndex = {};
  wikiGraphNodes.forEach(function(n, i) { idToIndex[n.id] = i; });

  wikiGraphEdges = edges.map(function(e) {
    return {
      source: idToIndex[e.source],
      target: idToIndex[e.target],
    };
  }).filter(function(e) {
    return e.source !== undefined && e.target !== undefined;
  });

  // 重置状态
  wikiGraphIteration = 0;
  wikiGraphHovered = null;
  wikiGraphFocused = null;
  wikiGraphDragged = null;
  wikiGraphOffsetX = w / 2;
  wikiGraphOffsetY = h / 2;
  wikiGraphScale = Math.max(0.82, Math.min(1.08, Math.min(w, h) / 760));
  updateWikiGraphZoomLabel();

  // 如果所有节点都有缓存位置且节点集合未变，直接跳过模拟
  var allCached = nodes.length > 0 && wikiGraphNodes.every(function(n) {
    return !!_lastGraphNodePositions[n.id];
  });
  if (allCached && Object.keys(_lastGraphNodePositions).length === nodes.length) {
    wikiGraphStable = true;
  } else {
    wikiGraphStable = false;
    startWikiGraphSimulation();
  }
  drawWikiGraph();
}

// ─── 力模拟 ──────────────────────────────────────────────────
function stepWikiGraphSimulation() {
  if (wikiGraphStable) return;

  var nodes = wikiGraphNodes;
  var edges = wikiGraphEdges;
  var n = nodes.length;
  var i, j;

  // 斥力（Coulomb）：每对节点之间
  for (i = 0; i < n; i++) {
    for (j = i + 1; j < n; j++) {
      var a = nodes[i];
      var b = nodes[j];
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) dist = 1;
      var force = REPULSION / (dist * dist);
      var fx = (dx / dist) * force;
      var fy = (dy / dist) * force;
      if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned) { b.vx += fx; b.vy += fy; }
    }
  }

  // 引力（Hooke）：沿边
  edges.forEach(function(e) {
    var a = nodes[e.source];
    var b = nodes[e.target];
    if (!a || !b) return;
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) dist = 1;
    var force = ATTRACTION * dist;
    var fx = (dx / dist) * force;
    var fy = (dy / dist) * force;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  });

  // 向心力
  var cx = 0, cy = 0;
  nodes.forEach(function(node) {
    if (!node.pinned) {
      node.vx -= node.x * CENTER_GRAVITY;
      node.vy -= node.y * CENTER_GRAVITY;
    }
  });

  // 应用速度 + 阻尼
  var totalVelocity = 0;
  nodes.forEach(function(node) {
    if (!node.pinned) {
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
      totalVelocity += Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    }
  });

  wikiGraphIteration++;

  // 判断是否稳定
  var avgVelocity = totalVelocity / n;
  if (avgVelocity < VELOCITY_THRESHOLD || wikiGraphIteration >= MAX_ITERATIONS) {
    wikiGraphStable = true;
    // 缓存最终位置到内存和 localStorage
    _lastGraphNodePositions = {};
    nodes.forEach(function(node) {
      _lastGraphNodePositions[node.id] = { x: node.x, y: node.y };
    });
    saveGraphPositions();
  }

  drawWikiGraph();
}

function startWikiGraphSimulation() {
  stopWikiGraphSimulation();
  wikiGraphStable = false;
  wikiGraphIteration = 0;
  simulateWikiGraphTick();
}

function simulateWikiGraphTick() {
  stepWikiGraphSimulation();
  if (!wikiGraphStable) {
    wikiGraphSimulation = requestAnimationFrame(simulateWikiGraphTick);
  } else {
    wikiGraphSimulation = null;
    drawWikiGraph(); // 最终绘制
  }
}

function stopWikiGraphSimulation() {
  if (wikiGraphSimulation) {
    cancelAnimationFrame(wikiGraphSimulation);
    wikiGraphSimulation = null;
  }
}

function formatWikiGraphNodeTime(value) {
  if (!value) return '';
  var timestamp = Number(value);
  if (!timestamp) return '';
  var date = new Date(timestamp < 10000000000 ? timestamp * 1000 : timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function shortenWikiGraphText(text, maxLen) {
  text = String(text || '');
  if (!text || text.length <= maxLen) return text;
  var keep = Math.max(4, Math.floor((maxLen - 1) / 2));
  return text.slice(0, keep) + '…' + text.slice(-keep);
}

function updateWikiGraphZoomLabel() {
  var el = document.getElementById('graph-zoom-level');
  if (el) el.textContent = Math.round(wikiGraphScale * 100) + '%';
}

function getWikiGraphNodePalette(node) {
  var ratio = node.degree > 0 ? Math.min(node.degree / 6, 1) : 0;
  if (node.degree >= 4) {
    return {
      fill: 'rgba(87, 220, 255, ' + (0.82 + ratio * 0.18) + ')',
      stroke: 'rgba(192, 246, 255, 0.95)',
      glow: 'rgba(87, 220, 255, 0.28)',
      label: '#d6fbff'
    };
  }
  if (node.degree >= 2) {
    return {
      fill: 'rgba(126, 238, 178, ' + (0.78 + ratio * 0.18) + ')',
      stroke: 'rgba(202, 255, 225, 0.92)',
      glow: 'rgba(126, 238, 178, 0.24)',
      label: '#d9ffe9'
    };
  }
  return {
    fill: 'rgba(176, 143, 255, 0.82)',
    stroke: 'rgba(224, 211, 255, 0.86)',
    glow: 'rgba(176, 143, 255, 0.20)',
    label: '#e8ddff'
  };
}

function drawWikiGraphGrid(ctx, w, h) {
  var grid = 40;
  ctx.save();
  ctx.strokeStyle = 'rgba(126, 238, 178, 0.045)';
  ctx.lineWidth = 1;
  for (var x = (wikiGraphOffsetX % grid); x < w; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (var y = (wikiGraphOffsetY % grid); y < h; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWikiGraphTooltip(ctx, node, screenX, screenY, w, h) {
  var updatedAt = formatWikiGraphNodeTime(node.updated_at);
  var lines = [node.title || node.name || 'Memory'];
  if (node.path) lines.push(shortenWikiGraphText(node.path, 46));
  if (updatedAt) lines.push((currentLanguage === 'zh' ? '更新 ' : 'Updated ') + updatedAt);
  lines.push((currentLanguage === 'zh' ? '连接 ' : 'Links ') + node.degree);

  ctx.save();
  ctx.font = '12px sans-serif';
  var width = 0;
  lines.forEach(function(line) { width = Math.max(width, ctx.measureText(line).width); });
  width += 24;
  var height = lines.length * 18 + 18;
  var x = Math.min(w - width - 14, screenX + 18);
  var y = Math.min(h - height - 14, screenY + 18);
  if (x < 12) x = 12;
  if (y < 12) y = 12;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
  ctx.shadowBlur = 22;
  ctx.fillStyle = 'rgba(12, 18, 26, 0.92)';
  roundRect(ctx, x, y, width, height, 12);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(126, 238, 178, 0.22)';
  ctx.stroke();

  ctx.fillStyle = '#e8f3ff';
  ctx.font = '600 12px sans-serif';
  ctx.fillText(lines[0], x + 12, y + 19);
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#8fa4ba';
  for (var i = 1; i < lines.length; i++) {
    ctx.fillText(lines[i], x + 12, y + 19 + i * 18);
  }
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  radius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

// ─── 绘制 ────────────────────────────────────────────────────
function drawWikiGraph() {
  var canvas = wikiGraphCanvas;
  var ctx = wikiGraphCtx;
  if (!canvas || !ctx) return;

  var w = canvas._width || canvas.width;
  var h = canvas._height || canvas.height;

  ctx.clearRect(0, 0, w, h);
  drawWikiGraphGrid(ctx, w, h);

  var nodes = wikiGraphNodes;
  var edges = wikiGraphEdges;

  if (!nodes || !nodes.length) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#8fa4ba";
    ctx.font = "600 15px sans-serif";
    ctx.fillText(currentLanguage === 'zh' ? "当前工作区暂无记忆连接" : "No memory connections yet", w / 2, h / 2 - 8);
    ctx.fillStyle = "#66788c";
    ctx.font = "12px sans-serif";
    ctx.fillText(currentLanguage === 'zh' ? "新建或整理记忆后会在这里形成图谱" : "Create or organize memories to build the graph", w / 2, h / 2 + 18);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.translate(wikiGraphOffsetX, wikiGraphOffsetY);
  ctx.scale(wikiGraphScale, wikiGraphScale);

  var activeNode = wikiGraphHovered !== null && wikiGraphHovered >= 0 ? wikiGraphHovered : wikiGraphFocused;
  var activeEdgeMap = {};
  if (activeNode !== null && activeNode >= 0) {
    edges.forEach(function(e) {
      if (e.source === activeNode || e.target === activeNode) {
        activeEdgeMap[e.source + ':' + e.target] = true;
      }
    });
  }

  // 绘制边：非聚焦边保持安静，聚焦边更亮并带轻微光晕
  edges.forEach(function(e) {
    var a = nodes[e.source];
    var b = nodes[e.target];
    if (!a || !b) return;
    var isActive = activeEdgeMap[e.source + ':' + e.target];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = isActive ? "rgba(126, 238, 178, 0.86)" : "rgba(126, 238, 178, 0.20)";
    ctx.lineWidth = isActive ? 2.4 : 1.15;
    ctx.shadowColor = isActive ? "rgba(126, 238, 178, 0.32)" : "transparent";
    ctx.shadowBlur = isActive ? 10 : 0;
    ctx.stroke();
  });
  ctx.shadowBlur = 0;

  // 绘制节点
  nodes.forEach(function(node, i) {
    var isHovered = (wikiGraphHovered === i);
    var isFocused = (wikiGraphFocused === i);
    var isDragged = (wikiGraphDragged === i);
    var isActive = isHovered || isFocused || isDragged;
    var palette = getWikiGraphNodePalette(node);
    var dimmed = activeNode !== null && activeNode >= 0 && !isActive;

    ctx.save();
    ctx.globalAlpha = dimmed ? 0.38 : 1;
    ctx.fillStyle = palette.glow;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius + (isActive ? 12 : 7), 0, Math.PI * 2);
    ctx.fill();

    var gradient = ctx.createRadialGradient(
      node.x - node.radius * 0.35,
      node.y - node.radius * 0.45,
      Math.max(1, node.radius * 0.12),
      node.x,
      node.y,
      node.radius
    );
    gradient.addColorStop(0, 'rgba(255,255,255,0.92)');
    gradient.addColorStop(0.2, palette.fill);
    gradient.addColorStop(1, palette.fill.replace('0.82', '0.62').replace('0.78', '0.60'));

    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = isActive ? 18 : 8;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius + (isActive ? 2 : 0), 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = isActive ? palette.stroke : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = isActive ? 2.2 : 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.beginPath();
    ctx.arc(node.x - node.radius * 0.28, node.y - node.radius * 0.34, Math.max(2, node.radius * 0.18), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var label = node.title || node.name || "";
    var shouldShowLabel = isActive || node.degree >= 2 || nodes.length <= 18;
    if (label && shouldShowLabel) {
      if (label.length > 22) label = label.substring(0, 20) + "…";
      ctx.save();
      ctx.font = (isActive ? '600 ' : '') + LABEL_FONT_SIZE + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      var textWidth = ctx.measureText(label).width;
      var lx = node.x - textWidth / 2 - 7;
      var ly = node.y + node.radius + LABEL_OFFSET - 3;
      ctx.fillStyle = isActive ? 'rgba(12,18,26,0.78)' : 'rgba(12,18,26,0.54)';
      roundRect(ctx, lx, ly, textWidth + 14, LABEL_FONT_SIZE + 10, 8);
      ctx.fill();
      ctx.fillStyle = isActive ? palette.label : 'rgba(190, 205, 220, 0.78)';
      ctx.fillText(label, node.x, node.y + node.radius + LABEL_OFFSET);
      ctx.restore();
    }
  });

  ctx.restore();

  if (activeNode !== null && activeNode >= 0 && nodes[activeNode]) {
    var active = nodes[activeNode];
    drawWikiGraphTooltip(
      ctx,
      active,
      wikiGraphOffsetX + active.x * wikiGraphScale,
      wikiGraphOffsetY + active.y * wikiGraphScale,
      w,
      h
    );
  }
}

// ─── 坐标转换 ────────────────────────────────────────────────
function wikiGraphScreenToWorld(sx, sy) {
  return {
    x: (sx - wikiGraphOffsetX) / wikiGraphScale,
    y: (sy - wikiGraphOffsetY) / wikiGraphScale,
  };
}

function wikiGraphGetCanvasPos(e) {
  var rect = wikiGraphCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function wikiGraphFindNodeAt(sx, sy) {
  var world = wikiGraphScreenToWorld(sx, sy);
  var nodes = wikiGraphNodes;
  // 逆序遍历，让上层节点优先（后绘制的在上）
  for (var i = nodes.length - 1; i >= 0; i--) {
    var n = nodes[i];
    var dx = world.x - n.x;
    var dy = world.y - n.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= n.radius + 4) return i;
  }
  return -1;
}

// ─── 交互事件 ────────────────────────────────────────────────
function onWikiGraphMouseDown(e) {
  var pos = wikiGraphGetCanvasPos(e);
  var idx = wikiGraphFindNodeAt(pos.x, pos.y);

  wikiGraphDragStartPos = { x: pos.x, y: pos.y };
  wikiGraphDragDidMove = false;

  if (idx >= 0) {
    // 拖拽节点
    wikiGraphDragged = idx;
    var world = wikiGraphScreenToWorld(pos.x, pos.y);
    wikiGraphDragOffsetX = world.x - wikiGraphNodes[idx].x;
    wikiGraphDragOffsetY = world.y - wikiGraphNodes[idx].y;
    wikiGraphNodes[idx].pinned = true;
    if (wikiGraphNodes[idx].vx) wikiGraphNodes[idx].vx = 0;
    if (wikiGraphNodes[idx].vy) wikiGraphNodes[idx].vy = 0;
    wikiGraphCanvas.style.cursor = "grabbing";
    // 记录鼠标按下时的节点索引，mouseup 时判断是否发生了移动
    wikiGraphDragStartNode = idx;
    e.preventDefault();
    return;
  }

  // 背景拖拽（平移）
  wikiGraphIsPanning = true;
  wikiGraphPanStartX = pos.x;
  wikiGraphPanStartY = pos.y;
  wikiGraphCanvas.style.cursor = "grabbing";
  e.preventDefault();
}

function onWikiGraphMouseMove(e) {
  var pos = wikiGraphGetCanvasPos(e);

  if (wikiGraphDragged !== null) {
    wikiGraphDragDidMove = true;
    var world = wikiGraphScreenToWorld(pos.x, pos.y);
    var node = wikiGraphNodes[wikiGraphDragged];
    node.x = world.x - wikiGraphDragOffsetX;
    node.y = world.y - wikiGraphDragOffsetY;
    // 继续模拟一小段时间实现弹性效果
    if (wikiGraphStable) {
      wikiGraphStable = false;
      wikiGraphIteration = 0;
      simulateWikiGraphTick();
    } else {
      drawWikiGraph();
    }
    e.preventDefault();
    return;
  }

  if (wikiGraphIsPanning) {
    var dx = pos.x - wikiGraphPanStartX;
    var dy = pos.y - wikiGraphPanStartY;
    wikiGraphOffsetX += dx;
    wikiGraphOffsetY += dy;
    wikiGraphPanStartX = pos.x;
    wikiGraphPanStartY = pos.y;
    drawWikiGraph();
    e.preventDefault();
    return;
  }

  // hover 检测
  var idx = wikiGraphFindNodeAt(pos.x, pos.y);
  if (idx !== wikiGraphHovered) {
    wikiGraphHovered = idx;
    wikiGraphCanvas.style.cursor = idx >= 0 ? "pointer" : "grab";
    drawWikiGraph();
  }
}

function onWikiGraphMouseUp(e) {
  if (wikiGraphDragged !== null) {
    wikiGraphDragged = null;
    wikiGraphCanvas.style.cursor = "grab";
    if (!wikiGraphDragDidMove) {
      var pos = wikiGraphGetCanvasPos(e);
      var idx = wikiGraphFindNodeAt(pos.x, pos.y);
      if (idx >= 0 && wikiGraphNodes[idx]) {
        var node = wikiGraphNodes[idx];
        wikiGraphFocused = idx;
        drawWikiGraph();
        if (typeof viewMemoryFile === "function") {
          viewMemoryFile(node.name || node.id);
        }
      }
    } else {
      // 拖拽结束，保存新位置
      saveGraphPositions();
    }
    e.preventDefault();
    return;
  }

  if (wikiGraphIsPanning) {
    wikiGraphIsPanning = false;
    wikiGraphCanvas.style.cursor = "grab";
    e.preventDefault();
    return;
  }
}

function onWikiGraphWheel(e) {
  e.preventDefault();
  var delta = e.deltaY > 0 ? 0.9 : 1.1;
  var newScale = wikiGraphScale * delta;
  // 缩放限制
  if (newScale < 0.1 || newScale > 5) return;
  wikiGraphScale = newScale;

  // 以鼠标位置为中心缩放
  var pos = wikiGraphGetCanvasPos(e);
  var worldBefore = wikiGraphScreenToWorld(pos.x, pos.y);
  wikiGraphScale = newScale;
  var worldAfter = wikiGraphScreenToWorld(pos.x, pos.y);
  wikiGraphOffsetX += (worldAfter.x - worldBefore.x) * wikiGraphScale;
  wikiGraphOffsetY += (worldAfter.y - worldBefore.y) * wikiGraphScale;

  updateWikiGraphZoomLabel();
  drawWikiGraph();
}

function onWikiGraphDoubleClick(e) {
  var pos = wikiGraphGetCanvasPos(e);
  var idx = wikiGraphFindNodeAt(pos.x, pos.y);
  if (idx >= 0) {
    wikiGraphFocused = idx;
    var node = wikiGraphNodes[idx];
    wikiGraphOffsetX = pos.x - node.x * wikiGraphScale;
    wikiGraphOffsetY = pos.y - node.y * wikiGraphScale;
    drawWikiGraph();
  } else {
    resetWikiGraphView();
  }
}

function resetWikiGraphView() {
  if (!wikiGraphCanvas) return;
  var w = wikiGraphCanvas._width || wikiGraphCanvas.width;
  var h = wikiGraphCanvas._height || wikiGraphCanvas.height;
  wikiGraphOffsetX = w / 2;
  wikiGraphOffsetY = h / 2;
  wikiGraphScale = Math.max(0.82, Math.min(1.08, Math.min(w, h) / 760));
  wikiGraphHovered = null;
  wikiGraphFocused = null;
  updateWikiGraphZoomLabel();
  drawWikiGraph();
}

// ─── 刷新接口（供外部调用）────────────────────────────────
function refreshWikiGraph() {
  var cwd = getCurrentCwdForGraph();
  fetchWikiGraphData(cwd);
}
